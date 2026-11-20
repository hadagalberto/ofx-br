/**
 * Vitest global setup: build the shippable artifacts once through the tsup API.
 *
 * Regression guard for the spawned-CLI suite: the old `beforeAll` derived an
 * npm entry point from `process.execPath`
 * (`<node dir>/node_modules/npm/bin/npm-cli.js`), which does not exist in
 * hosted toolcache Node installations. Building here means the tests only ever
 * need to spawn `node dist/cli.js`, on ubuntu/windows/macos and Node 20/22/24.
 */
import { build } from 'tsup';
import { cliBuild, libraryBuild } from '../tsup.config.js';

export default async function setup(): Promise<void> {
  // Same order as `npm run build`: the library build cleans `dist`, then the
  // CLI build adds to it (clean: false), so both artifacts coexist.
  // `config: false` keeps tsup from loading tsup.config.ts a second time —
  // the exported options are already the parsed config.
  await build({ ...libraryBuild, config: false });
  await build({ ...cliBuild, config: false });
}
