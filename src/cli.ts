#!/usr/bin/env node
// jam CLI — the agent's only surface onto a chat session.
//
// Verbs: `open` and `poll`. Nothing else (no end, no reply verb) — the reply is
// folded into `poll`, and ending is browser-driven, surfacing to the agent as
// `poll` returning status:ended.
//
//   jam                          alias for open
//   jam open [--html | --text]   mint a session id + host the server (blocks);
//                                  prints one JSON line { session, url }. With a
//                                  format flag, first reads an opening agent
//                                  message from stdin and seeds it as the first
//                                  turn, so the chat opens already showing it
//   jam poll <session> [--html | --text]
//                                  long-poll for the next human message; with a
//                                  format flag, first reads the reply from stdin
//                                  and POSTs it before polling
//
// `open` prints one machine-readable JSON line ({ session, url }) on stdout, then
// blocks. `poll` prints one JSON envelope per line. Errors go to stderr with a
// non-zero exit. cli.ts has zero npm deps — node built-ins only. The real server
// lives behind the ./server.ts seam.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { startServer } from './server.ts';
import { mintSessionId } from './words.ts';
import type { ReplyFormat } from './types.ts';

const SESSIONS_DIR = path.join(os.homedir(), '.jam', 'sessions');
const HEALTH_TIMEOUT_MS = 1000;

// A discovery entry: the owning process + port, plus the session it hosts (so
// `poll <session>` can resolve the key). Written atomically by cli.ts alone.
interface Discovery {
  pid: number;
  port: number;
  mode?: string;
  target?: string;
}

// --- discovery files (cli.ts owns these; the server never touches them) ------

// A session is keyed by its id under a `chat:` prefix. A chat has no natural
// target (no file path or repo root), so the minted id IS the key — two agents
// in one repo never collide.
function sessionKey(session: string): string {
  return createHash('sha256').update(`chat:${session}`).digest('hex');
}

function discoveryPath(key: string): string {
  return path.join(SESSIONS_DIR, `${key}.json`);
}

function readDiscovery(key: string): Discovery | null {
  try {
    const data: unknown = JSON.parse(readFileSync(discoveryPath(key), 'utf8'));
    if (
      data && typeof data === 'object'
      && 'pid' in data && typeof data.pid === 'number'
      && 'port' in data && typeof data.port === 'number'
    ) {
      return data as Discovery;
    }
    return null;
  } catch {
    return null;
  }
}

// Claim the session by writing our discovery entry, atomically replacing any
// prior one: write a temp file, then rename it over the real path. Rename is
// atomic on POSIX, so a concurrent reader never sees a half-written file and the
// latest writer wins.
function writeDiscovery(key: string, data: Discovery): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const finalPath = discoveryPath(key);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  const fd = openSync(tempPath, 'w');
  try {
    writeSync(fd, JSON.stringify(data));
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, finalPath);
}

// Remove the discovery file only if it's still ours. The ownership check guards
// the rare TOCTOU where a concurrent `open` re-minted our id and now owns the
// entry — we must not delete the file it holds.
function deleteDiscoveryIfOwned(key: string, { pid, port }: { pid: number; port: number }): void {
  const current = readDiscovery(key);
  if (current?.pid === pid && current.port === port) {
    try {
      rmSync(discoveryPath(key));
    } catch {
      // already gone — fine
    }
  }
}

// Is a process with this pid running? A kernel liveness probe (`kill(pid, 0)`):
// ESRCH means gone, EPERM means alive but not ours (still alive). Used ONLY to
// reap dead discovery entries — never to signal a process — so its one blind
// spot (a recycled pid reads "alive") is safe here: it makes us conservatively
// KEEP a stale file rather than risk deleting a live session's. The wrong-way
// error is a leftover JSON, not a killed process, so pid-liveness is the right
// signal for reaping even though it's the wrong one for a SIGTERM.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// The pid embedded in a `<key>.json.<pid>.tmp` leftover from an interrupted
// writeDiscovery, or null if the name doesn't match.
function tempFileOwnerPid(name: string): number | null {
  const match = /\.(\d+)\.tmp$/.exec(name);
  return match ? Number(match[1]) : null;
}

