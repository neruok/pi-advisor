import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Compile } from 'typebox/compile';
import { visibleWidth } from '@earendil-works/pi-tui';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { Consultations } from '../lib/session.ts';
import { ADVISOR_PROMPT } from '../lib/prompt.ts';
import { AdviceSchema, ListSchema } from '../lib/schemas.ts';
import { toolRenderers } from '../lib/render.ts';
import { zeroUsage } from '../lib/protocol.ts';
import { dependencies, deferred, waitFor, reply, usage } from './helpers.mjs';

const theme = { fg: (_key, text) => text, bold: text => text };
const pendingTokens = message => estimateTokens({ role: 'system', content: ADVISOR_PROMPT, toolsAdded: [], timestamp: 0 }) + estimateTokens({ role: 'user', content: message, timestamp: 0 });

test('AC-31 changed: messages and replies above 16 KiB commit unchanged within the model window', async () => {
  const message = 'é😀'.repeat(4000) + '\nINPUT_TAIL', response = '界é'.repeat(4000) + '\nREPLY_TAIL';
  assert.ok(Buffer.byteLength(message) > 16384); assert.ok(Buffer.byteLength(response) > 16384);
  const manager = new Consultations(), deps = dependencies(async () => reply(response, { usage: zeroUsage() }));
  const first = await manager.send({ message }, deps);
  assert.equal(first.ok, true); assert.equal(first.response, response);
  assert.equal(deps.requests[0].context.messages.at(-1).content, message);
  const next = await manager.send({ session: first.session, message: 'Continue' }, deps);
  assert.equal(next.ok, true);
  assert.equal(deps.requests[1].context.messages[1].content, message);
  assert.equal(deps.requests[1].context.messages[2].content[0].text, response);
  assert.equal(next.contextUsage.contextWindow, 272000);
  assert.ok(next.contextUsage.tokens <= 272000);
});

test('AC-31 changed: replies above 16 KiB are not rejected after a short input', async () => {
  const response = 'é'.repeat(9000) + '\nREPLY_TAIL';
  const manager = new Consultations(), deps = dependencies(async () => reply(response, { usage: zeroUsage() }));
  const result = await manager.send({ message: 'Q' }, deps);
  assert.equal(deps.requests.length, 1); assert.equal(result.ok, true); assert.equal(result.response, response);
  assert.equal(manager.list()[0].turns, 1);
});

test('AC-31 changed: nine active consultations remain independent without eviction', async () => {
  const manager = new Consultations(), deps = dependencies(), sessions = [];
  for (let i = 0; i < 9; i++) {
    const result = await manager.send({ message: `ISSUE_${i}` }, deps);
    assert.equal(result.ok, true, `consultation ${i + 1} must succeed`); sessions.push(result.session);
  }
  assert.equal(new Set(sessions).size, 9);
  assert.deepEqual(manager.list().map(entry => entry.session), sessions);
  assert.equal((await manager.send({ session: sessions[0], message: 'More evidence' }, deps)).ok, true);
  const text = JSON.stringify(deps.requests.at(-1).context);
  assert.match(text, /ISSUE_0/); assert.doesNotMatch(text, /ISSUE_[1-8]/);
  assert.equal(manager.close(sessions[8]).ok, true); assert.equal(manager.list().length, 8);
  manager.clear(); assert.deepEqual(manager.list(), []);
});

test('AC-31 changed: pending creation does not impose an eight-session cap', async t => {
  const manager = new Consultations(), late = deferred(), deps = dependencies(async () => late.promise);
  t.after(() => { manager.clear(); late.resolve(reply()); });
  const pending = Array.from({ length: 9 }, (_, i) => manager.send({ message: `PENDING_${i}` }, deps));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deps.requests.length, 9);
  assert.equal(manager.list().length, 9); assert.ok(manager.list().every(entry => entry.busy));
  late.resolve(reply()); const results = await Promise.all(pending);
  assert.ok(results.every(result => result.ok)); assert.equal(new Set(results.map(result => result.session)).size, 9);
});

