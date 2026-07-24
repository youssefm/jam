// server.ts — one HTTP server per chat session, hosted by the `open` process. It
// serves the built React app, ships the boot transcript, holds the long-poll and
// SSE channels, and tears everything down when the session ends. There is no file
// to watch and a single implicit mode, so the whole thing is a flat set of routes
// — no review-mode seam and no watcher.
//
// startServer(session, opening?) -> Promise<{ port, url, close(), closed }>
//   session  the two-word session id (used for the tab <title>)
//   opening  an optional agent turn to seed the transcript with, so the chat
//            opens already showing the agent's first message (see cli.ts `open`)
//   port     the bound ephemeral port (127.0.0.1 only)
//   url      http://127.0.0.1:<port>/
//   close()  triggers teardown; resolves `closed`
//   closed   resolves once fully torn down, for ANY reason (browser /end or
//            close()), with { reason: 'end' | 'closed' | 'error' }
//
// Discovery files (~/.jam/sessions/*) are owned entirely by cli.ts — this
// module never touches them.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { createStore } from './store.ts';
import type { ReplyFormat } from './types.ts';

type CloseReason = 'end' | 'closed' | 'error';

interface ServerHandle {
  port: number;
  url: string;
  close: () => Promise<{ reason: CloseReason }>;
  closed: Promise<{ reason: CloseReason }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

// True when running inside a WSL VM. WSL sets WSL_DISTRO_NAME in the environment;
// we fall back to the kernel marker for shells that strip it.
function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// The built React app (Vite output) is served statically from here. `jam open`
// runs the packaged build, so there is no dev server in normal use.
const DIST_DIR = path.join(here, '..', 'app', 'dist');

const SSE_HEARTBEAT_MS = 25000;

export function startServer(session: string, opening?: { text: string; format: ReplyFormat }): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    let port: number;
    const store = createStore({
      onAgentReply: (entry) => broadcast('agent-reply', entry),
    });

