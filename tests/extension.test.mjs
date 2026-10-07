import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import extension from '../advisor.ts';
import { reply, model } from './helpers.mjs';

function registrations() { const tools = new Map(), commands = new Map(), events = new Map(), messages = []; extension({ registerTool: t => tools.set(t.name, t), registerCommand: (n, c) => commands.set(n, c), on: (n, h) => events.set(n, h), sendMessage: (message, options) => messages.push({ message, options }) }); return { tools, commands, events, messages }; }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-extension-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir; t.after(() => saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved);
  await writeFile(join(dir, 'advisor.json'), JSON.stringify({ model })); const requests = [], notices = [];
  const ctx = { cwd: join(dir, 'workspace'), mode: 'print', hasUI: false, isProjectTrusted: () => false, waitForIdle: async () => {}, sessionManager: new Proxy({}, { get: () => { throw new Error('Parent history must not be read'); } }), executeTool: () => { throw new Error('No tools may run'); }, ui: { notify: (s, level) => notices.push({ s, level }), select: async () => undefined }, modelRegistry: {
    find: (provider, id) => ({ provider, id, api: 'mock-api' }), hasConfiguredAuth: () => true,
    getAvailable: () => [{ provider: 'mock', id: 'chat', name: 'Chat', api: 'mock-api' }],
    streamSimple: (m, c, o) => { requests.push({ m, c, o }); return { result: async () => reply() }; }
  } }; return { dir, ctx, requests, notices, ...registrations() };
}
function data(tool, result) { assert.equal(Compile(tool.outputSchema).Check(result.structuredContent), true); assert.deepEqual(result.details, result.structuredContent); assert.deepEqual(JSON.parse(result.content[0].text), result.details); return result.details; }

test('AC-8 registration, strict schemas, coherent results and usage', async t => {
  const f = await fixture(t); assert.deepEqual([...f.tools.keys()], ['advisor', 'advisor_sessions', 'advisor_close'], 'three tools must register');
  for (const tool of f.tools.values()) { assert.equal(tool.exposure, 'model-only'); assert.ok(tool.outputSchema); }
  const tool = f.tools.get('advisor');
  for (const bad of [{ message: null }, { message: 'Q', session: null }, { message: 'Q', workspace: true }]) assert.equal(Compile(tool.parameters).Check(bad), false);
  assert.match(tool.promptGuidelines.join('\n'), /not evidence/i); assert.match(tool.description, /charges/i);
  const first = data(tool, await tool.execute('1', { message: 'Q' }, undefined, undefined, f.ctx)); assert.equal(first.ok, true); assert.equal(first.advisory, true);
  const oversized = data(tool, await tool.execute('too-big', { message: 'x'.repeat(16385), session: first.session }, undefined, undefined, f.ctx));
  assert.equal(oversized.error.code, 'limit-exceeded'); assert.equal(oversized.session, first.session);
  const secondResult = await tool.execute('2', { message: 'Evidence', session: first.session }, undefined, undefined, f.ctx); const second = data(tool, secondResult);
  assert.equal(second.usage.input, 10); assert.equal(second.totalUsage.input, 20); assert.equal(secondResult.usage.input, 10);
  const bad = await tool.execute('3', { message: 'Q', session: 'unknown' }, undefined, undefined, f.ctx); assert.equal(bad.isError, true); assert.equal(data(tool, bad).error.code, 'not-found');
  const listTool = f.tools.get('advisor_sessions'); const list = data(listTool, await listTool.execute('4', {}, undefined, undefined, f.ctx)); assert.equal(list.sessions.length, 1);
  const closeTool = f.tools.get('advisor_close'); assert.equal(data(closeTool, await closeTool.execute('5', { session: first.session }, undefined, undefined, f.ctx)).ok, true);
});

test('AC-1 AC-5 tool boundary uses explicit context and clears on lifecycle, not compaction', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor'); assert.ok(tool, 'advisor tool must be registered');
  for (const event of ['session_start', 'session_tree', 'session_shutdown']) {
    const first = await tool.execute('1', { message: 'EXPLICIT' }, undefined, undefined, f.ctx); assert.equal(first.details.ok, true);
    assert.equal(f.requests.at(-1).c.messages.length, 2); assert.deepEqual(f.requests.at(-1).c.messages[0].toolsAdded, []);
    await f.events.get('session_compact')?.({}, f.ctx); assert.equal((await f.tools.get('advisor_sessions').execute('l', {}, undefined, undefined, f.ctx)).details.sessions.length, 1);
    await f.events.get(event)({}, f.ctx); assert.equal((await tool.execute('2', { message: 'Q', session: first.details.session }, undefined, undefined, f.ctx)).details.error.code, 'not-found');
  }
});

