# jam

Local, single-user CLI for talking to an agent *in a browser*, where the agent's
replies render as **rich, typeset HTML** instead of flat terminal markdown. The
agent runs `jam open`; jam opens a browser tab with a scrolling transcript;
the human types, each message reaches the agent via `jam poll`, and the agent
replies with an HTML fragment (or plain text) that renders full-width. There is
no document to review — the conversation is the artifact.

This repo ships two things that travel together: the CLI (`src/`, bundled to
`dist/cli.mjs`) and the installable skill (`skills/jam/SKILL.md`) that teaches an
agent to drive it. It's published to npm as **`jam-skill`** and installed as a
skill with `npx skills add youssefm/jam --skill jam`; the skill invokes the CLI on
demand via `npx -y jam-skill`.

## Commands

- `npm run build` — builds both halves: `build:app` (`vite build app` → `app/dist`,
  the served frontend) and `build:cli` (esbuild bundles `src/cli.ts` → `dist/cli.mjs`,
  the published entrypoint). **Required before `open` works**: the server serves
  `app/dist`, so a stale or missing build 404s on `/`.
- `npm run typecheck` — `tsc` over both projects: the backend (`tsconfig.json`,
  strict over `src/*.ts`) and the frontend (`app/tsconfig.json`).
- `npm run lint` / `lint:fix` — `eslint .` (flat config in `eslint.config.mjs`).
- `npm run test` / `test:watch` — `vitest` over `src/**/*.test.ts` and
  `app/src/**/*.test.ts`.
- `npm run check` — typecheck + lint + test + build, in that order.
- `npm run dev` — `vite app`. Rarely used; the tool runs the packaged build.
- `npm start` — `node dist/cli.mjs` (run the built CLI). During development you can
  also run the source directly on Node ≥ 22.18 — `node src/cli.ts open` /
  `node src/cli.ts poll <session>` — via Node's TypeScript type stripping, with no
  build of the backend.

The codebase documents itself with header comments. The typecheck bar is fully
strict TS; ESLint runs `strictTypeChecked` with `projectService` so the linter sees
real types and catches floating promises, unsafe narrowing, dead conditions, and
sloppy async.

## Packaging

- **Published as `jam-skill`** (unscoped). `bin` → `dist/cli.mjs`. The `files`
  allowlist ships `dist`, `app/dist`, `skills/jam`, `LICENSE`, and `README.md` — the
  TypeScript source is *not* published.
- **Zero runtime dependencies.** The backend uses only Node built-ins; every entry
  in `dependencies`… there are none. React, DOMPurify, highlight.js, KaTeX, and the
  fonts are all `devDependencies` — they get bundled into `app/dist` at build time,
  so `npx -y jam-skill` installs nothing transitive.
- **`prepare` / `prepack`** run `npm run build`, so a local install and every
  `npm pack` / publish regenerate `dist/` and `app/dist` from source.
- **The CLI is a plain-JS esbuild bundle** (`dist/cli.mjs`, ESM, `node18` target)
  rather than shipped `.ts`, so it runs on Node ≥ 18 with no type-stripping and no
  experimental warnings. esbuild consumes the `.ts` sources (including the `.ts`
  import specifiers) directly, so no source changes are needed to build it.

## Architecture

