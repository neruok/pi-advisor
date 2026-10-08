import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { CombinedAutocompleteProvider, visibleWidth } from '@earendil-works/pi-tui';
import extension from '../advisor.ts';
import { parseSettings, loadSettings, saveSettings, settingsPaths } from '../lib/settings.ts';
import { reply } from './helpers.mjs';

const pair = { provider: 'chat', model: 'luna-large' };
const levels = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'advisor-configuration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), agent = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true }); await mkdir(agent);
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved);
  const paths = settingsPaths(cwd, agent);
  await writeFile(paths.global, JSON.stringify({ model: pair }));
  const models = [
    { contextWindow: 272000, provider: 'chat', id: 'luna-large', name: 'Luna Large', api: 'mock-api', reasoning: true, thinkingLevelMap: { xhigh: null, max: null } },
    { contextWindow: 64000, provider: 'chat', id: 'other/small', name: 'Tiny Moon', api: 'mock-api', reasoning: false },
    { contextWindow: 32000, provider: 'another', id: 'plain', name: 'Plain', api: 'mock-api', reasoning: false },
    { provider: 'virtual-only', id: 'virtual', name: 'Virtual', api: 'pi-virtual', reasoning: true },
  ];
  const commands = new Map(), tools = new Map(), events = new Map(), notices = [], requests = [];
  const forbidden = () => assert.fail('Unexpected tool, active-model change, or catalog refresh');
  extension({ registerCommand: (name, command) => commands.set(name, command), registerTool: tool => tools.set(tool.name, tool),
    on: (name, handler) => events.set(name, handler), setModel: forbidden,
    sendMessage: (message, options) => { assert.equal(options.triggerTurn, false); assert.equal(message.customType, 'advisor-settings'); notices.push(message.content); } });
  let trusted = true;
  const ctx = { cwd, hasUI: true, mode: 'rpc', isProjectTrusted: () => trusted, waitForIdle: async () => {},
    thinkingLevel: 'max', executeTool: forbidden,
    sessionManager: new Proxy({}, { get: forbidden }),
    ui: { notify: text => notices.push(text), select: async () => undefined },
    modelRegistry: { getAvailable: () => models, find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
      hasConfiguredAuth: () => true, refresh: forbidden,
      streamSimple: (model, context, options) => { requests.push({ model, context, options }); return { result: async () => reply(undefined, { content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'Plain advice.' }] }) }; } },
  };
  await events.get('session_start')({}, ctx);
  const command = commands.get('advisor'), tool = tools.get('advisor');
  const complete = async prefix => command.getArgumentCompletions ? await command.getArgumentCompletions(prefix) : null;
  const values = async prefix => (await complete(prefix) ?? []).map(item => item.value.trimEnd());
  const invoke = args => tool.execute('test', args ?? { message: 'Q' }, undefined, undefined, ctx);
  return { paths, models, commands, tools, events, ctx, notices, requests, command, tool, complete, values, invoke, trust: value => { trusted = value; } };
}
const theme = { fg: (_key, text) => text, bold: text => text };