test('AC-31 changed: twenty-five exchanges retain the complete consultation prefix', async () => {
  const manager = new Consultations(), deps = dependencies(), first = await manager.send({ message: 'TURN_1' }, deps);
  for (let turn = 2; turn <= 25; turn++) {
    const result = await manager.send({ session: first.session, message: `TURN_${turn}` }, deps);
    assert.equal(result.ok, true, `exchange ${turn} must succeed`); assert.equal(result.turns, turn);
  }
  assert.equal(deps.requests.length, 25); assert.equal(deps.requests.at(-1).context.messages.length, 50);
  assert.equal(deps.requests.at(-1).context.messages[1].content, 'TURN_1');
  assert.equal(deps.requests.at(-1).context.messages.at(-1).content, 'TURN_25');
  const entry = manager.list()[0]; assert.equal(entry.turns, 25); assert.equal(entry.totalUsage.input, 250);
  assert.equal(Object.hasOwn(entry, 'turnsRemaining'), false);
});

test('AC-31 changed: every provider delegates output allowance without maxTokens', async () => {
  for (const provider of ['mock', 'xai', 'openai', 'anthropic', 'openai-codex', 'custom']) {
    const manager = new Consultations(), deps = dependencies();
    deps.prepare = async () => ({ provider, model: 'chat', reasoning: 'high' });
    const first = await manager.send({ message: 'Q' }, deps);
    assert.equal(first.ok, true);
    assert.equal((await manager.send({ session: first.session, message: 'Next' }, deps)).ok, true);
    for (const request of deps.requests) {
      assert.equal(Object.hasOwn(request.options, 'maxTokens'), false, provider);
      assert.equal(Object.hasOwn(request.options, 'toolChoice'), false);
      assert.equal(request.options.maxRetries, 0); assert.equal(request.options.reasoning, 'high');
      assert.equal(request.options.cacheRetention, 'short'); assert.equal(request.options.sessionId, first.session);
      assert.ok(Number.isInteger(request.options.timeoutMs) && request.options.timeoutMs > 0);
      assert.ok(request.options.signal instanceof AbortSignal); assert.deepEqual(request.context.messages[0].toolsAdded, []);
    }
  }
});

