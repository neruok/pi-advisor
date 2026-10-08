import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { visibleWidth } from '@earendil-works/pi-tui';
import extension from '../advisor.ts';
import { Consultations } from '../lib/session.ts';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { AdviceSchema, ListSchema } from '../lib/schemas.ts';
import { dependencies, reply, deferred, waitFor, usage, model } from './helpers.mjs';

function limit(result, resource, maximum, actual, guidance) {
  assert.equal(result.error.code, 'limit-exceeded');
  assert.deepEqual(result.error.limit, { resource, maximum, actual });
  assert.match(result.error.message, guidance);
}
const pairBytes = (message, raw) => Buffer.byteLength(JSON.stringify([{ role: 'user', text: message }, { role: 'assistant', text: raw }]));

test('AC-31 multibyte input above the former byte limit reaches the provider unchanged', async () => {
  const manager = new Consultations(), deps = dependencies(), message = 'é'.repeat(8192) + 'x';
  const result = await manager.send({ message }, deps);
  assert.equal(result.ok, true); assert.equal(deps.requests.length, 1);
  assert.equal(deps.requests[0].context.messages.at(-1).content, message); assert.equal(manager.list()[0].turns, 1);
});

test('AC-31 reply above the former byte limit commits and keeps completed usage', async () => {
  const manager = new Consultations(), deps = dependencies();
  const first = await manager.send({ message: 'Q' }, deps);
  const raw = 'x'.repeat(16385 - '\n[CONTINUE]'.length) + '\n[CONTINUE]';
  const result = await manager.send({ session: first.session, message: 'SHORTER' }, dependencies(async () => reply(raw)));
  assert.equal(result.ok, true); assert.equal(result.response, raw);
  assert.deepEqual(result.usage, usage); assert.equal(result.totalUsage.input, 20); assert.equal(manager.list()[0].turns, 2);
});

test('AC-11 AC-29 AC-31 context preflight and pair overflow report model tokens', async () => {
  const raw = 'A\n[CONTINUE]', maximum = 5000;
  const initial = dependencies(async () => reply(raw, { usage: { ...usage, totalTokens: maximum } })); initial.getContextWindow = () => maximum;
  const manager = new Consultations(), first = await manager.send({ message: 'Q' }, initial);
  assert.equal(first.ok, true);
  const deps = dependencies(), actual = maximum + estimateTokens({ role: 'user', content: 'Q', timestamp: 0 });
  limit(await manager.send({ session: first.session, message: 'Q' }, deps), 'context-tokens', maximum, actual, /new consultation.*summary/i);
  assert.equal(deps.requests.length, 0); assert.equal(manager.list()[0].turns, 1);
  const tiny = new Consultations(); initial.getContextWindow = () => maximum - 1;
  limit(await tiny.send({ message: 'Q' }, initial), 'context-tokens', maximum - 1, maximum, /new consultation.*summary/i);
  assert.deepEqual(tiny.list(), []);
});

test('AC-31 exchange twenty-five commits beyond the former turn cap', async () => {
  const manager = new Consultations(), deps = dependencies();
  const first = await manager.send({ message: 'Q' }, deps);
  for (let i = 1; i < 24; i++) await manager.send({ session: first.session, message: 'Q' }, deps);
  const next = await manager.send({ session: first.session, message: 'Q' }, deps);
  assert.equal(next.ok, true); assert.equal(next.turns, 25); assert.equal(manager.list()[0].turns, 25);
});

test('AC-31 consultation nine commits beyond the former active-session cap', async () => {
  const manager = new Consultations(), deps = dependencies();
  for (let i = 0; i < 8; i++) await manager.send({ message: 'Q' }, deps);
  assert.equal((await manager.send({ message: 'Q' }, deps)).ok, true);
  assert.equal(manager.list().length, 9);
});

