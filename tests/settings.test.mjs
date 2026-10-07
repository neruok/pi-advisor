import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings } from '../lib/settings.ts';
import { model } from './helpers.mjs';

async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'advisor-settings-')); t.after(() => rm(dir, { recursive: true, force: true })); const paths = { global: join(dir, 'user', 'advisor.json'), project: join(dir, 'project', '.pi', 'advisor.json') }; await mkdir(join(dir, 'user'), { recursive: true }); await mkdir(join(dir, 'project', '.pi'), { recursive: true }); return { dir, paths }; }

test('AC-6 strict settings precedence, trust, bounds, symlinks and special files', async t => {
  const { dir, paths } = await fixture(t);
  await writeFile(paths.global, JSON.stringify({ model }));
  assert.deepEqual((await loadSettings(paths, false)).settings.model, model, 'global selection must be read');
  const other = { provider: 'other', model: 'new' }; await writeFile(paths.project, JSON.stringify({ model: other }));
  assert.deepEqual((await loadSettings(paths, false)).settings.model, model); assert.deepEqual((await loadSettings(paths, true)).settings.model, other);
  await writeFile(paths.project, '{}'); assert.deepEqual((await loadSettings(paths, true)).settings.model, model);
  for (const bad of ['{', 'null', '[]', '{"unknown":true}', '{"model":null}', '{"model":{"provider":"mock"}}', '{"model":{"provider":"mock","model":"has space"}}', ' '.repeat(16385)]) {
    await writeFile(paths.global, bad); await assert.rejects(loadSettings(paths, true));
  }
  await writeFile(paths.global, JSON.stringify({ model })); await writeFile(paths.project, '{');
  assert.deepEqual((await loadSettings(paths, false)).settings.model, model); await assert.rejects(loadSettings(paths, true));
  await rm(paths.project); await symlink(paths.global, paths.project); await assert.rejects(loadSettings(paths, true));
  await rm(paths.project); execFileSync('mkfifo', [paths.project]); await assert.rejects(loadSettings(paths, true));
  await rm(paths.project); await rm(join(dir, 'project', '.pi'), { recursive: true }); await symlink(join(dir, 'user'), join(dir, 'project', '.pi')); await assert.rejects(loadSettings(paths, true));
  await rm(paths.global); assert.deepEqual((await loadSettings(paths, false)).settings, {});
});

test('AC-7 atomic settings saves, validation, trust and exclusive locks', async t => {
  const { paths } = await fixture(t);
  await saveSettings(paths, 'global', { model }, false);
  assert.deepEqual(JSON.parse(await readFile(paths.global, 'utf8')), { model });
  await assert.rejects(saveSettings(paths, 'project', { model }, false));
  await assert.rejects(saveSettings(paths, 'global', { invalid: true }, true));
  await writeFile(paths.global + '.lock', 'OWNED_BY_OTHER');
  await assert.rejects(saveSettings(paths, 'global', { model: { provider: 'other', model: 'new' } }, true));
  assert.equal(await readFile(paths.global + '.lock', 'utf8'), 'OWNED_BY_OTHER'); assert.deepEqual(JSON.parse(await readFile(paths.global, 'utf8')), { model });
  await rm(paths.global + '.lock');
  await Promise.all([saveSettings(paths, 'global', { model }, true), saveSettings(paths, 'global', { model: { provider: 'other', model: 'new' } }, true)]);
  assert.deepEqual(JSON.parse(await readFile(paths.global, 'utf8')), { model: { provider: 'other', model: 'new' } });
});
