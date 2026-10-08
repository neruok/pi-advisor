import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { visibleWidth } from '@earendil-works/pi-tui';
import { estimateTokens, calculateContextTokens } from '@earendil-works/pi-coding-agent';
import extension from '../advisor.ts';
import { Consultations } from '../lib/session.ts';
import { zeroUsage } from '../lib/protocol.ts';
import { ADVISOR_PROMPT } from '../lib/prompt.ts';
import { AdviceSchema, ListSchema } from '../lib/schemas.ts';
import { dependencies, reply, usage } from './helpers.mjs';

const theme = { fg: (_key, text) => text, bold: text => text };
const normalized = text => text.replace(/\x1b\[0m/g, '').replace(/\s/gu, '');
const pendingTokens = message => estimateTokens({ role: 'system', content: ADVISOR_PROMPT, toolsAdded: [], timestamp: 0 }) + estimateTokens({ role: 'user', content: message, timestamp: 0 });
function depsWithWindow(window, complete) { const deps = dependencies(complete); deps.getContextWindow = () => window; return deps; }
function view(tool, result, expanded = false, width = 160, isPartial = false) {
  const lines = tool.renderResult(result, { expanded, isPartial }, theme).render(width);
  assert.ok(lines.every(line => visibleWidth(line) <= width)); return lines.join('\n');
}
async function fixture(t, initialWindow = 272000) {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-context-display-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => old === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = old);
  await writeFile(join(dir, 'advisor.json'), JSON.stringify({ model: { provider: 'mock', model: 'chat' } }));
  const tools = new Map(), effects = [], requests = [], state = { window: initialWindow, response: reply() };
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {}, sendMessage: (...args) => effects.push(args), appendEntry: (...args) => effects.push(args) });
  const ctx = { cwd: dir, hasUI: true, mode: 'tui', isProjectTrusted: () => false, model: { contextWindow: 32 },
    getContextUsage: () => { assert.fail('parent context is forbidden'); }, modelRegistry: {
      find: (provider, id) => ({ provider, id, api: 'mock-api', contextWindow: state.window }), hasConfiguredAuth: () => true,
      streamSimple: (_model, context, options) => { requests.push({ context, options }); return { result: async () => state.response }; }
    } };
  const send = args => tools.get('advisor').execute('test', args, undefined, undefined, ctx);
  return { tools, effects, requests, state, send, ctx };
}