test('AC-12 preflight, success and completed rejected replies report completeness and totals', async () => {
  const manager = new Consultations(), deps = dependencies();
  const preflight = await manager.send({ message: '' }, deps);
  assert.equal(preflight.usageComplete, true); assert.equal(preflight.totalUsage, undefined);
  const first = await manager.send({ message: 'Q' }, deps);
  assert.equal(first.usageComplete, true); assert.equal(first.totalUsageComplete, true);
  const failed = await manager.send({ session: first.session, message: 'BAD' }, dependencies(async () => reply('REJECTED_TEXT', { stopReason: 'length' })));
  assert.equal(failed.usageComplete, true); assert.equal(failed.totalUsageComplete, true);
  assert.equal(failed.totalUsage.input, 20); assert.equal(failed.usage.input, 10);
  assert.equal(Compile(AdviceSchema).Check(failed), true);
  failed.totalUsage.cost.total = 1000;
  const invalid = await manager.send({ session: first.session, message: '' }, deps);
  assert.equal(invalid.totalUsage.cost.total, .026); assert.equal(invalid.usageComplete, true);
  assert.equal(invalid.totalUsageComplete, true);
  assert.equal(Compile(AdviceSchema).Check(invalid), true);
  assert.equal(manager.list()[0].turns, 1);
});

test('AC-12 unknown usage stays incomplete after exceptions, abort, timeout and late replies', async t => {
  for (const mode of ['exception', 'abort', 'timeout']) await t.test(mode, async () => {
    const manager = new Consultations({ timeoutMs: mode === 'timeout' ? 20 : 1000 });
    const first = await manager.send({ message: 'Q' }, dependencies());
    const late = deferred(), controller = new AbortController();
    const deps = dependencies(async () => { if (mode === 'exception') throw new Error('PRIVATE_ERROR'); return late.promise; });
    const pending = manager.send({ session: first.session, message: 'REJECTED' }, deps, controller.signal);
    await waitFor(() => deps.requests.length === 1);
    if (mode === 'abort') controller.abort();
    const failed = await pending;
    assert.equal(failed.usageComplete, false); assert.equal(failed.totalUsageComplete, false);
    assert.equal(failed.usage.input, 0); assert.equal(failed.totalUsage.input, 10);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_ERROR/);
    assert.equal(Compile(AdviceSchema).Check(failed), true);
    late.resolve(reply()); await new Promise(r => setImmediate(r));
    assert.equal(manager.list()[0].turns, 1); assert.equal(manager.list()[0].totalUsage.input, 10);
    const next = await manager.send({ session: first.session, message: 'NEXT' }, dependencies());
    assert.equal(next.usageComplete, true); assert.equal(next.totalUsageComplete, false);
    assert.equal(next.totalUsage.input, 20);
  });
});

test('AC-12 AC-14 cancellation during preparation has known zero usage and no late progress', async t => {
  const manager = new Consultations(), prep = deferred(), controller = new AbortController(), phases = [];
  t.after(() => { controller.abort(); prep.resolve(model); });
  let entered = false;
  const deps = dependencies(); deps.prepare = async () => { entered = true; return prep.promise; }; deps.progress = phase => phases.push(phase);
  const pending = manager.send({ message: 'Q' }, deps, controller.signal);
  await waitFor(() => entered); assert.deepEqual(phases, ['preparing']); controller.abort();
  const result = await pending;
  assert.equal(result.usageComplete, true); assert.equal(result.usage.input, 0); assert.equal(result.totalUsage, undefined);
  prep.resolve(model); await new Promise(r => setImmediate(r)); assert.equal(deps.requests.length, 0); assert.deepEqual(phases, ['preparing']);
  const thrown = await manager.send({ message: 'Q' }, dependencies(async () => { throw new Error('provider'); }));
  assert.equal(thrown.usageComplete, false); assert.equal(thrown.totalUsage, undefined); assert.deepEqual(manager.list(), []);
});

