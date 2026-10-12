import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import svelteConfig from './svelte.config.js';

export default ts.config(
  { ignores: ['dist/', 'node_modules/', 'src-tauri/', 'coverage/', 'design/', 'src/lib/ui/icons/sprite.ts'] },
  js.configs.recommended,
  ...ts.configs.strict,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    // __APP_VERSION__ setzt Vite beim Bauen ein (vite.config.ts → define).
    languageOptions: { globals: { ...globals.browser, ...globals.node, __APP_VERSION__: 'readonly' } },
    rules: {
      // Schichtregel: nur die Kompositionswurzel darf die Infrastruktur kennen.
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/infrastructure/*'], message: 'Infrastruktur nur in App.svelte importieren.' }] },
      ],
      complexity: ['error', 12],
      'max-depth': ['error', 3],
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Datenquellen halten bis zu Millionen Einträge bewusst in normalen Map/Set/Array
      // und melden Änderungen über einen $state-Versionszähler (siehe CONTRIBUTING.md).
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { projectService: true, extraFileExtensions: ['.svelte'], parser: ts.parser, svelteConfig },
    },
  },
  {
    // In Tests sind Non-null-Assertions auf bekannte Testdaten üblich und lesbarer.
    files: ['**/*.test.ts', 'src/test/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // Kompositionswurzel und Tests dürfen Infrastruktur verwenden.
    files: ['src/App.svelte', '**/*.test.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