// Sweep crash leftovers from the sessions dir. A graceful exit runs
// deleteDiscoveryIfOwned, but a hard kill / crash / power loss can't, so dead
// entries would otherwise accumulate forever (there is no other reaper) and
// their ids stay un-reusable. Reaping is keyed on pid-liveness (see isPidAlive),
// so a live session — even one whose /health briefly stalls — is never deleted.
// Best-effort: any unlink races a concurrent `open` harmlessly.
function reapStaleSessions(): void {
  let names: string[];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return; // dir not created yet — nothing to reap
  }
  for (const name of names) {
    const full = path.join(SESSIONS_DIR, name);
    if (name.endsWith('.tmp')) {
      // A temp file is only live during another process's synchronous write, so
      // reap one only if its owner pid is dead (or unparseable) — never yank a
      // live writer's temp out from under its rename.
      const pid = tempFileOwnerPid(name);
      if (pid === null || !isPidAlive(pid)) {
        try { rmSync(full); } catch { /* already gone */ }
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const disc = readDiscovery(name.slice(0, -'.json'.length));
    // Garbage/unreadable entry, or a dead owner: reap it. A live (or recycled)
    // pid is left alone.
    if (!disc || !isPidAlive(disc.pid)) {
      try { rmSync(full); } catch { /* already gone */ }
    }
  }
}

// --- HTTP client -------------------------------------------------------------

function request(
  method: string,
  port: number | string,
  pathname: string,
  { body, timeoutMs }: { body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${port}${pathname}`;
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      url,
      {
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function isLive(port: number): Promise<boolean> {
  try {
    const { status } = await request('GET', port, '/health', { timeoutMs: HEALTH_TIMEOUT_MS });
    return status === 200;
  } catch {
    return false;
  }
}

// Read the whole of stdin as UTF-8 — how a `poll --html`/`--text` reply arrives,
// keeping the (possibly large) HTML body off argv and the filesystem.
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- misc --------------------------------------------------------------------

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// Open the chat for the user. Inside an AgentHub host (an optional embedded-
// browser host jam detects via the AGENTHUB_* env vars), open it as an embedded
// browser tab by POSTing the host's hook receiver directly; otherwise fall back
// to the OS default browser. Best-effort throughout — if both paths fail, the URL
// is still on stdout.
async function openChat(url: string): Promise<void> {
  if (await spawnAgentHubBrowserTab(url)) return;
  openInDefaultBrowser(url);
}

// POST /spawn-browser to the local AgentHub host. Returns true if it accepted the
// request. The caller's terminal id and the receiver port come from the env the
// host injects into every terminal; absent that env, we're not in AgentHub.
async function spawnAgentHubBrowserTab(url: string): Promise<boolean> {
  const terminalId = process.env.AGENTHUB_TERMINAL_ID;
  const port = Number(process.env.AGENTHUB_HOOK_PORT);
  if (!terminalId || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const { status } = await request('POST', port, '/spawn-browser', {
      body: { parentTerminalId: terminalId, url, focus: true },
      timeoutMs: 2000,
    });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

// Open a URL in the user's default browser, detached so it outlives jam.
function openInDefaultBrowser(url: string): void {
  const [command, args, platformOptions] =
    process.platform === 'darwin' ? ['open', [url], {}] as const
    : process.platform === 'win32'
      // windowsVerbatimArguments: don't re-quote args, so `cmd`/`start` parse the
      // URL itself and a `&` in it can't split the command line.
      ? ['cmd', ['/c', 'start', '', url], { windowsVerbatimArguments: true }] as const
      : ['xdg-open', [url], {}] as const;
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, ...platformOptions });
    child.on('error', () => {}); // opener missing — the URL is on stdout
    child.unref();
  } catch {
    // give up silently — the URL is on stdout
  }
}

// --- open --------------------------------------------------------------------

// Mint a session id no *live* server already owns. Ids are random (words.ts), so
// a clash is astronomically unlikely — but checking up front is cheaper and far
// simpler than the alternative it replaces (stand up a server, then race to
// SIGTERM the loser). A candidate with no discovery file, or one whose owner is
// dead (no /health answer), is free to take; a live owner just sends us back for
// another draw. The /health probe runs only on the rare candidate that already
// has a file, and because we never kill anyone here, even a stray non-jam
// responder on that port costs nothing but one more draw.
async function mintFreshSessionId(): Promise<string> {
  for (;;) {
    const session = mintSessionId();
    const disc = readDiscovery(sessionKey(session));
    if (!disc || !(await isLive(disc.port))) return session;
  }
}

// Host a chat session. `open` IS the server process — it reaps crash leftovers,
// mints a fresh session id, starts a server, claims it, and blocks until the chat
// ends. With a format flag it first reads an opening agent message from stdin and
// seeds it as the first turn, so the chat opens already showing the agent's
// message.
//
// There is no takeover: ids are random and live collisions are avoided at mint
// time (mintFreshSessionId), so `open` never signals another process — it just
// stands up its own server on a free id.
async function open({ format }: { format?: ReplyFormat } = {}): Promise<number> {
  // With a format flag, seed an opening agent turn: read it from stdin (keeping
  // the possibly-large HTML body off argv) and reject an empty body.
  let opening: { text: string; format: ReplyFormat } | undefined;
  if (format) {
    const text = await readStdin();
    if (!text.trim()) {
      process.stderr.write('jam: empty opening message on stdin; pipe the message body in\n');
      return 1;
    }
    opening = { text, format };
  }

  // Sweep crash leftovers (a hard kill can't run the cleanup below), then mint an
  // id no live server holds. Both happen before we create anything, so a signal
  // here leaks nothing — no discovery file exists yet.
  reapStaleSessions();
  const session = await mintFreshSessionId();
  const key = sessionKey(session);

  const server = await startServer(session, opening);
  const owner: Discovery = { pid: process.pid, port: server.port, mode: 'chat', target: session };

  // Claim the session so `poll <session>` can find our server.
  writeDiscovery(key, owner);

  // The skill captures both fields: it shares `url` with the user and passes
  // `session` to every `poll`.
  emit({ session, url: server.url });

  // Register teardown handlers. No `await` runs between the claim above and here,
  // so a signal can't slip in before they're registered — it tears down
  // gracefully (running deleteDiscoveryIfOwned) instead of hitting the default
  // terminate and orphaning the discovery file.
  const onSignal = () => { void server.close(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Open the chat for the user — an embedded AgentHub tab, else the OS default
  // browser (best-effort); the URL is on stdout regardless.
  void openChat(server.url);

  const { reason } = await server.closed;
  deleteDiscoveryIfOwned(key, owner);
  process.stderr.write(`jam: chat ended (${reason})\n`);
  return reason === 'error' ? 1 : 0;
}

// --- poll --------------------------------------------------------------------

async function poll(session: string, { format }: { format?: 'html' | 'text' } = {}): Promise<number> {
  const key = sessionKey(session);
  const disc = readDiscovery(key);
  if (!disc || !(await isLive(disc.port))) {
    process.stderr.write(`jam: no live session '${session}'; run \`jam open\` first\n`);
    return 1;
  }

  // With a format flag, this poll carries the agent's reply: read it from stdin,
  // reject an empty body, and POST it before long-polling for the next message.
  if (format) {
    const text = await readStdin();
    if (!text.trim()) {
      process.stderr.write('jam: empty reply on stdin; pipe the reply body in\n');
      return 1;
    }
    const { status } = await request('POST', disc.port, '/agent-reply', { body: { text, format } });
    // The human ended the chat while this reply was being composed: the reply is
    // moot, and the loop must learn the session is over. Emit the same `ended`
    // envelope a parked poll would, so the skill stops cleanly on one command.
    if (status === 409) {
      emit({ status: 'ended' });
      return 0;
    }
    if (status < 200 || status >= 300) {
      process.stderr.write(`jam: reply failed (HTTP ${status})\n`);
      return 1;
    }
  }

  // Long-poll with no client timeout: it stays open until the human sends a
  // message or ends the session.
  const { status, body } = await request('GET', disc.port, '/poll');
  if (status !== 200) {
    process.stderr.write(`jam: poll failed (HTTP ${status})\n`);
    return 1;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    process.stderr.write('jam: poll returned a malformed response\n');
    return 1;
  }
  emit(envelope);
  return 0;
}