test('AC-26 changed: timeout settings validate bounds and resolve independently of the model', async t => {
  const f = await fixture(t);
  for (const timeoutMs of [1, 300000, 2147483647]) assert.equal(parseSettings({ timeoutMs }).timeoutMs, timeoutMs);
  for (const timeoutMs of [0, -1, 1.5, null, '300000', true, 2147483648, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => parseSettings({ model: pair, timeoutMs }), error => error.code === 'invalid-config');
  }
  assert.throws(() => parseSettings({ model: { ...pair, timeoutMs: 300000 } }));
  await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, reasoning: 'high' }, timeoutMs: 600000 }));
  await writeFile(f.paths.project, JSON.stringify({ model: { ...pair, model: 'other/small' } }));
  let loaded = await loadSettings(f.paths, true);
  assert.equal(loaded.settings.timeoutMs, 600000); assert.equal(loaded.timeoutSource, 'global');
  assert.equal(loaded.source, 'project'); assert.equal(loaded.settings.model.reasoning, undefined);
  await writeFile(f.paths.project, JSON.stringify({ timeoutMs: 900000 }));
  loaded = await loadSettings(f.paths, true);
  assert.deepEqual(loaded.settings.model, { ...pair, reasoning: 'high' });
  assert.equal(loaded.source, 'global'); assert.equal(loaded.settings.timeoutMs, 900000); assert.equal(loaded.timeoutSource, 'project');
  await writeFile(f.paths.project, '{');
  assert.equal((await loadSettings(f.paths, false)).settings.timeoutMs, 600000);
  await assert.rejects(loadSettings(f.paths, true));
  await writeFile(f.paths.global, JSON.stringify({ timeoutMs: 0 }));
  await writeFile(f.paths.project, JSON.stringify({ model: pair, timeoutMs: 900000 }));
  await assert.rejects(loadSettings(f.paths, true));
  assert.equal(f.requests.length, 0);
});

test('AC-26 changed: timeout query show autocomplete and reset work without model work', async t => {
  const f = await fixture(t), before = await readFile(f.paths.global, 'utf8');
  for (const hasUI of [true, false]) {
    f.ctx.hasUI = hasUI;
    await f.command.handler('timeout', f.ctx);
    assert.match(f.notices.at(-1), /Timeout: 300000 ms \(default\)/);
    await f.command.handler('show', f.ctx);
    assert.match(f.notices.at(-1), /Timeout: 300000 ms \(default\)/);
  }
  assert.equal(await readFile(f.paths.global, 'utf8'), before);
  assert.deepEqual(await f.values('ti'), ['timeout']);
  assert.deepEqual(await f.values('timeout d'), ['timeout default']);
  assert.deepEqual(await f.values('--project timeout d'), ['--project timeout default']);
  for (const prefix of ['timeout nope ', 'timeout default extra ', 'timeout 0 ']) assert.equal(await f.complete(prefix), null);
  await writeFile(f.paths.global, '{}');
  await f.command.handler('timeout 600000', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { timeoutMs: 600000 });
  await f.command.handler('--project timeout 900000', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')), { timeoutMs: 900000 });
  await f.command.handler('--project timeout default', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')), {});
  assert.match(f.notices.at(-1), /Timeout: 600000 ms \(global\)/);
  await f.command.handler('timeout default', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), {});
  assert.match(f.notices.at(-1), /Timeout: 300000 ms \(default\)/);
  assert.equal(f.requests.length, 0);
});

test('AC-26 changed: scoped commands preserve owned timeout model and effort without copying overrides', async t => {
  const f = await fixture(t);
  const global = { model: { ...pair, reasoning: 'high' }, timeoutMs: 600000 };
  const project = { model: { ...pair, model: 'other/small', reasoning: 'off' }, timeoutMs: 900000 };
  await writeFile(f.paths.global, JSON.stringify(global)); await writeFile(f.paths.project, JSON.stringify(project));
  await f.command.handler('timeout 700000', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { ...global, timeoutMs: 700000 });
  await f.command.handler('--project timeout 1000000', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')), { ...project, timeoutMs: 1000000 });
  await f.command.handler('reasoning low', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { model: { ...pair, reasoning: 'low' }, timeoutMs: 700000 });
  await f.command.handler('model chat luna-large', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { model: pair, timeoutMs: 700000 });
  f.ctx.hasUI = true; f.ctx.ui.select = async () => 'chat/other/small';
  await f.command.handler('', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { model: { ...pair, model: 'other/small' }, timeoutMs: 700000 });
  await rm(f.paths.project); await f.command.handler('--project reasoning off', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')), { model: { ...pair, model: 'other/small', reasoning: 'off' } });
  assert.equal((await loadSettings(f.paths, true)).settings.timeoutMs, 700000);
  const saved = await readFile(f.paths.project, 'utf8');
  for (const args of ['--project timeout 0', 'timeout -1', 'timeout 1.5', 'timeout 1e3', 'timeout 2147483648', 'timeout null', 'timeout 300000 extra', '--global --project timeout 300000']) {
    await f.command.handler(args, f.ctx);
  }
  assert.equal(await readFile(f.paths.project, 'utf8'), saved);
  f.trust(false); await f.command.handler('--project timeout 300000', f.ctx);
  assert.equal(await readFile(f.paths.project, 'utf8'), saved);
  f.trust(true); f.ctx.waitForIdle = async () => { f.trust(false); };
  await f.command.handler('--project timeout 300000', f.ctx);
  assert.equal(await readFile(f.paths.project, 'utf8'), saved);
  assert.equal(f.requests.length, 0);
});

test('AC-26 changed: saves preserve independent fields from the locked target checkpoint', async t => {
  const f = await fixture(t);
  await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, reasoning: 'high' }, timeoutMs: 700000 }));
  await saveSettings(f.paths, 'global', { model: pair }, true, 'timeoutMs');
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { model: pair, timeoutMs: 700000 });
  const changedModel = { ...pair, model: 'other/small', reasoning: 'off' };
  await writeFile(f.paths.global, JSON.stringify({ model: changedModel, timeoutMs: 700000 }));
  await saveSettings(f.paths, 'global', { timeoutMs: 900000 }, true, 'model');
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { model: changedModel, timeoutMs: 900000 });
  await saveSettings(f.paths, 'global', {}, true, 'model');
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { model: changedModel });
  await saveSettings(f.paths, 'project', { timeoutMs: 600000 }, true, 'model');
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')), { timeoutMs: 600000 });
  await saveSettings(f.paths, 'project', { model: pair }, true, 'timeoutMs');
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')), { model: pair, timeoutMs: 600000 });
  await saveSettings(f.paths, 'project', {}, true, 'model');
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')), { model: pair });
  assert.equal(f.requests.length, 0);
});