test('AC-30 changed: call view shows the full sanitized question without changing dispatched input', async t => {
  const f = await fixture(t), message = 'FIRST_LINE é界😀\n' + 'question '.repeat(50) + '\nQUESTION_TAIL\x1b\x07';
  const tool = f.tools.get('advisor'), call = tool.renderCall({ message }, theme);
  for (const width of [8, 30, 80, 160]) {
    const lines = call.render(width); assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(normalized(lines.join('\n')).includes('FIRST_LINE'));
    assert.ok(normalized(lines.join('\n')).includes('QUESTION_TAIL'));
    for (const line of lines) assert.doesNotMatch(line.replace(/\x1b\[0m/g, ''), /[\x00-\x1f\x7f-\x9f]/u);
  }
  const result = await f.send({ message }); assert.equal(result.details.ok, true);
  assert.equal(f.requests[0].context.messages.at(-1).content, message); assert.deepEqual(f.effects, []);
});

test('AC-29 changed: advisor model registry supplies and pins the context window independently of parent state', async t => {
  const f = await fixture(t), first = await f.send({ message: 'Q' }); assert.equal(first.details.ok, true);
  assert.ok(first.details.contextUsage, 'advisor context metadata must exist');
  assert.equal(first.details.contextUsage.contextWindow, 272000);
  f.state.window = 64000;
  const next = await f.send({ session: first.details.session, message: 'Next' });
  assert.equal(next.details.contextUsage.contextWindow, 272000);
  const fresh = await f.send({ message: 'Fresh' }); assert.equal(fresh.details.contextUsage.contextWindow, 64000);
  assert.equal(first.details.contextUsage.tokens, calculateContextTokens(usage));
});

test('AC-29 changed: invalid or absent model windows fail before generation', async t => {
  const f = await fixture(t);
  for (const window of [undefined, 0, -1, 1.5, Infinity, NaN]) {
    f.state.window = window;
    const result = await f.send({ message: 'Q' }); assert.equal(result.isError, true);
    assert.equal(result.details.error.code, 'model-unavailable'); assert.equal(f.requests.length, 0);
  }
});

test('AC-29 changed: large opaque replay supports several pairs using reported model tokens, not ciphertext bytes', async () => {
  let turn = 0;
  const deps = depsWithWindow(272000, async () => {
    turn++;
    return reply('Public.', { api: 'openai-responses', usage: { ...usage, totalTokens: 6000 + turn }, content: [
      { type: 'thinking', thinking: 'NEVER_RETAIN', thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_fixture', encrypted_content: 'x'.repeat(60000), summary: [] }) },
      { type: 'text', text: 'Public.' }
    ] });
  });
  const manager = new Consultations(), first = await manager.send({ message: 'Q' }, deps); assert.equal(first.ok, true);
  for (let i = 0; i < 3; i++) assert.equal((await manager.send({ session: first.session, message: 'Next' }, deps)).ok, true);
  const entry = manager.list()[0]; assert.equal(entry.turns, 4); assert.ok(entry.historyBytes > 49152);
  assert.equal(entry.contextUsage.tokens, 6004); assert.equal(entry.contextUsage.percent, 6004 / 272000 * 100);
  assert.doesNotMatch(JSON.stringify(entry), /NEVER_RETAIN|encrypted_content|thinkingSignature/);
});

test('AC-29 changed: output-reserved preflight passes equality and rejects one token over without dispatch', async () => {
  const message = 'Q', exact = pendingTokens(message) + 4096;
  const good = depsWithWindow(exact), bad = depsWithWindow(exact - 1);
  assert.equal((await new Consultations().send({ message }, good)).ok, true);
  const failed = await new Consultations().send({ message }, bad);
  assert.equal(failed.ok, false); assert.deepEqual(failed.error.limit, { resource: 'context-tokens', maximum: exact - 1, actual: exact });
  assert.equal(bad.requests.length, 0); assert.equal(failed.usageComplete, true);
});

test('AC-29 changed: committed context boundary is inclusive and overflow preserves prior context with known usage', async () => {
  const complete = async () => reply('A', { usage: { ...usage, totalTokens: 5000 } });
  const first = await new Consultations().send({ message: 'Q' }, depsWithWindow(5000, complete)); assert.equal(first.ok, true);
  assert.ok(first.contextUsage); assert.equal(first.contextUsage.percent, 100);
  const tooSmall = new Consultations(), rejected = await tooSmall.send({ message: 'Q' }, depsWithWindow(4999, complete));
  assert.equal(rejected.ok, false); assert.deepEqual(rejected.error.limit, { resource: 'context-tokens', maximum: 4999, actual: 5000 });
  assert.equal(rejected.usageComplete, true); assert.deepEqual(tooSmall.list(), []);
  const manager = new Consultations(), good = await manager.send({ message: 'Q' }, depsWithWindow(10000));
  const bad = await manager.send({ session: good.session, message: 'Rejected' }, depsWithWindow(1, async () => reply('BAD', { usage: { ...usage, totalTokens: 10001 } })));
  assert.equal(bad.ok, false); assert.equal(bad.error.limit.resource, 'context-tokens');
  assert.deepEqual(bad.contextUsage, good.contextUsage); assert.equal(manager.list()[0].turns, 1);
  assert.equal(bad.totalUsage.input, 20); assert.equal(bad.usageComplete, true);
});

test('AC-29 changed: context measurement follows Pi usage fallback and visible-message estimates', async () => {
  const fallbackUsage = { ...usage, totalTokens: 0 };
  const result = await new Consultations().send({ message: 'Q' }, depsWithWindow(272000, async () => reply('A', { usage: fallbackUsage })));
  assert.ok(result.contextUsage); assert.equal(result.contextUsage.tokens, 13);
  const raw = reply('A', { usage: zeroUsage() }), deps = depsWithWindow(272000, async () => raw);
  const zero = await new Consultations().send({ message: 'Q' }, deps);
  assert.equal(zero.contextUsage.tokens, pendingTokens('Q') + estimateTokens(raw));
});

test('AC-29 changed: context snapshots and schemas exclude byte-remaining capacity and arbitrary fields', async () => {
  const manager = new Consultations(), first = await manager.send({ message: 'Q' }, depsWithWindow(272000));
  assert.ok(first.contextUsage); assert.equal(Compile(AdviceSchema).Check(first), true);
  const entry = manager.list()[0]; assert.ok(entry.contextUsage); assert.equal(Object.hasOwn(entry, 'historyBytesRemaining'), false);
  assert.equal(Compile(ListSchema).Check({ ok: true, sessions: [entry] }), true);
  assert.equal(Compile(ListSchema).Check({ ok: true, sessions: [{ ...entry, historyBytesRemaining: 1 }] }), false);
  assert.equal(Compile(AdviceSchema).Check({ ...first, contextUsage: { ...first.contextUsage, arbitrary: 'NO' } }), false);
  first.contextUsage.tokens = 999999; entry.contextUsage.contextWindow = 1;
  assert.equal(manager.list()[0].contextUsage.contextWindow, 272000); assert.equal(manager.list()[0].contextUsage.tokens, 13);
});

test('AC-30 changed: usage line matches Pi totals, latest-call CH, and advisor context in both views', async t => {
  const f = await fixture(t, 20000), tool = f.tools.get('advisor');
  f.state.response = reply('First.', { usage: { ...usage, input: 1000, output: 200, cacheRead: 4000, totalTokens: 5200 } });
  const first = await f.send({ message: 'Q' }); assert.equal(first.details.ok, true);
  f.state.response = reply('Second.', { usage: { ...usage, input: 2000, output: 300, cacheRead: 6000, cacheWrite: 2000, totalTokens: 10300, cost: { ...usage.cost, total: .025 } } });
  const second = await f.send({ session: first.details.session, message: 'Next' }); assert.equal(second.details.ok, true);
  const expected = '↑3.0k ↓500 R10k W2.0k CH60.0% $0.038 51.5%/20k';
  for (const expanded of [false, true]) assert.ok(view(tool, second, expanded).includes(expected));
  assert.doesNotMatch(view(tool, second), /\(sub\)|\(auto\)/);
  const large = structuredClone(second);
  large.details.totalUsage = { ...large.details.totalUsage, input: 448000, output: 61000, cacheRead: 14000000, cacheWrite: 0, cost: { ...usage.cost, total: 2.845 } };
  large.details.contextUsage = { tokens: 100640, contextWindow: 272000, percent: 37 };
  assert.match(view(tool, large), /↑448k ↓61k R14M CH60\.0% \$2\.845 37\.0%\/272k/);
  const list = await f.tools.get('advisor_sessions').execute('list', {}, undefined, undefined, f.ctx);
  const listing = view(f.tools.get('advisor_sessions'), list, true);
  assert.match(listing, /51\.5%\/20k advisor context/); assert.doesNotMatch(listing, /history bytes remaining/);
  for (const width of [1, 8, 30, 80, 160]) for (const expanded of [false, true]) view(tool, second, expanded, width);
});

test('AC-30 changed: incomplete, zero-denominator, historic and cumulative failure views remain truthful', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor'), first = await f.send({ message: 'Q' });
  const historic = structuredClone(first); delete historic.details.contextUsage;
  assert.match(view(tool, historic), /\?\/\?/);
  const incomplete = structuredClone(first); incomplete.details.usageComplete = false; incomplete.details.totalUsageComplete = false;
  assert.match(view(tool, incomplete), /CH\?/); assert.match(view(tool, incomplete), /incomplete/i);
  const empty = structuredClone(first); empty.details.usage = zeroUsage(); assert.match(view(tool, empty), /CH\?/);
  f.state.response = reply('UNCHECKED', { stopReason: 'length' });
  const failed = await f.send({ session: first.details.session, message: 'Bad' });
  assert.match(view(tool, failed), /↑20 ↓4 R2 CH9\.1% \$0\.026/);
  assert.doesNotMatch(view(tool, failed), /UNCHECKED/);
});

test('AC-30 preserved: display has no side effects and still hides private and partial response state', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor'), result = await f.send({ message: 'Q' });
  const snapshot = structuredClone(result), requests = f.requests.length;
  for (const width of [1, 8, 30, 80, 160]) for (const expanded of [false, true]) {
    view(tool, result, expanded, width);
    assert.doesNotMatch(view(tool, { details: { phase: 'waiting', response: 'PRIVATE_PARTIAL', replay: 'OPAQUE_PRIVATE' } }, expanded, width, true), /PRIVATE_PARTIAL|OPAQUE_PRIVATE/);
  }
  assert.deepEqual(result, snapshot); assert.equal(f.requests.length, requests); assert.deepEqual(f.effects, []);
});

test('AC-30 changed: README describes questions, registry context and latest-call CH', async () => {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const phrase of ['main agent’s message', 'contextWindow', 'latest call', 'CH', 'no fixed history-byte cap', '4096 output tokens']) assert.ok(text.includes(phrase), phrase);
});
