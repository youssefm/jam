/// <reference types="vite/client" />

// The @fontsource-variable/* packages resolve to a CSS entry with no type
// declarations, so a bare side-effect import (main.tsx) needs an ambient module
// to satisfy tsc. Vite resolves the real CSS at build time.
declare module '@fontsource-variable/*';
