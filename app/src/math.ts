// math.ts — client-side LaTeX for agent turns. The agent tags math explicitly,
// exactly as it tags code: raw TeX as the element's text, inside `.jam-math`
// (inline) or `.jam-math-display` (a centered block). After the turn's HTML is
// injected we typeset each tagged element in place with KaTeX, keyed on that
// class. This keeps the TeX off the wire (the transcript stays plain source
// until the browser typesets it) and, like highlight.ts, means the model just
// names what it already knows rather than emitting rendered markup.
//
// KaTeX loads *lazily and whole*: unlike highlight.js (whose core ships in the
// main bundle), nothing here touches the main bundle — the library, its CSS, and
// its woff2 fonts all sit behind the dynamic `import()` below, so a chat with no
// math costs zero bytes.
//
// The raw TeX is the tagged element's text, so it would paint as plain source —
// "looks like text, then jumps to an equation" — in the gap before KaTeX renders.
// Two things close that gap. Once the chunk is loaded (the common case: every math
// turn after the first, and *every* turn on a reload, which preloads — see
// `preloadMath`) we typeset *synchronously* inside the caller's layout effect,
// before the browser paints, so the raw TeX never shows and nothing shifts. The one
// time the chunk is still loading — the first math turn to arrive in a session that
// didn't open with any — we hold the whole turn hidden (`.jam-math-loading`, see
// theme.css) and fade it in once typeset, so the reply appears fully-formed instead
// of flashing raw TeX or popping an equation into place.

import type katexNamespace from 'katex';

type Katex = typeof katexNamespace;

// The first math turn pays for the chunk; every later turn reuses this promise,
// so we import (and register the CSS) exactly once per session. Pulling the CSS
// in here — not in main.tsx — is what keeps it in the lazy chunk. Once it
// resolves we also stash the module in `katex` for the synchronous fast path.
let katex: Katex | null = null;
let katexPromise: Promise<Katex> | null = null;
async function loadKatex(): Promise<Katex> {
  katexPromise ??= (async () => {
    try {
      const [mod] = await Promise.all([
        import('katex'),
        import('katex/dist/katex.min.css'),
      ]);
      katex = mod.default;
      return katex;
    } catch (error) {
      // A rejected promise would poison the cache — every later math turn would
      // reuse it and stay hidden. Null it so a fetch hiccup on the first math turn
      // doesn't brick math for the rest of the session; a later turn retries.
      katexPromise = null;
      throw error;
    }
  })();
  return katexPromise;
}

// Elements we've already typeset (or are mid-flight on). Claimed synchronously
// before the first await, so React StrictMode's double-invoked mount effect can't
// typeset the same element twice.
const rendered = new WeakSet<Element>();

// Typeset one tagged element: read its raw TeX, then let KaTeX replace its
// contents in place. `throwOnError: false` renders a malformed expression as red
// error text instead of throwing, so one bad formula can't break the turn — which
// means the catch below is only reached on an unexpected failure; we leave that
// element as its raw TeX (readable) and keep going so one bad node can't take out
// the rest of the turn.
function renderElement(katexModule: Katex, el: HTMLElement): void {
  if (rendered.has(el)) return;
  rendered.add(el);
  const tex = el.textContent;
  try {
    katexModule.render(tex, el, {
      displayMode: el.classList.contains('jam-math-display'),
      throwOnError: false,
    });
  } catch (error) {
    console.warn('jam: could not render a math element', error);
  }
}

// Does this HTML carry math? Lives here, next to the selector it mirrors, so a
// rename shows up as two adjacent lines to fix rather than a silent drift across
// files — nothing *enforces* the two agree. Deliberately a loose substring rather
// than a `class="…"` match: both tags share this prefix, and it stays right
// whatever the quoting or class order. A false positive costs one chunk fetch; a
// false negative costs the layout shift this exists to prevent, so loose is the
// direction to err in.
export function containsMath(html: string): boolean {
  return html.includes('jam-math');
}

// Warm the KaTeX chunk *before* the first render, so the turns already in the
// transcript take the synchronous path above and their equations are at final
// size in the very first layout. This is what keeps a reload motionless: the
// held-and-faded path below reserves the *raw TeX* height, not the typeset one, so
// letting a restored transcript take it would resize turns after mount and drag
// the pinned-to-bottom view with them.
//
// Bounded, because boot blocks first paint on it — unlike the `/state` fetch,
// which is unbounded because there is simply no chat to draw without it. This is
// an optimization, so it gets to give up. The bound is not a pure safety margin:
// at 300ms against a ~20ms measured cold load it has an order of magnitude of
// headroom, but if it *does* fire the user pays the blank wait and still gets the
// shift, since the turns fall back to the lazy hold-and-fade path (sharing this
// same in-flight promise). It's capped there because a blank screen is the worse
// of the two failures past about a fifth of a second.
const PRELOAD_TIMEOUT_MS = 300;

export async function preloadMath(): Promise<void> {
  try {
    await Promise.race([
      loadKatex(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, PRELOAD_TIMEOUT_MS);
      }),
    ]);
  } catch {
    /* the per-turn lazy path retries and degrades to raw TeX */
  }
}

// Typeset every tagged element in a freshly-injected turn. The empty-set early
// return is the zero-cost path: a turn with no math does one `querySelectorAll`
// and never fetches the KaTeX chunk.
//
// Called from a layout effect (before paint). When KaTeX is already loaded — the
// common case: every math turn after the first — we typeset inline and
// synchronously, so the raw TeX never paints and the equation lands at its final
// size: no flash, no shift.
//
// The one time the chunk is still loading — the first math element of the session
// — we hold the *whole turn* hidden (`.jam-math-loading`, see theme.css), typeset
// once the chunk arrives, then reveal it with a short fade. So rather than raw TeX
// showing or an equation popping into an already-visible turn, the reply simply
// appears a beat later, fully typeset. This runs before the turn's first paint, so
// nothing renders in between.
export function renderMathWithin(root: HTMLElement): void {
  const nodes = root.querySelectorAll<HTMLElement>('.jam-math, .jam-math-display');
  if (nodes.length === 0) return;
  if (katex) {
    for (const el of nodes) renderElement(katex, el);
    return;
  }
  root.classList.add('jam-math-loading');
  void loadAndRender(root, nodes);
}

// The async first-load branch, split out so the exported entry point stays a
// synchronous layout-effect call: load the chunk, typeset the held turn's math,
// then reveal it. If the chunk fetch fails, the `finally` still reveals the turn —
// it falls back to showing raw TeX, which is at least readable, rather than leaving
// the whole reply stuck invisible. The catch keeps that failure from surfacing as
// an unhandled rejection at the fire-and-forget call site.
async function loadAndRender(root: HTMLElement, nodes: Iterable<HTMLElement>): Promise<void> {
  try {
    const katexModule = await loadKatex();
    for (const el of nodes) renderElement(katexModule, el);
  } catch (error) {
    console.warn('jam: could not load KaTeX', error);
  } finally {
    root.classList.remove('jam-math-loading');
  }
}
