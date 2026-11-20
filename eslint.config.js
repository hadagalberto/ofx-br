import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: dirname(fileURLToPath(import.meta.url)),
      },
    },
    rules: {
      // Warning messages embed counts and offsets; plain numbers are intended.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Core modules must stay runtime-agnostic (browser-safe): Node-only I/O
    // belongs in src/node/** and the CLI entry (see SPEC.md).
    files: ['src/**'],
    ignores: ['src/node/**', 'src/cli.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'fs/promises', 'path', 'os', 'process', 'util'],
              message: 'No Node APIs in the core; Node-only I/O lives in src/node/** or the CLI.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tests legitimately simulate hostile I/O (filesystems that throw strings).
    files: ['test/**'],
    rules: {
      '@typescript-eslint/only-throw-error': 'off',
    },
  },
  eslintConfigPrettier,
);