test('AC-26 changed: registered tools pin timeout while new consultations resolve fresh overrides', async t => {
  const f = await fixture(t);
  await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, reasoning: 'high' }, timeoutMs: 600000 }));
  await writeFile(f.paths.project, JSON.stringify({ timeoutMs: 900000 }));
  const first = await f.invoke(); assert.equal(first.details.ok, true);
  assert.ok(f.requests[0].options.timeoutMs > 899000 && f.requests[0].options.timeoutMs <= 900000);
  await writeFile(f.paths.project, JSON.stringify({ model: { ...pair, model: 'other/small' }, timeoutMs: 30000 }));
  const next = await f.invoke({ session: first.details.session, message: 'Continue' }); assert.equal(next.details.ok, true);
  assert.ok(f.requests[1].options.timeoutMs > 899000 && f.requests[1].options.timeoutMs <= 900000);
  assert.deepEqual(next.details.model, { ...pair, reasoning: 'high' });
  const fresh = await f.invoke(); assert.equal(fresh.details.ok, true);
  assert.ok(f.requests[2].options.timeoutMs > 29000 && f.requests[2].options.timeoutMs <= 30000);
  f.trust(false);
  const untrusted = await f.invoke(); assert.equal(untrusted.details.ok, true);
  assert.ok(f.requests[3].options.timeoutMs > 599000 && f.requests[3].options.timeoutMs <= 600000);
  for (const result of [first, next, fresh, untrusted]) assert.equal(Compile(f.tool.outputSchema).Check(result.details), true);
  for (const request of f.requests) { assert.equal(request.options.maxRetries, 0); assert.equal(Object.hasOwn(request.options, 'toolChoice'), false); }
  assert.equal(Compile(f.tool.parameters).Check({ message: 'Q', timeoutMs: 600000 }), false);
});

test('AC-26 changed: README documents units default precedence pinning and timeout commands', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const text of ['300000', '2147483647', 'timeoutMs', '/advisor timeout', 'timeout default', 'milliseconds']) assert.ok(readme.includes(text), text);
  assert.doesNotMatch(readme, /120000 ms deadline per call/);
});

