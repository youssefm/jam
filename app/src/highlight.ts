// highlight.ts — client-side syntax highlighting for agent code blocks. The
// agent tags real code with `<pre><code class="language-xxx">…`; after the turn's
// HTML is injected we tokenize each tagged block here, keyed on that class. This
// keeps the tokenizing off the model (it just names the language it already
// knows) and out of the wire — the transcript stays plain source until the
// browser colors it. An untagged `<pre><code>` is deliberately left alone: it's
// preformatted non-code (a log, a transcript, ASCII) that shouldn't be guessed
// at, so we don't auto-detect — a missing class means "render plain".
//
// Grammars load *lazily*: highlight.js core ships in the main bundle, but each
// language is a separate `import()` that Vite code-splits into its own chunk,
// fetched only the first time a chat actually uses that language. A grammar no
// chat touches never costs a byte. The price is a one-frame unstyled flash the
// first time a language appears while its chunk loads — negligible off local disk.

import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';

// Canonical language name -> a dynamic import of its grammar. Vite turns each
// `import()` into its own chunk and dedupes shared ones, so this map *is* the
// code-split boundary. Aliases (below) don't get their own entry — they resolve
// to a canonical name here.
const grammars: Record<string, () => Promise<{ default: LanguageFn }>> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  diff: () => import('highlight.js/lib/languages/diff'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  sql: () => import('highlight.js/lib/languages/sql'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'), // also HTML
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

// Common short forms the agent might write, mapped to the canonical grammar name.
// This does two jobs: pick the *chunk* to load, and (below) rewrite the block's
// class to the canonical `language-<name>` before highlighting. We can't lean on
// hljs's own alias table — some of these aren't declared by their grammar (e.g.
// `py`, `c++`), and hljs's class parser drops non-word characters, so a raw
// `language-c++` would resolve to `c`. Normalizing the class sidesteps both.
const aliases: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  html: 'xml',
};

// The `language-xxx` token on a `<pre><code>`, lowercased, or null if untagged.
function tokenOf(block: HTMLElement): string | null {
  for (const cls of block.classList) {
    if (cls.startsWith('language-')) return cls.slice('language-'.length).toLowerCase();
  }
  return null;
}

// Load + register a grammar by canonical name, if we haven't already. The
// post-await re-check absorbs a concurrent block that registered the same
// language first (Vite dedupes the underlying chunk fetch anyway).
async function ensureLanguage(name: string): Promise<void> {
  const load = grammars[name];
  if (!load || hljs.getLanguage(name)) return;
  const grammar = await load();
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, grammar.default);
}

// Blocks we've already highlighted (or are mid-flight on). Claimed synchronously
// before the first await, so React StrictMode's double-invoked mount effect can't
// double-process a block or trip hljs's "previously highlighted" warning.
const highlighted = new WeakSet<Element>();

// Highlight one `<pre><code>`: resolve its language, load the grammar, normalize
// the class to canonical so `highlightElement` resolves it, then tokenize in
// place. An untagged block is left plain (no auto-detect — see the file header);
// failures are isolated — a grammar chunk that won't load leaves this one block
// as plain source without touching its siblings or leaking a rejection.
async function highlightBlock(block: HTMLElement): Promise<void> {
  const token = tokenOf(block);
  if (!token) return; // untagged: preformatted non-code, render it plain
  if (highlighted.has(block)) return;
  highlighted.add(block);
  const name = aliases[token] ?? token;
  try {
    await ensureLanguage(name);
    // Unknown language (never registered): leave it as plain, escaped source
    // rather than let hljs log a "could not find language" warning.
    if (!hljs.getLanguage(name)) return;
    if (name !== token) {
      block.classList.remove(`language-${token}`);
      block.classList.add(`language-${name}`);
    }
    hljs.highlightElement(block);
  } catch (error) {
    highlighted.delete(block); // let a later pass retry
    console.warn('jam: could not highlight a code block', error);
  }
}

// Highlight every `<pre><code>` inside a freshly-injected turn. Per-block
// isolation means `Promise.all` never rejects, so the fire-and-forget caller
// (Transcript.tsx) needs no catch of its own.
export async function highlightWithin(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>('pre code');
  await Promise.all([...blocks].map((block) => highlightBlock(block)));
}
