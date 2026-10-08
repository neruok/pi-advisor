import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

// Exercise the shipped archive, not the source checkout. No provider calls or user settings.
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'pi-advisor-pack-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const output = execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--dry-run=false', '--pack-destination', dir], {
    cwd: root, encoding: 'utf8', timeout: 60000,
  });
  const report = JSON.parse(output);
  const packs = Array.isArray(report) ? report : Object.values(report);
  assert.equal(packs.length, 1, 'Expected one packed package');
  const [pack] = packs;
  const expected = ['package.json', 'advisor.ts', 'README.md', 'LICENSE', 'docs/pi-advisor.md',
    ...(await readdir(join(root, 'lib'))).filter(name => name.endsWith('.ts')).map(name => `lib/${name}`)];
  const allowed = new Set(expected);
  const paths = pack.files.map(file => file.path);
  for (const path of expected) assert.ok(paths.includes(path), `Missing shipped file: ${path}`);
  for (const path of paths) assert.ok(allowed.has(path), `Unexpected shipped file: ${path}`);
  execFileSync('tar', ['-xzf', join(dir, pack.filename), '-C', dir], { timeout: 10000 });
  const manifest = JSON.parse(await readFile(join(dir, 'package/package.json'), 'utf8'));
  assert.equal(manifest.name, '@neruok/pi-advisor');
  assert.equal(manifest.license, 'MIT');
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/');
  assert.match(await readFile(join(dir, 'package/LICENSE'), 'utf8'), /MIT License/);
  assert.deepEqual(manifest.pi.extensions, ['./advisor.ts']);
  assert.equal(manifest.dependencies, undefined, 'Runtime peers must remain host-provided');
  for (const peer of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(manifest.peerDependencies[peer], '*');
    assert.equal(manifest.peerDependenciesMeta[peer].optional, true);
  }
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [join(dir, 'package')],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], 'Packed extension must load without errors');
  assert.equal(result.extensions.length, 1);
  assert.deepEqual([...result.extensions[0].tools.keys()].sort(), ['advisor', 'advisor_close', 'advisor_sessions']);
  assert.deepEqual([...result.extensions[0].commands.keys()], ['advisor']);
  console.log(`Verified ${manifest.name}@${manifest.version}: ${paths.length} shipped files; one extension, three tools, one command.`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