// Changed behavior: these checks fail against the effort-free baseline.
test('AC-20 strict reasoning values and whole-selection precedence', async t => {
  const f = await fixture(t);
  for (const reasoning of levels) assert.equal(parseSettings({ model: { ...pair, reasoning } }).model.reasoning, reasoning);
  for (const reasoning of [null, 3, '', 'HIGH', 'bogus']) assert.throws(() => parseSettings({ model: { ...pair, reasoning } }), error => error.code === 'invalid-config');
  assert.throws(() => parseSettings({ reasoning: 'high', model: pair }));
  await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, reasoning: 'high' } }));
  await writeFile(f.paths.project, JSON.stringify({ model: { ...pair, model: 'other/small' } }));
  assert.equal((await loadSettings(f.paths, true)).settings.model.reasoning, undefined);
  assert.equal((await loadSettings(f.paths, false)).settings.model.reasoning, 'high');
});

test('AC-20 reasoning query reports effective capabilities in UI and non-UI without writes or spending', async t => {
  const f = await fixture(t), before = await readFile(f.paths.global, 'utf8');
  for (const hasUI of [true, false]) {
    f.ctx.hasUI = hasUI; await f.command.handler('reasoning', f.ctx);
    assert.match(f.notices.at(-1), /Supported advisor reasoning: default, off, minimal, low, medium, high\./);
    assert.match(f.notices.at(-1), /legacy|provider behavior/i);
    assert.match(f.notices.at(-1), /cost.*latency/i);
  }
  assert.equal(await readFile(f.paths.global, 'utf8'), before); assert.equal(f.requests.length, 0);
});

test('AC-20 reasoning writes use the save scope and model selection resets effort', async t => {
  const f = await fixture(t);
  await writeFile(f.paths.project, JSON.stringify({ model: { ...pair, model: 'other/small' } }));
  await f.command.handler('--global reasoning medium', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')).model, { ...pair, reasoning: 'medium' });
  await f.command.handler('reasoning off --project', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')).model, { ...pair, model: 'other/small', reasoning: 'off' });
  await rm(f.paths.project);
  await f.command.handler('--project reasoning low', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.project, 'utf8')).model, { ...pair, reasoning: 'low' });
  await f.command.handler('model chat luna-large', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { model: pair });
  await f.command.handler('reasoning high', f.ctx);
  f.ctx.ui.select = async () => 'chat/luna-large'; await f.command.handler('', f.ctx);
  assert.deepEqual(JSON.parse(await readFile(f.paths.global, 'utf8')), { model: pair });
  assert.equal(f.requests.length, 0);
});

test('AC-20 unsupported, missing, invalid and untrusted reasoning commands never write or generate', async t => {
  const f = await fixture(t), before = await readFile(f.paths.global, 'utf8');
  await f.command.handler('reasoning max', f.ctx);
  assert.match(f.notices.at(-1), /Configured advisor reasoning is not supported/);
  for (const args of ['reasoning nope', 'reasoning high extra', '--global --project reasoning high']) await f.command.handler(args, f.ctx);
  assert.equal(await readFile(f.paths.global, 'utf8'), before);
  f.trust(false); await f.command.handler('--project reasoning high', f.ctx);
  await assert.rejects(readFile(f.paths.project), { code: 'ENOENT' });
  await writeFile(f.paths.global, '{}'); await f.command.handler('reasoning high', f.ctx);
  assert.match(f.notices.at(-1), /No advisor model configured/); assert.equal(await readFile(f.paths.global, 'utf8'), '{}');
  await writeFile(f.paths.global, JSON.stringify({ model: pair }));
  f.ctx.waitForIdle = async () => { f.trust(false); }; f.trust(true);
  await f.command.handler('--project reasoning low', f.ctx);
  await assert.rejects(readFile(f.paths.project), { code: 'ENOENT' });
  assert.equal(f.requests.length, 0);
});