**Two-process model.** `jam open` *is* the server — it mints a two-word session
id, starts an HTTP server on an ephemeral loopback port, prints one JSON line
`{ session, url }` on stdout, opens the browser, and blocks. With a `--html` /
`--text` flag it first reads an opening agent message from **stdin** and seeds it
as the transcript's first turn, so the chat opens already showing it. `jam poll
<session>` is a separate short-lived process that finds the running server via a
discovery file and long-polls for the next human message; with a `--html` /
`--text` flag it first reads the agent's reply from **stdin** and POSTs it, so one
command posts-and-waits per turn.

**Discovery files** at `~/.jam/sessions/<key>.json` map a session id to
`{ pid, port, mode: 'chat', target: session }`, keyed by `sha256("chat:" + session)`.
Owned entirely by `cli.ts` (the server never touches them); written atomically.
Each `open` mints a *fresh* id no live server holds (`mintFreshSessionId` re-draws
past a live `/health` responder), so there is no takeover and `open` never signals
another process. Crash leftovers (a hard kill can't run the graceful cleanup) are
swept at the next `open` by `reapStaleSessions`, keyed on pid-liveness so a live
session is never reaped. There is no "end" verb — the chat ends browser-side (the
**End chat** button POSTs `/end`) and surfaces as `poll` returning
`{ status: 'ended' }`. (Accepted residual: two `open`s that draw the *same* random
id in the same instant both survive — last-writer-wins the file, the other is
orphaned — since nothing is signalled to converge them. Same astronomically-small
odds the random-id scheme already rests on; a mild leak, not data loss.)

### Backend (`src/*.ts`, Node ESM)

- `cli.ts` — the agent's entire surface (`open` / `poll`). Owns discovery files,
  browser-opening (with an optional embedded-browser host detected via the
  `AGENTHUB_*` env vars), collision-avoiding mint + crash-leftover reaping, and
  reading the reply (or `open`'s optional opening message) from stdin. **Zero npm
  deps** (node built-ins only); keeps stdout clean (one JSON line for `open`, one
  envelope per `poll`, everything else to stderr).
- `server.ts` — one HTTP server per chat. A flat set of routes (`/state`, `/poll`,
  `/feedback`, `/agent-reply`, `/end`, `/events` SSE, static serving) plus
  teardown. Single implicit chat mode; the only server→browser push is the
  `agent-reply` SSE event.
- `store.ts` — in-memory session state: the chat log, the ended flag, and a
  one-deep long-poll handoff (a single `pending` slot, not a FIFO queue — the
  composer gate caps in-flight human messages at one). Dies with the process.
- `words.ts` — the two-word session-id vocabulary and `mintSessionId()`.
- `types.ts` — the chat wire contract (`ChatEntry`, `PollResult`, `ChatState`),
  mirrored on the client in `app/src/state.ts`.

### Frontend (`app/`, Vite + React 19 + TypeScript)

- `app/src/state.ts` — the typed `/state` + POST helpers. **Read this first** for
  the client/server boundary. `Turn` is the render superset of the wire
  `ChatEntry` (adds the optimistic `you` echo and a client-only `error` notice).
- `app/src/chat.ts` — the chat state machine: transcript, agent-busy gate, ended
  state, and the SSE stream. Queueless (the composer disables while busy), with an
  optimistic user echo that reconciles to the server-stamped `id`. On every SSE
  (re)connect it refetches `/state` and reconciles by `id` — the snapshot is
  authoritative, closing the reply-loss window.
- `app/src/App.tsx` — the shell: header (session name + End chat), `Transcript`,
  `Composer`, ended banner.
- `app/src/Transcript.tsx` — the scrolling conversation and autoscroll (pin-to-bottom
  with a `ResizeObserver` re-pin for late agent-HTML height changes; scrolling up
  unpins and the view stops following). Renders each turn; agent HTML goes through
  `sanitize.ts`, then a per-turn `useLayoutEffect` runs `highlight.ts` and
  `math.ts` over its code blocks and math elements once on mount.
- `app/src/highlight.ts` — client-side syntax highlighting. highlight.js *core*
  ships in the main bundle; each grammar is a lazy `import()` that Vite code-splits
  into its own chunk, loaded only the first time a chat uses that language (an
  unused grammar costs nothing). Highlights each **tagged** `<pre><code>` in a
  freshly-injected turn, keyed on its `language-xxx` class; an untagged block is
  left plain (no auto-detect — a missing class means preformatted non-code).
  Tokenizing lives here, off the model and off the wire — the transcript
  stays plain source until the browser colors it.
- `app/src/math.ts` — client-side LaTeX (KaTeX). The agent tags math explicitly
  with `.jam-math` (inline) or `.jam-math-display` (block) and writes raw TeX as
  the element's text; this typesets each in place. Unlike highlight.js, *nothing*
  ships in the main bundle — KaTeX, its CSS, and its fonts all sit behind one lazy
  `import()`, so a math-free chat costs zero bytes. The empty-set early return (a
  turn with no `.jam-math`) is the zero-cost path: one `querySelectorAll`, no chunk
  fetch.
- `app/src/Composer.tsx` — the autosizing textarea + send (Enter sends,
  Shift+Enter newline).
- `app/src/sanitize.ts` — DOMPurify wrapper: strips script/handlers/`javascript:`,
  keeps inline `style`, neutralizes `position: fixed`/`sticky`.
- `app/src/{agentHub,platform}.ts` — the optional embedded-browser host signals
  (`window.agentHub` tab-state; no-op in a plain browser) and the mac/not-mac split
  for the End-chat hint.
- `app/src/styles/` — `design-language.css` (tokens + `.jam-*` component classes,
  the shared design system), `theme.css` (the `.md-content` prose theme, serif
  body), `chrome.css` (the app shell). Self-hosted variable fonts (Source Serif 4
  / Inter / JetBrains Mono) are imported in `main.tsx` and bundled by Vite.

## The design language

The heart of the tool: agent replies compose against a small documented
vocabulary of tokens (`--jam-*`) and component classes (`.jam-card`, `.jam-callout`,
`.jam-grid`, `.jam-metric`, `.jam-badge`, `.jam-divider`) rather than freehanding CSS,
so turns look coherent. The CSS in `design-language.css` is the single source of
truth; `skills/jam/SKILL.md` is how that vocabulary reaches the model. The component
classes are deliberately **not** scoped under `.md-content` so a bare class wins
over the zero-specificity prose defaults inside an injected turn.

## Gotchas

- **Agent HTML is injected via `dangerouslySetInnerHTML`** after DOMPurify. Turns
  are immutable and append-only, so React owns the transcript outright — no
  imperative DOM morphing, and StrictMode is safe.
- **Sanitization is hygiene, not a sandbox.** CSS is intentionally not locked
  down (arbitrary `style`, gradients, layout are what make a turn look good); the
  lone guard beyond DOMPurify's defaults is neutralizing `position:
  fixed`/`sticky` so a turn can't cover the composer. The threat model is
  personal, single-user, loopback-bound.
- **The `Host` guard isn't authentication**, and under WSL the server binds
  `0.0.0.0` (the localhost relay needs it) — both accepted for a personal,
  loopback-bound tool.