function successResponse() {
  const item = { type: 'message', id: 'msg_offline', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Offline advice.', annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_offline' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Offline advice.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_offline', status: 'completed', output: [item], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } }
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('AC-31 changed: installed Responses adapter uses model output allowance above 4096', async () => {
  const model = OPENAI_MODELS['gpt-4.1'], payloads = [];
  assert.ok(model.maxTokens > 4096);
  const deps = { prepare: async () => ({ provider: model.provider, model: model.id }), getContextWindow: () => model.contextWindow,
    complete: async (_pair, context, options) => streamSimple(model, context, { ...options, apiKey: 'sk-offline-not-a-real-key', fetch: async (_url, request) => {
      payloads.push(JSON.parse(request.body)); return successResponse();
    } }).result() };
  const manager = new Consultations(), first = await manager.send({ message: 'Q' }, deps);
  assert.equal(first.ok, true);
  assert.equal((await manager.send({ session: first.session, message: 'Next' }, deps)).ok, true);
  assert.equal(payloads.length, 2);
  for (const payload of payloads) assert.equal(payload.max_output_tokens, model.maxTokens);
});

test('AC-31 changed: pending context equality dispatches without a fixed reserve and one-token overflow rejects', async () => {
  const message = 'Q', exact = pendingTokens(message);
  const good = dependencies(); good.getContextWindow = () => exact;
  assert.equal((await new Consultations().send({ message }, good)).ok, true); assert.equal(good.requests.length, 1);
  const bad = dependencies(); bad.getContextWindow = () => exact - 1;
  const manager = new Consultations(), failed = await manager.send({ message }, bad);
  assert.equal(failed.ok, false); assert.deepEqual(failed.error.limit, { resource: 'context-tokens', maximum: exact - 1, actual: exact });
  assert.equal(bad.requests.length, 0); assert.equal(failed.usageComplete, true); assert.deepEqual(manager.list(), []);
});

test('AC-31 changed: schemas allow former count overflows without turnsRemaining or removed resources', async () => {
  const manager = new Consultations(), first = await manager.send({ message: 'Q' }, dependencies());
  const advice = Compile(AdviceSchema), list = Compile(ListSchema), entry = manager.list()[0];
  assert.equal(advice.Check({ ...first, turns: 25 }), true);
  delete entry.turnsRemaining;
  const entries = Array.from({ length: 9 }, (_, i) => ({ ...entry, session: `adv_schema_${i}`, turns: 25 }));
  assert.equal(list.Check({ ok: true, sessions: entries }), true);
  assert.equal(list.Check({ ok: true, sessions: [{ ...entry, turnsRemaining: 1 }] }), false);
  assert.equal(advice.Check({ ...first, arbitrary: true }), false);
  assert.equal(list.Check({ ok: true, sessions: [{ ...entry, arbitrary: true }] }), false);
  for (const resource of ['input-bytes', 'reply-bytes', 'turns', 'sessions']) {
    assert.equal(advice.Check({ ok: false, error: { code: 'limit-exceeded', message: 'Limit.', limit: { resource, maximum: 1, actual: 2 } }, usage: zeroUsage(), usageComplete: true }), false);
  }
});

test('AC-31 changed: discovery renders every consultation and committed turns in both views', () => {
  const sessions = Array.from({ length: 9 }, (_, i) => ({ session: `adv_render_${i}`, label: `Issue ${i}`, turns: i + 25, model: { provider: 'mock', model: 'chat' }, busy: false,
    totalUsage: usage, totalUsageComplete: true, historyBytes: 100, contextUsage: { tokens: 13, contextWindow: 272000, percent: 13 / 272000 * 100 } }));
  const renderer = toolRenderers('advisor_sessions');
  for (const expanded of [false, true]) for (const width of [1, 8, 30, 80, 160]) {
    const lines = renderer.renderResult({ details: { ok: true, sessions } }, { expanded, isPartial: false }, theme).render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const text = lines.join('\n').replace(/\x1b\[0m/g, '').replace(/\s/gu, '');
    for (const entry of sessions) assert.ok(text.includes(entry.session), `missing ${entry.session}`);
    assert.ok(text.includes('33exchanges')); assert.doesNotMatch(text, /remaining|undefined/);
  }
});

test('AC-31 changed: README documents removed caps and retained context and timeout', async () => {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(text, /no fixed.*consultation.*exchange.*message.*reply/i);
  assert.match(text, /omit.*`maxTokens`/); assert.match(text, /no fixed output reserve/);
  assert.match(text, /contextWindow/); assert.match(text, /300000/); assert.match(text, /No monetary cap/);
  assert.doesNotMatch(text, /8 active consultations|24 successful|16384 UTF-8 bytes per user|turnsRemaining/);
});

test('AC-32 preserved: context overflow, malformed replies and cancelled late work remain atomic and private', async t => {
  const opaque = JSON.stringify({ type: 'reasoning', id: 'rs_offline', encrypted_content: 'SYNTHETIC_OPAQUE', summary: [] });
  const manager = new Consultations(), deps = dependencies(async () => reply('A', { api: 'openai-responses', content: [
    { type: 'thinking', thinking: 'PRIVATE_THINKING', thinkingSignature: opaque }, { type: 'text', text: 'A' }
  ] }));
  deps.getContextWindow = () => 10000;
  const first = await manager.send({ message: 'Q' }, deps); assert.equal(first.ok, true);
  const failed = await manager.send({ session: first.session, message: 'OVERFLOW' }, dependencies(async () => reply('REJECTED', { usage: { ...usage, totalTokens: 10001 } })));
  assert.equal(failed.error.limit.resource, 'context-tokens'); assert.deepEqual(failed.contextUsage, first.contextUsage);
  assert.equal(failed.usageComplete, true); assert.equal(failed.totalUsage.input, 20); assert.equal(manager.list()[0].turns, 1);
  const invalid = await manager.send({ session: first.session, message: 'MALFORMED' }, dependencies(async () => reply('REJECTED', { stopReason: 'length' })));
  assert.equal(invalid.error.code, 'invalid-response'); assert.equal(invalid.totalUsage.input, 30);
  const nextDeps = dependencies(); await manager.send({ session: first.session, message: 'GOOD' }, nextDeps);
  const context = JSON.stringify(nextDeps.requests[0].context);
  assert.match(context, /SYNTHETIC_OPAQUE/); assert.doesNotMatch(context, /PRIVATE_THINKING|OVERFLOW|MALFORMED|REJECTED/);
  assert.doesNotMatch(JSON.stringify(manager.list()), /SYNTHETIC_OPAQUE|PRIVATE_THINKING/);
  const late = deferred(), controller = new AbortController(), cancelledDeps = dependencies(async () => late.promise);
  t.after(() => { controller.abort(); manager.clear(); late.resolve(reply()); });
  const pending = manager.send({ message: 'CANCELLED' }, cancelledDeps, controller.signal);
  await waitFor(() => cancelledDeps.requests.length === 1); controller.abort();
  assert.equal((await pending).error.code, 'cancelled'); late.resolve(reply()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.list().length, 1); assert.equal(manager.list()[0].turns, 2);
});