test('AC-12 busy calls do not damage the owning request accounting', async t => {
  const manager = new Consultations(), first = await manager.send({ message: 'Q' }, dependencies());
  const late = deferred(), deps = dependencies(async () => late.promise);
  t.after(() => { manager.clear(); late.resolve(reply()); });
  const pending = manager.send({ session: first.session, message: 'NEXT' }, deps);
  await waitFor(() => deps.requests.length === 1);
  const busy = await manager.send({ session: first.session, message: 'BUSY' }, dependencies());
  assert.equal(busy.usageComplete, true); assert.equal(busy.totalUsage.input, 10); assert.equal(busy.totalUsageComplete, false);
  late.resolve(reply()); const result = await pending;
  assert.equal(result.totalUsage.input, 20); assert.equal(result.totalUsageComplete, true);
});

test('AC-13 AC-29 AC-31 discovery shows committed context and independent usage snapshots, not transcripts', async () => {
  const manager = new Consultations(), raw = 'VALIDATED_ADVICE\n[CONTINUE]';
  const first = await manager.send({ message: 'Q' }, dependencies(async () => reply(raw)));
  let entry = manager.list()[0];
  assert.equal(entry.turns, 1); assert.equal(Object.hasOwn(entry, 'turnsRemaining'), false); assert.equal(entry.historyBytes, pairBytes('Q', raw));
  assert.equal(entry.contextUsage.contextWindow, 272000); assert.equal(entry.contextUsage.tokens, 13);
  assert.equal(Object.hasOwn(entry, 'historyBytesRemaining'), false);
  assert.equal(entry.totalUsage.input, 10); assert.equal(entry.totalUsageComplete, true);
  assert.equal(Compile(ListSchema).Check({ ok: true, sessions: manager.list() }), true);
  assert.doesNotMatch(JSON.stringify(entry), /VALIDATED_ADVICE|response|content/);
  entry.model.model = 'MUTATED'; entry.totalUsage.input = 999; entry.totalUsage.cost.total = 999;
  entry = manager.list()[0]; assert.deepEqual(entry.model, model); assert.equal(entry.totalUsage.input, 10);
  const late = deferred(), controller = new AbortController(), deps = dependencies(async () => late.promise);
  const pending = manager.send({ session: first.session, message: 'PENDING_PRIVATE_INPUT' }, deps, controller.signal);
  await waitFor(() => deps.requests.length === 1);
  entry = manager.list()[0]; assert.equal(entry.busy, true); assert.equal(entry.totalUsageComplete, false);
  assert.equal(entry.historyBytes, pairBytes('Q', raw)); assert.doesNotMatch(JSON.stringify(entry), /PENDING_PRIVATE_INPUT/);
  controller.abort(); await pending; late.resolve(reply()); await new Promise(r => setImmediate(r));
  assert.equal(manager.list()[0].totalUsageComplete, false);
  await manager.send({ session: first.session, message: 'BAD' }, dependencies(async () => reply('REJECTED_TEXT', { stopReason: 'length' })));
  entry = manager.list()[0]; assert.equal(entry.totalUsage.input, 20); assert.equal(entry.turns, 1);
  assert.equal(entry.historyBytes, pairBytes('Q', raw)); assert.equal(entry.totalUsageComplete, false);
  manager.close(first.session); assert.deepEqual(manager.list(), []);
  await manager.send({ message: 'Other' }, dependencies()); manager.clear(); assert.deepEqual(manager.list(), []);
});

