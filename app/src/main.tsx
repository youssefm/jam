// main.tsx — boot. Load the self-hosted variable fonts and the stylesheets, fetch
// the initial transcript snapshot, then mount the chat. StrictMode is safe here:
// turns are immutable and append-only (no imperative DOM morphing), so a
// double-invoked render has nothing to corrupt.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted variable fonts (bundled as .woff2 by Vite, served by the static
// route) — offline, no network fonts. The @font-face families these register are
// referenced by the --jam-font-* tokens in design-language.css.
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

import './styles/theme.css';
import './styles/design-language.css';
import './styles/chrome.css';

import { App } from './App';
import { fetchState } from './state';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
const root = createRoot(container);

fetchState()
  .then((state) =>
    root.render(
      <StrictMode>
        <App state={state} />
      </StrictMode>,
    ),
  )
  .catch((err: unknown) => {
    container.textContent = `jam: couldn't load the chat (${err instanceof Error ? err.message : String(err)})`;
  });
