import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

// AC-9 AC-33 AC-35 AC-36 AC-38: exercise the shipped archive, not the source checkout.
// No provider calls or user settings.
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
    'skills/socratic-reasoning/SKILL.md', 'skills/adversarial-review/SKILL.md',
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
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  assert.deepEqual(Object.keys(manifest.dependencies), ['@neruok/pi-common'], 'CC-AC-1: host SDKs must remain peers');
  for (const peer of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(manifest.peerDependencies[peer], '*');
    assert.equal(manifest.peerDependenciesMeta[peer].optional, true);
  }
  // CC-AC-1: load the archive with its declared dependency, not a source symlink.
  const commonRoot = fileURLToPath(new URL('../', import.meta.resolve('@neruok/pi-common/settings')));
  const commonArchive = join(dir, 'common-archive');
  await mkdir(commonArchive);
  const commonOutput = JSON.parse(execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--dry-run=false', '--pack-destination', commonArchive], { cwd: commonRoot, encoding: 'utf8', timeout: 60000 }));
  const [commonPack] = Array.isArray(commonOutput) ? commonOutput : Object.values(commonOutput);
  assert.equal(commonPack.bundled.length, 0);
  const installed = join(dir, 'package/node_modules/@neruok/pi-common');
  await mkdir(installed, { recursive: true });
  execFileSync('tar', ['-xzf', join(commonArchive, commonPack.filename), '--strip-components=1', '-C', installed]);
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  const commonManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(commonManifest.name, '@neruok/pi-common');
  assert.equal(commonManifest.dependencies, undefined);
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [join(dir, 'package')],
  });
  await loader.reload();
  const skills = loader.getSkills();
  assert.deepEqual(skills.diagnostics, [], 'Packed skill must load without diagnostics');
  assert.deepEqual(skills.skills.map(skill => skill.name).sort(), ['adversarial-review', 'socratic-reasoning']);
  for (const skill of skills.skills) {
    assert.equal(skill.filePath, join(dir, `package/skills/${skill.name}/SKILL.md`));
    assert.equal(skill.disableModelInvocation, false);
  }
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], 'Packed extension must load without errors');
  assert.equal(result.extensions.length, 1);
  assert.deepEqual([...result.extensions[0].tools.keys()].sort(), ['advisor', 'advisor_close', 'advisor_sessions']);
  assert.deepEqual([...result.extensions[0].commands.keys()], ['advisor']);
  console.log(`Verified ${manifest.name}@${manifest.version}: ${paths.length} shipped files; one extension, three tools, one command, two skills.`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
