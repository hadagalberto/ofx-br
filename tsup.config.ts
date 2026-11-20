import { defineConfig, type Options } from 'tsup';

/**
 * Build definitions, exported so the Vitest `globalSetup` can build the exact
 * shippable artifacts through the tsup API instead of spawning npm. There is
 * one source of truth for `npm run build`, CI and the spawned-CLI tests.
 */
export const libraryBuild: Options = {
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  outDir: 'dist',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  platform: 'node',
};

export const cliBuild: Options = {
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  dts: true,
  clean: false,
  sourcemap: true,
  target: 'es2022',
  outDir: 'dist',
  platform: 'node',
};

export default defineConfig([libraryBuild, cliBuild]);