// --- arg parsing + dispatch --------------------------------------------------

const USAGE = `usage:
  jam                          alias for open
  jam open [--html | --text]   mint a session + host the chat server (run in the background); prints { session, url }. A format flag first seeds an opening agent message from stdin
  jam poll <session> [--html | --text]   poll for the next human message; a format flag first posts the reply from stdin`;

// The outcome of parsing argv: either an error to report, or a resolved command.
interface ParsedArgs {
  command?: 'open' | 'poll';
  session?: string;
  options?: { format?: 'html' | 'text' };
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  let command: 'open' | 'poll';
  let tail: string[];
  if (first === 'open' || first === 'poll') {
    command = first;
    tail = rest;
  } else {
    command = 'open';
    tail = argv;
  }

  // Flags: `--html`/`--text` (mutually exclusive) carry a format for both verbs —
  // for `poll` the reply, for `open` an opening agent message. Both read the body
  // from stdin.
  const options: { format?: 'html' | 'text' } = {};
  const positionals: string[] = [];
  for (const arg of tail) {
    if (arg === '--html' || arg === '--text') {
      const next = arg === '--html' ? 'html' : 'text';
      if (options.format && options.format !== next) return { error: 'pass only one of --html / --text' };
      options.format = next;
    } else if (arg.startsWith('-')) {
      return { error: `unknown option for ${command}: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }
  if (command === 'open' && positionals.length > 0) return { error: 'open takes no arguments' };
  if (positionals.length > 1) return { error: `unexpected argument: ${positionals[1]}` };

  const parsed: ParsedArgs = { command, options };
  if (positionals[0] !== undefined) parsed.session = positionals[0];
  return parsed;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`jam: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const { command, session, options } = parsed;

  if (command === 'poll') {
    if (!session) {
      process.stderr.write(`jam: poll needs a session id\n${USAGE}\n`);
      return 2;
    }
    return poll(session, options);
  }

  return open(options);
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`jam: ${message}\n`);
    process.exitCode = 1;
  });