async function toolFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-improvements-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => previous === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = previous);
  await writeFile(join(dir, 'advisor.json'), JSON.stringify({ model }));
  const tools = new Map(); extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  const ctx = { cwd: dir, mode: 'tui', hasUI: true, isProjectTrusted: () => false, modelRegistry: {
    find: (provider, id) => ({ provider, id, api: 'mock-api', contextWindow: 272000 }), hasConfiguredAuth: () => true,
    streamSimple: () => ({ result: async () => reply() })
  } };
  return { tools, ctx, dir };
}
function coherent(tool, result) {
  assert.equal(Compile(tool.outputSchema).Check(result.structuredContent), true);
  assert.deepEqual(result.details, result.structuredContent);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  return result.details;
}
const renderContext = { args: {}, toolCallId: 'test', invalidate() {}, state: {}, cwd: '.', lastComponent: undefined };
function rendered(component, width) {
  const lines = component.render(width);
  assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at width ${width}`);
  // truncateToWidth adds its own SGR reset at width 1. No other controls are allowed with these plain mock themes.
  assert.ok(lines.every(line => !/[\x00-\x1f\x7f-\x9f]/u.test(line.replace(/\x1b\[0m/g, ''))), 'data controls must not reach terminal');
  return lines.join('\n');
}

test('AC-14 AC-19 AC-30 AC-31 registered renderers show questions, previews, full expansion, metadata and safe fallback', async t => {
  const f = await toolFixture(t), tool = f.tools.get('advisor');
  for (const item of f.tools.values()) { assert.equal(typeof item.renderCall, 'function'); assert.equal(typeof item.renderResult, 'function'); }
  let color = 'A'; const theme = { fg: (_key, text) => `${color}${text}`, bold: text => text };
  const response = '界😀\x1b[31m\x07 advice\n' + 'LONG_LINE '.repeat(100) + '\nEND_OF_FULL_ADVICE';
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply(response) });
  const result = await tool.execute('one', { message: 'PRIVATE_INPUT' }, undefined, undefined, f.ctx);
  const data = coherent(tool, result); assert.equal(data.response, response);
  const compact = tool.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, renderContext);
  assert.match(rendered(compact, 80), /Advisory/); assert.doesNotMatch(rendered(compact, 80), /END_OF_FULL_ADVICE/);
  assert.match(rendered(compact, 80), /Expand for full advice/);
  assert.match(rendered(expanded, 80), /END_OF_FULL_ADVICE/); assert.match(rendered(expanded, 80), /mock\/chat/);
  assert.match(rendered(expanded, 80), /reported/);
  for (const width of [1, 8, 30, 80]) { rendered(compact, width); rendered(expanded, width); }
  color = 'B'; compact.invalidate(); assert.match(rendered(compact, 80), /^B/);
  const call = tool.renderCall({ message: 'PRIVATE_INPUT\x1b', session: data.session }, theme, renderContext);
  assert.match(rendered(call, 80), /PRIVATE_INPUT/);
  const fallback = tool.renderResult({ content: [{ type: 'text', text: 'SECRET_RAW_ERROR' }], details: undefined }, { expanded: true, isPartial: false }, theme, renderContext);
  assert.doesNotMatch(rendered(fallback, 80), /SECRET_RAW_ERROR/);
  const listTool = f.tools.get('advisor_sessions'), list = await listTool.execute('list', {}, undefined, undefined, f.ctx);
  coherent(listTool, list);
  const listView = listTool.renderResult(list, { expanded: true, isPartial: false }, theme, renderContext);
  assert.match(rendered(listView, 80), /1 exchanges/); assert.doesNotMatch(rendered(listView, 80), /END_OF_FULL_ADVICE/);
  const closeTool = f.tools.get('advisor_close'), closed = await closeTool.execute('close', { session: data.session }, undefined, undefined, f.ctx);
  const closeView = closeTool.renderResult(closed, { expanded: false, isPartial: false }, theme, renderContext);
  coherent(closeTool, closed); assert.match(rendered(closeView, 80), /closed/i);
  const partial = tool.renderResult({ details: { phase: 'waiting', response: 'UNVALIDATED_ADVICE' } }, { expanded: true, isPartial: true }, theme, renderContext);
  assert.doesNotMatch(rendered(partial, 80), /UNVALIDATED_ADVICE/);
  for (const width of [1, 8, 30, 80]) { rendered(listView, width); rendered(closeView, width); rendered(fallback, width); rendered(partial, width); }
  for (const item of f.tools.values()) for (const width of [1, 8, 30, 80]) rendered(item.renderCall({ session: '\x1b\x07界😀' }, theme, renderContext), width);
});

test('AC-14 AC-31 progress is phase-only, callback failures cannot change outcomes, and no late updates occur', async t => {
  const f = await toolFixture(t), tool = f.tools.get('advisor'), late = deferred(), updates = [], controller = new AbortController();
  let requested = false;
  f.ctx.modelRegistry.streamSimple = () => { requested = true; return { result: async () => late.promise }; };
  t.after(() => { controller.abort(); late.resolve(reply()); });
  const pending = tool.execute('pending', { message: 'PRIVATE_INPUT' }, controller.signal, update => updates.push(update), f.ctx);
  await waitFor(() => requested);
  assert.deepEqual(updates.map(update => update.details.phase), ['preparing', 'waiting']);
  for (const update of updates) {
    assert.deepEqual(Object.keys(update.details), ['phase']); assert.equal(update.usage, undefined);
    assert.doesNotMatch(JSON.stringify(update), /PRIVATE_INPUT|Investigate|thinking/);
    const theme = { fg: (_key, text) => text, bold: text => text };
    assert.match(rendered(tool.renderResult(update, { expanded: false, isPartial: true }, theme, renderContext), 80), /preparing|waiting/i);
  }
  controller.abort(); const result = await pending; coherent(tool, result);
  late.resolve(reply()); await new Promise(r => setImmediate(r)); assert.equal(updates.length, 2);
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply() });
  const good = await tool.execute('throws', { message: 'Q' }, undefined, () => { throw new Error('DISPLAY_ERROR'); }, f.ctx);
  assert.equal(coherent(tool, good).ok, true);
  const none = [];
  await tool.execute('bad', { message: '' }, undefined, update => none.push(update), f.ctx);
  assert.deepEqual(none, []);
  const continuation = [];
  await tool.execute('next', { session: good.details.session, message: 'NEXT' }, undefined, update => continuation.push(update), f.ctx);
  assert.deepEqual(continuation.map(update => update.details.phase), ['waiting']);
  const exhausted = [];
  const limited = await tool.execute('full', { session: good.details.session, message: 'x'.repeat(272000 * 4) }, undefined, update => exhausted.push(update), f.ctx);
  assert.equal(coherent(tool, limited).error.limit.resource, 'context-tokens'); assert.deepEqual(exhausted, []);
});

test('AC-14 AC-31 failure views label unknown usage and show resource-specific recovery without raw errors', async t => {
  const f = await toolFixture(t), tool = f.tools.get('advisor');
  assert.equal(typeof tool.renderResult, 'function');
  const theme = { fg: (_key, text) => text, bold: text => text };
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => { throw new Error('SECRET_PROVIDER_ERROR'); } });
  const failed = await tool.execute('failed', { message: 'Q' }, undefined, undefined, f.ctx);
  coherent(tool, failed);
  const view = tool.renderResult(failed, { expanded: true, isPartial: false }, theme, renderContext);
  assert.match(rendered(view, 80), /incomplete/i); assert.doesNotMatch(rendered(view, 80), /SECRET_PROVIDER_ERROR/);
  const limited = await tool.execute('limited', { message: 'x'.repeat(272000 * 4) }, undefined, undefined, f.ctx);
  coherent(tool, limited);
  const limitView = tool.renderResult(limited, { expanded: false, isPartial: false }, theme, renderContext);
  assert.match(rendered(limitView, 80), /context-tokens/); assert.match(rendered(limitView, 80), /new consultation with an\s+explicit summary/i);
  for (const width of [1, 8, 30, 80]) { rendered(view, width); rendered(limitView, width); }
});

test('AC-15 opt-in live procedure has authorization, bounded calls, failure stop and reporting', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const procedure = readme.split('## Opt-in live verification')[1];
  assert.ok(procedure, 'live verification procedure must exist');
  for (const expected of [/separate spending authorization/i, /designated physical model/i, /two requests/i, /no automatic retries/i, /stop.*failure/i, /monetary cap/i, /nonsecret/i, /pinned/i, /usageComplete/, /advisor_close/, /Pi.*Node.*versions/i, /offline.*provider/i]) assert.match(procedure, expected);
});
