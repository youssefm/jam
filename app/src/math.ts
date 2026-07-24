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
// math costs zero bytes. The price is a one-frame unstyled flash the first time
// math appears while the chunk loads — negligible off local disk.

import type katexNamespace from 'katex';

type Katex = typeof katexNamespace;

// The first math turn pays for the chunk; every later turn reuses this promise,
// so we import (and register the CSS) exactly once per session. Pulling the CSS
// in here — not in main.tsx — is what keeps it in the lazy chunk.
let katexPromise: Promise<Katex> | null = null;
async function loadKatex(): Promise<Katex> {
  katexPromise ??= (async () => {
    const [mod] = await Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]);
    return mod.default;
  })();
  return katexPromise;
}

// Elements we've already typeset (or are mid-flight on). Claimed synchronously
// before the first await, so React StrictMode's double-invoked mount effect can't
// typeset the same element twice.
const rendered = new WeakSet<Element>();

// Typeset one tagged element: read its raw TeX, then let KaTeX replace its
// contents in place. `throwOnError: false` renders a malformed expression as red
// error text instead of throwing, so one bad formula can't break the turn.
function renderElement(katex: Katex, el: HTMLElement): void {
  if (rendered.has(el)) return;
  rendered.add(el);
  const tex = el.textContent;
  try {
    katex.render(tex, el, {
      displayMode: el.classList.contains('jam-math-display'),
      throwOnError: false,
    });
  } catch (error) {
    rendered.delete(el); // let a later pass retry
    console.warn('jam: could not render a math element', error);
  }
}

// Typeset every tagged element in a freshly-injected turn. The empty-set early
// return is the zero-cost path: a turn with no math does one `querySelectorAll`
// and never fetches the KaTeX chunk.
export async function renderMathWithin(root: HTMLElement): Promise<void> {
  const nodes = root.querySelectorAll<HTMLElement>('.jam-math, .jam-math-display');
  if (nodes.length === 0) return;
  const katex = await loadKatex();
  for (const el of nodes) renderElement(katex, el);
}