test('AC-20 AC-25 effort reaches every request and remains pinned without toolChoice with schema-valid metadata', async t => {
  const f = await fixture(t);
  await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, reasoning: 'high' } }));
  const first = await f.invoke(); assert.equal(first.details.ok, true);
  assert.equal(first.details.model.reasoning, 'high');
  await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, model: 'other/small', reasoning: 'off' } }));
  const next = await f.invoke({ session: first.details.session, message: 'Evidence' });
  assert.equal(next.details.ok, true); assert.equal(next.details.turns, 2);
  assert.deepEqual(next.details.model, { ...pair, reasoning: 'high' });
  for (const request of f.requests) {
    assert.equal(request.options.reasoning, 'high'); assert.equal(request.model.id, 'luna-large');
    assert.equal(request.options.maxTokens, 4096); assert.equal(request.options.maxRetries, 0); assert.equal(Object.hasOwn(request.options, 'toolChoice'), false);
    assert.deepEqual(request.context.messages[0].toolsAdded, []);
  }
  const list = await f.tools.get('advisor_sessions').execute('list', {}, undefined, undefined, f.ctx);
  assert.equal(list.details.sessions[0].model.reasoning, 'high');
  for (const [tool, result] of [[f.tool, first], [f.tool, next], [f.tools.get('advisor_sessions'), list]]) {
    assert.equal(Compile(tool.outputSchema).Check(result.structuredContent), true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details); assert.deepEqual(result.details, result.structuredContent);
  }
  assert.doesNotMatch(JSON.stringify([first, next, list, f.requests]), /PRIVATE_THINKING/);
  assert.equal(Compile(f.tool.parameters).Check({ message: 'Q', reasoning: 'low' }), false);
});

test('AC-20 legacy/default/off omit SDK effort and supported explicit levels are forwarded unchanged', async t => {
  const f = await fixture(t);
  f.models[0].thinkingLevelMap = { xhigh: 'xhigh', max: 'max' };
  for (const reasoning of [undefined, ...levels]) {
    await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, ...(reasoning === undefined ? {} : { reasoning }) } }));
    const result = await f.invoke(); assert.equal(result.details.ok, true);
    if (reasoning === undefined || reasoning === 'off' || reasoning === 'default') assert.equal(Object.hasOwn(f.requests.at(-1).options, 'reasoning'), false);
    else assert.equal(f.requests.at(-1).options.reasoning, reasoning);
    await f.tools.get('advisor_close').execute('close', { session: result.details.session }, undefined, undefined, f.ctx);
  }
});

test('AC-20 unsupported effort fails before generation and continuation commits nothing', async t => {
  const f = await fixture(t);
  for (const reasoning of ['xhigh', 'max', 'off', 'medium']) {
    if (reasoning === 'off') f.models[0].thinkingLevelMap.off = null;
    if (reasoning === 'medium') f.models[0].reasoning = false;
    await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, reasoning } }));
    const result = await f.invoke(); assert.equal(result.details.error.code, 'unsupported-reasoning');
    assert.equal(f.requests.length, 0);
  }
  f.models[0].reasoning = true;
  await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, reasoning: 'high' } }));
  const first = await f.invoke(); assert.equal(first.details.ok, true);
  f.models[0].thinkingLevelMap.high = null;
  const failed = await f.invoke({ session: first.details.session, message: 'Not committed' });
  assert.equal(failed.details.error.code, 'unsupported-reasoning'); assert.equal(f.requests.length, 1);
  const list = await f.tools.get('advisor_sessions').execute('list', {}, undefined, undefined, f.ctx);
  assert.equal(list.details.sessions[0].turns, 1); assert.equal(list.details.sessions[0].model.reasoning, 'high');
});

