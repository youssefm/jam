// Flat ESLint config covering both halves of jam: the plain Node ESM backend
// (`src/*.ts`) and the Vite + React + TS frontend (`app/src`). Both halves run
// typescript-eslint's `strictTypeChecked` preset with `projectService`, matched to
// gloss/agenthub — the linter sees real types and catches floating promises, unsafe
// narrowing, dead conditions, and sloppy async. Config files are ignored: they
// live outside both tsconfig projects, so the type-checked rules can't type them.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import unusedImports from 'eslint-plugin-unused-imports';
import promise from 'eslint-plugin-promise';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'app/dist/**',
      'dist/**',
      'node_modules/**',
      '*.config.{js,ts,mjs,cjs}',
      'app/*.config.{js,ts,mjs,cjs}',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  // Shared type-checked baseline for every linted file. projectService resolves
  // each file to its own tsconfig (src/ -> tsconfig.json, app/src/ ->
  // app/tsconfig.json). Node globals are the default; the frontend block below
  // adds browser globals on top.
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    plugins: { 'unused-imports': unusedImports, promise },
    rules: {
      // Real-bug coverage from the type-checked rules.
      'promise/prefer-await-to-then': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/return-await': ['error', 'error-handling-correctness-only'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      // Non-null assertions after a length/range guard read cleaner than a
      // redundant re-check; noUncheckedIndexedAccess already forces the guard.
      '@typescript-eslint/no-non-null-assertion': 'off',

      'array-callback-return': ['error', { checkForEach: false }],
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unreachable-loop': 'error',
      'no-promise-executor-return': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',

      // strictTypeChecked extras that fight this codebase's style more than they
      // help (template interpolation of typed values; void-returning arrows).
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',

      // unused-imports owns unused detection — it auto-fixes dead imports and
      // honors the `_`-prefix hatch that the TS rule ignores.
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Frontend: React + browser globals. Both react plugins are registered
  // explicitly (rather than spread, which would clobber the plugin map) and their
  // recommended rule sets pulled in by `.rules`.
  {
    files: ['app/src/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    settings: { react: { version: '19.1' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      // The full react-hooks recommended set, minus the experimental
      // React-Compiler rules that flag this app's intentional patterns: the SSE
      // hook writes the latest `onState` closure to a ref during render (so the
      // stream effect doesn't reconnect every render), and the transcript uses
      // dangerouslySetInnerHTML for sanitized agent HTML. These assume
      // Compiler-style purity the architecture deliberately forgoes.
      ...reactHooks.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/use-memo': 'off',
      'react/prop-types': 'off',
      // Fires on plain functions destructured from context hooks — there's no
      // `this` to lose. Documented false-positive (as in gloss).
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