test('AC-6 tool preflight rejects absent configuration, models, virtual models and auth', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor'); assert.ok(tool, 'preflight requires registered tool');
  await writeFile(join(f.dir, 'advisor.json'), '{}'); assert.equal((await tool.execute('x', { message: 'Q' }, undefined, undefined, f.ctx)).details.error.code, 'not-configured');
  await writeFile(join(f.dir, 'advisor.json'), JSON.stringify({ model }));
  f.ctx.modelRegistry.find = () => undefined; assert.equal((await tool.execute('x', { message: 'Q' }, undefined, undefined, f.ctx)).details.error.code, 'model-unavailable');
  f.ctx.modelRegistry.find = () => ({ api: 'pi-virtual' }); assert.equal((await tool.execute('x', { message: 'Q' }, undefined, undefined, f.ctx)).details.error.code, 'model-unavailable');
  f.ctx.modelRegistry.find = () => ({ provider: 'mock', id: 'chat', api: 'mock-api' }); f.ctx.modelRegistry.hasConfiguredAuth = () => false;
  assert.equal((await tool.execute('x', { message: 'Q' }, undefined, undefined, f.ctx)).details.error.code, 'model-unavailable'); assert.equal(f.requests.length, 0);
});

test('AC-7 user-only configuration supports show, save, picker, cancellation and trust', async t => {
  const f = await fixture(t), command = f.commands.get('advisor'); assert.ok(command, 'settings command must be registered');
  await command.handler('show', f.ctx); assert.match(f.messages.at(-1)?.message.content ?? '', /mock.*chat/); assert.equal(f.messages.at(-1)?.options.triggerTurn, false); assert.equal(f.requests.length, 0);
  await command.handler('model next selected', f.ctx); assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'advisor.json'), 'utf8')), { model: { provider: 'next', model: 'selected' } });
  const before = await readFile(join(f.dir, 'advisor.json'), 'utf8');
  await command.handler('model --bogus next selected', f.ctx); await command.handler('--project model next selected', f.ctx); assert.equal(await readFile(join(f.dir, 'advisor.json'), 'utf8'), before);
  f.ctx.hasUI = true; await command.handler('', f.ctx); assert.equal(await readFile(join(f.dir, 'advisor.json'), 'utf8'), before);
  f.ctx.ui.select = async () => 'mock/chat'; await command.handler('', f.ctx); assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'advisor.json'), 'utf8')), { model });
  f.ctx.isProjectTrusted = () => true; await mkdir(f.ctx.cwd, { recursive: true }); await command.handler('--project model next selected', f.ctx); assert.deepEqual(JSON.parse(await readFile(join(f.ctx.cwd, '.pi', 'advisor.json'), 'utf8')), { model: { provider: 'next', model: 'selected' } });
  f.ctx.modelRegistry.find = () => undefined; await command.handler('model invalid nope', f.ctx); assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'advisor.json'), 'utf8')), { model });
  let trust = true; f.ctx.modelRegistry.find = (p, id) => ({ provider: p, id, api: 'mock-api' }); f.ctx.isProjectTrusted = () => trust; f.ctx.ui.select = async () => { trust = false; return 'mock/chat'; };
  await command.handler('--project', f.ctx); assert.deepEqual(JSON.parse(await readFile(join(f.ctx.cwd, '.pi', 'advisor.json'), 'utf8')), { model: { provider: 'next', model: 'selected' } }); assert.equal(f.requests.length, 0);
});

test('AC-9 standalone loader discovers extension without provider work and README covers boundaries', async t => {
  const f = await fixture(t); assert.equal(f.tools.size, 3, 'package must expose its tools before loader verification');
  const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const loader = new DefaultResourceLoader({ cwd: f.dir, agentDir: f.dir, settingsManager: SettingsManager.inMemory(), noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [new URL('../', import.meta.url).pathname] });
  await loader.reload(); const result = loader.getExtensions(); assert.equal(result.errors.length, 0); assert.equal(result.extensions.length, 1); assert.equal(result.extensions[0].tools.size, 3); assert.equal(result.extensions[0].commands.size, 1);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')); assert.equal(packageJson.dependencies, undefined); assert.equal(packageJson.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8'); for (const term of ['advisor_close', 'advisor_sessions', '/advisor model', 'ephemeral', 'transcript', '16384', 'authorization']) assert.ok(readme.includes(term), term);
});