test('AC-20 expanded effort labels and README explain compatibility and costs', async t => {
  const f = await fixture(t);
  for (const reasoning of [undefined, 'low']) {
    await writeFile(f.paths.global, JSON.stringify({ model: { ...pair, ...(reasoning ? { reasoning } : {}) } }));
    const result = await f.invoke(); assert.equal(result.details.ok, true);
    const lines = f.tool.renderResult(result, { expanded: true, isPartial: false }, theme).render(80);
    assert.match(lines.join('\n'), reasoning ? /Reasoning: low/ : /Reasoning: default.*legacy/);
    assert.ok(lines.every(line => visibleWidth(line) <= 80));
  }
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const expected of [/\/advisor reasoning/, /xhigh/, /unsupported-reasoning/, /reasoning.*pinned|pinned.*reasoning/i, /cost.*latency/i]) assert.match(readme, expected);
});

test('AC-21 AC-26 command/scoped grammar completes without catalogs and rejects excess/conflicting arguments', async t => {
  const f = await fixture(t); let lookups = 0;
  f.ctx.modelRegistry.getAvailable = () => { lookups++; throw new Error('Unexpected static lookup'); };
  await writeFile(f.paths.global, '{');
  assert.deepEqual(await f.values('timeout '), ['timeout default']);
  assert.deepEqual(new Set(await f.values('')), new Set(['show', 'model', 'reasoning', 'timeout', '--global', '--project']));
  assert.deepEqual(await f.values('rea'), ['reasoning']); assert.deepEqual(await f.values('--p'), ['--project']);
  assert.deepEqual(new Set(await f.values('--project ')), new Set(['--project show', '--project model', '--project reasoning', '--project timeout']));
  assert.deepEqual(await f.values('model chat luna-large --p'), ['model chat luna-large --project']);
  assert.deepEqual(await f.values('reasoning high --g'), ['reasoning high --global']);
  for (const invalid of ['nope ', '--bad ', '--global --project ', '--global --global ', 'show extra ', 'reasoning high extra ', 'reasoning nope ', 'model chat luna-large extra ', 'model chat luna-large extra', 'model chat luna-large --global --']) assert.equal(await f.complete(invalid), null, invalid);
  assert.equal(lookups, 0);
});

test('AC-21 current physical providers and fuzzy model names preserve command identifiers', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.values('model '), ['model another', 'model chat']);
  assert.deepEqual(await f.values('model CH'), ['model chat']);
  assert.deepEqual(await f.values('model --project ch'), ['model --project chat']);
  assert.deepEqual(await f.values('--global model chat LU'), ['--global model chat luna-large']);
  assert.deepEqual(await f.values('model chat TM'), ['model chat other/small']);
  for (const prefix of ['model virtual-only ', 'model missing ', 'model chat zzzz']) assert.equal(await f.complete(prefix), null);
  f.models.push({ provider: 'new-chat', id: 'new', api: 'mock-api', name: 'New' }, { provider: 'bad provider', id: 'invalid', api: 'mock-api' }, { provider: 'chat', id: 'bad id', api: 'mock-api' });
  assert.ok((await f.values('model ')).includes('model new-chat'));
  assert.ok(!(await f.values('model ')).some(value => value.includes('bad provider')));
  assert.ok(!(await f.values('model chat ')).some(value => value.includes('bad id')));
});

test('AC-21 reasoning completions use fresh save-scope capabilities and current trust', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.values('reasoning h'), ['reasoning high']);
  assert.ok(!(await f.values('reasoning ')).includes('reasoning max'));
  await writeFile(f.paths.project, JSON.stringify({ model: { ...pair, model: 'other/small' } }));
  assert.deepEqual(await f.values('--project reasoning '), ['--project reasoning default', '--project reasoning off']);
  assert.deepEqual(await f.values('reasoning --project o'), ['reasoning --project off']);
  assert.deepEqual(await f.values('--global reasoning h'), ['--global reasoning high']);
  await writeFile(f.paths.global, JSON.stringify({ model: { provider: 'another', model: 'plain' } }));
  assert.deepEqual(await f.values('reasoning '), ['reasoning default', 'reasoning off']);
  await writeFile(f.paths.project, '{'); f.trust(false);
  assert.equal(await f.complete('--project reasoning '), null);
  assert.deepEqual(await f.values('reasoning '), ['reasoning default', 'reasoning off']);
  f.trust(true); assert.equal(await f.complete('--project reasoning '), null);
  await writeFile(f.paths.project, '{}'); assert.deepEqual(await f.values('--project reasoning '), ['--project reasoning default', '--project reasoning off']);
  await writeFile(f.paths.global, '{}'); assert.equal(await f.complete('reasoning '), null);
});

