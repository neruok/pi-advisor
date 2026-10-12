import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CC-AC-1 declares the common behavior library without bundling host SDKs', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies?.['@neruok/pi-common'], 'the shared behavior library must be a declared dependency');
  for (const name of Object.keys(pkg.peerDependencies)) assert.equal(pkg.dependencies?.[name], undefined);
});