    const sseClients = new Set<ServerResponse>();
    function broadcast(event: string, data: unknown) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of sseClients) res.write(frame);
    }

    // Seed the agent's opening turn (if any) before the browser connects, so the
    // chat opens already showing it. No SSE clients exist yet, so the broadcast is
    // a no-op — the browser picks it up from the /state boot snapshot.
    if (opening) store.addAgentReply(opening.text, opening.format);

    // Bake the session name into the served <title> so the tab reads right on
    // first paint, before the app boots. Mirrors the client's header title.
    const documentTitle = `${session} — jam`;

    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          await handle(req, res);
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { error: errorMessage(err) });
          else res.end();
        }
      })();
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const { pathname } = url;

      if (pathname === '/health') return sendJson(res, 200, { ok: true });

      // With no token, the only guard against a stray local page driving the
      // session is binding loopback (below) + rejecting odd Host headers.
      if (!hostAllowed(req)) return sendJson(res, 403, { error: 'forbidden host' });

      if (req.method === 'GET' && pathname === '/state') {
        return sendJson(res, 200, { mode: 'chat', chat: store.chat });
      }

      if (req.method === 'GET' && pathname === '/poll') {
        const { result, cancel } = store.poll();
        // Drop the parked waiter if the client vanishes (interrupt, restart,
        // sleep) so its slot doesn't swallow the next human message. `close` also
        // fires after a normal `res.end()` below, but by then the waiter is
        // settled and `cancel` is a harmless no-op.
        res.on('close', cancel);
        const item = await result;
        return sendJson(res, 200, item);
      }

      // Browser -> agent: a human message. Stamp + mirror it into the log, hand
      // it to the waiting poll, and echo the stamped entry so the sending tab's
      // optimistic bubble reconciles to the real monotonic id.
      if (req.method === 'POST' && pathname === '/feedback') {
        const body = parseJsonBody(await readBody(req));
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) return sendJson(res, 400, { error: 'empty message' });
        const entry = await store.addUserMessage(text);
        return sendJson(res, 200, { ok: true, entry });
      }

      // Agent -> browser: a reply, posted by `poll --html`/`--text` before it
      // long-polls. Reject an empty body or a reply after the session ended.
      if (req.method === 'POST' && pathname === '/agent-reply') {
        const body = parseJsonBody(await readBody(req));
        const text = typeof body.text === 'string' ? body.text : '';
        const format: ReplyFormat = body.format === 'html' ? 'html' : 'text';
        if (!text) return sendJson(res, 400, { error: 'empty reply' });
        if (store.isEnded()) return sendJson(res, 409, { error: 'session ended' });
        store.addAgentReply(text, format);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && pathname === '/end') {
        sendJson(res, 200, { ok: true });
        // Let the response (and any just-woken poll) flush before teardown.
        queueMicrotask(() => { void close('end'); });
        return undefined;
      }

      if (req.method === 'GET' && pathname === '/events') {
        return openEventStream(req, res);
      }

      // Everything else GET is the built app (index.html at /, hashed assets
      // under /assets). Unknown POSTs and missing files fall through to 404.
      if (req.method === 'GET') return serveStatic(res, pathname, documentTitle);

      return sendJson(res, 404, { error: 'not found' });
    }

    function openEventStream(req: IncomingMessage, res: ServerResponse) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      sseClients.add(res);
      // No boot-gap reconcile push here: the client refetches /state on every SSE
      // (re)connect and reconciles by id, so the snapshot — not the stream — is
      // authoritative. The only server->browser push is `agent-reply`.
      const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
    }

    function hostAllowed(req: IncomingMessage): boolean {
      const host = req.headers.host;
      return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    }

    // --- teardown ------------------------------------------------------------

    let resolveClosed!: (value: { reason: CloseReason }) => void;
    const closed = new Promise<{ reason: CloseReason }>((r) => { resolveClosed = r; });
    let closing = false;
    let listening = false;

    function close(reason: CloseReason = 'closed') {
      if (closing) return closed;
      closing = true;
      void store.end(); // wake any parked poll with { status: 'ended' }
      for (const res of sseClients) res.end();
      sseClients.clear();
      server.close(() => resolveClosed({ reason }));
      // A just-woken parked poll flushes its `ended` response on the next
      // microtask, turning its socket idle (keep-alive). Force all remaining
      // sockets closed on the following tick — after that flush — so
      // server.close resolves promptly instead of waiting on a keep-alive
      // timeout.
      setImmediate(() => server.closeAllConnections());
      return closed;
    }

    server.on('error', (err) => {
      if (closing) return;
      if (listening) void close('error');
      else reject(err);
    });

    // Under WSL the chat server lives in the WSL VM but the browser tab that
    // loads it runs on the Windows host, where `127.0.0.1` is a different
    // loopback. WSL2's localhost relay forwards Windows `localhost` to WSL
    // listeners reliably only when they bind all interfaces, not loopback-only —
    // so bind `0.0.0.0` there. The advertised URL stays `127.0.0.1`: the Windows
    // browser hits its own loopback and the relay carries it across. The
    // host-header guard already accepts `localhost`/`127.0.0.1`.
    const bindHost = isWsl() ? '0.0.0.0' : '127.0.0.1';
    server.listen(0, bindHost, () => {
      listening = true;
      const { port: bound } = server.address() as AddressInfo;
      port = bound;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () => close('closed'),
        closed,
      });
    });
  });
}

// --- helpers -----------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

// A thrown value's message, falling back to its string form (catch clauses are
// `unknown`).
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The session name can contain only [a-z-], but escape before splicing into
// <title> anyway — the sanitizer stays honest regardless of the input's shape.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Serve a file from the built app. `/` maps to index.html; hashed assets under
// /assets are immutable. The path is confined to DIST_DIR (no traversal), and a
// missing file is a plain 404 — jam has a single view, so there's no SPA
// catch-all to fall back to.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(res: ServerResponse, pathname: string, documentTitle: string): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(DIST_DIR, rel);
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  let body;
  try {
    body = await readFile(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  // The built index.html ships a static "jam" <title>; swap in the session's so
  // the tab reads correctly on first paint (see documentTitle above).
  if (rel === 'index.html') {
    body = Buffer.from(
      body.toString('utf8').replace('<title>jam</title>', `<title>${escapeHtml(documentTitle)}</title>`),
    );
  }
  const type = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
  const cacheControl = rel.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 4_000_000) { // ~4MB cap (rich HTML replies can be large)
        req.destroy();
        settle(() => reject(new Error('request body too large')));
      }
    });
    req.on('end', () => settle(() => resolve(data)));
    req.on('error', (err) => settle(() => reject(err)));
    // `destroy()` (and any mid-request disconnect) emits `close`, not `error`, so
    // reject here too — without it a capped or aborted body never settles and the
    // awaiting route handler leaks. A normal request has already resolved on
    // `end`, so the `settled` guard makes this a no-op.
    req.on('close', () => settle(() => reject(new Error('request connection closed'))));
  });
}

function parseJsonBody(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