test('AC-21 actual Pi argument replacement retains whitespace, suffix and cursor with trailing space', async t => {
  const f = await fixture(t), provider = new CombinedAutocompleteProvider([{ name: 'advisor', ...f.command }], f.ctx.cwd, null);
  for (const [before, suffix, expected, label] of [
    ['/advisor rea', '', '/advisor reasoning ', 'reasoning'],
    ['/advisor --project\tmodel\tchat\tLU', '', '/advisor --project\tmodel\tchat\tluna-large ', 'luna-large'],
    ['/advisor --g', 'model chat luna-large', '/advisor --global model chat luna-large', '--global'],
  ]) {
    const suggestions = await provider.getSuggestions([before + suffix], 0, before.length, { signal: new AbortController().signal });
    assert.ok(suggestions, before); const item = suggestions.items.find(item => item.label === label); assert.ok(item);
    assert.ok(item.value.endsWith(' ')); assert.ok(item.description);
    const applied = provider.applyCompletion([before + suffix], 0, before.length, item, suggestions.prefix);
    assert.deepEqual(applied.lines, [expected]); assert.equal(applied.cursorCol, expected.length - suffix.length);
  }
});

test('AC-21 lookup failures stay silent and completions never write, spend or notify', async t => {
  const f = await fixture(t), global = await readFile(f.paths.global, 'utf8');
  assert.ok((await f.complete('model '))?.length);
  await f.complete('reasoning h'); await f.complete('--p');
  f.ctx.modelRegistry.getAvailable = () => { throw new Error('RAW_LOOKUP_SECRET'); };
  assert.equal(await f.complete('model '), null);
  await writeFile(f.paths.global, '{'); assert.equal(await f.complete('reasoning '), null);
  assert.deepEqual(await f.values('rea'), ['reasoning']);
  assert.equal(await readFile(f.paths.global, 'utf8'), '{');
  await writeFile(f.paths.global, global); await f.complete('reasoning h');
  assert.equal(await readFile(f.paths.global, 'utf8'), global);
  assert.deepEqual(f.notices, []); assert.equal(f.requests.length, 0);
});

test('AC-21 start, tree and shutdown discard stale pending results and context', async t => {
  const f = await fixture(t);
  assert.ok((await f.complete('reasoning '))?.length);
  for (const event of ['session_start', 'session_tree', 'session_shutdown']) {
    const pending = f.complete('reasoning ');
    const next = { ...f.ctx, modelRegistry: { ...f.ctx.modelRegistry, getAvailable: () => [{ provider: 'new', id: 'next', api: 'mock-api' }] } };
    await f.events.get(event)({}, next); assert.equal(await pending, null);
    if (event !== 'session_shutdown') assert.deepEqual(await f.values('model '), ['model new']);
    else for (const prefix of ['model ', 'reasoning ']) assert.equal(await f.complete(prefix), null);
    assert.deepEqual(await f.values('rea'), ['reasoning']);
    await f.events.get('session_start')({}, f.ctx);
  }
});

test('AC-21 README distinguishes argument completions from the Pi 1.0.4 Tab routing limit', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const expected of [/autocomplete/i, /Pi 1\.0\.4.*Tab|Tab.*Pi 1\.0\.4/, /type.*prefix/i, /inserts.*text.*does not.*save/i]) assert.match(readme, expected);
});
