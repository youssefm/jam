// sanitize.ts — DOMPurify wrapper for agent HTML turns. Sanitization is cheap
// hygiene, not the architecture: the agent is trusted, but its output can echo
// web-fetched text, so we strip `<script>`, `on*` handlers, and `javascript:`
// URLs (DOMPurify's defaults). CSS is deliberately NOT locked down — arbitrary
// inline `style`, gradients, and layout are what make a turn look good.
//
// The hook below neutralizes an inline `position: fixed`/`sticky` so a turn can't
// peel out of its box, but it's best-effort defense-in-depth, not the fence: it
// reads the specified inline value, so an indirection like `position: var(--p)`
// slips past it. The real guarantee is `contain: paint` on `.jam-turn` (chrome.css),
// which makes the turn the containing block for — and clips — any positioned
// descendant, fixed or not. So a stray `position: fixed` still can't cover the
// composer even when this hook misses it.

import DOMPurify from 'dompurify';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof HTMLElement)) return;
  const position = node.style.position;
  if (position === 'fixed' || position === 'sticky') {
    node.style.position = 'static';
  }
});

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}
