import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { streamSimple as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { convertMessages as googleMessages } from '@earendil-works/pi-ai/api/google-shared';
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { Consultations } from '../lib/session.ts';
import { dependencies, reply, deferred, waitFor } from './helpers.mjs';

const api = 'openai-responses';
const cipher = 'SYNTHETIC_CIPHERTEXT';
const reason = (encrypted_content = cipher) => ({ type: 'reasoning', id: 'rs_fixture', encrypted_content, summary: [], status: 'completed' });
const signedReply = (encrypted_content = cipher, patch = {}) => reply('Visible advice.', { api, content: [
  { type: 'thinking', thinking: 'UNRETAINED_THINKING', thinkingSignature: JSON.stringify({ ...reason(encrypted_content), summary: [{ type: 'summary_text', text: 'UNRETAINED_SUMMARY' }], content: [{ type: 'reasoning_text', text: 'UNRETAINED_REASONING' }], arbitrary: 'UNRETAINED_EXTRA' }) },
  { type: 'text', text: 'Visible advice.', textSignature: JSON.stringify({ v: 1, id: 'msg_fixture', phase: 'final_answer', arbitrary: 'UNRETAINED_EXTRA' }) }
], ...patch });
const reasonIn = context => context.messages.filter(m => m.role === 'assistant').flatMap(m => m.content).filter(b => b.type === 'thinking');
const assertPrivate = value => assert.doesNotMatch(JSON.stringify(value), /UNRETAINED_|SYNTHETIC_CIPHERTEXT/);
function sse(events, named = false) {
  return new Response(events.map(e => `${named ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function responsesSse() {
  const r = { ...reason(), summary: [{ type: 'summary_text', text: 'UNRETAINED_SUMMARY' }] };
  const texts = ['First block.', 'Second block.'].map((text, i) => ({ type: 'message', id: `msg_fixture_${i}`, role: 'assistant', status: 'completed', phase: i ? 'final_answer' : 'commentary', content: [{ type: 'output_text', text, annotations: [] }] }));
  return sse([
    { type: 'response.created', response: { id: 'resp_not_retained' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...r, summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: r },
    ...texts.flatMap((item, i) => [
      { type: 'response.output_item.added', output_index: i + 1, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: i + 1, content_index: 0, delta: item.content[0].text },
      { type: 'response.output_item.done', output_index: i + 1, item }
    ]),
    { type: 'response.completed', response: { id: 'resp_not_retained', status: 'completed', output: [r, ...texts], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } }
  ]);
}

test('AC-28 changed: real Grok adapter replays ciphertext and original text IDs without storage or plaintext', async () => {
  const model = XAI_MODELS['grok-4.7'], manager = new Consultations(), requests = [];
  const deps = { prepare: async () => ({ provider: model.provider, model: model.id }), getContextWindow: () => model.contextWindow, complete: async (_pair, context, options) => streamSimple(model, context, {
    ...options, apiKey: 'sk-offline-placeholder-not-a-real-key', fetch: async (_url, request) => { requests.push(JSON.parse(request.body)); return responsesSse(); }
  }).result() };
  const first = await manager.send({ message: 'First' }, deps); assert.equal(first.ok, true);
  assert.equal(first.response, 'First block.\nSecond block.'); assertPrivate(first);
  const next = await manager.send({ session: first.session, message: 'Second' }, deps); assert.equal(next.ok, true);
  assert.deepEqual(requests[1].input.filter(item => item.type === 'reasoning'), [reason()]);
  const messages = requests[1].input.filter(item => item.type === 'message');
  assert.deepEqual(messages.map(item => [item.id, item.phase, item.content[0].text]), [['msg_fixture_0', 'commentary', 'First block.'], ['msg_fixture_1', 'final_answer', 'Second block.']]);
  for (const payload of requests) {
    assert.equal(payload.prompt_cache_key, first.session); assert.equal(payload.store, false);
    assert.equal(Object.hasOwn(payload, 'previous_response_id'), false);
    assert.doesNotMatch(JSON.stringify(payload), /UNRETAINED_|resp_not_retained/);
  }
  assertPrivate(next); assertPrivate(manager.list());
});

test('AC-28 changed: all supported APIs preserve only their opaque replay format', async () => {
  for (const api of ['openai-responses', 'openai-codex-responses', 'azure-openai-responses', 'google-generative-ai', 'google-vertex', 'anthropic-messages', 'bedrock-converse-stream']) {
    const responses = api.includes('responses'), google = api.startsWith('google');
    const signature = responses ? JSON.stringify(reason()) : 'YWJjZA==';
    const content = [
      { type: 'thinking', thinking: 'UNRETAINED_THINKING', thinkingSignature: signature, ...(!responses && !google ? { redacted: true } : {}) },
      { type: 'text', text: '', ...(google ? { textSignature: 'ZWZnaA==' } : {}) },
      { type: 'text', text: 'Public.' }
    ];
    const deps = dependencies(async () => reply('Public.', { api, content })), manager = new Consultations();
    const first = await manager.send({ message: 'Q' }, deps); assert.equal(first.ok, true); assert.equal(first.response, '\nPublic.');
    await manager.send({ session: first.session, message: 'Continue' }, deps);
    const replayed = deps.requests[1].context.messages[2];
    assert.equal(replayed.api, api); assert.equal(replayed.content[0].thinking, '');
    assert.equal(replayed.content[0].thinkingSignature, signature);
    assert.equal(replayed.content[0].redacted, !responses && !google ? true : undefined);
    assert.deepEqual(replayed.content.slice(1).map(b => b.text), ['', 'Public.']);
    if (google) {
      const model = { provider: 'mock', id: 'chat', api, input: ['text'] };
      const parts = googleMessages(model, deps.requests[1].context).find(item => item.role === 'model').parts;
      assert.deepEqual(parts.map(part => part.thoughtSignature).filter(Boolean), ['YWJjZA==', 'ZWZnaA==']);
      assert.equal(parts[0].text, '');
    }
    assertPrivate(first); assert.doesNotMatch(JSON.stringify([...manager.sessions.values()]), /UNRETAINED_/);
  }
});

test('AC-28 changed: real Anthropic adapter replays redacted thinking without ordinary signed thinking', async () => {
  const model = Object.values(ANTHROPIC_MODELS).find(m => m.api === 'anthropic-messages' && m.id.startsWith('claude-sonnet-4'));
  const manager = new Consultations(), requests = [];
  const deps = { prepare: async () => ({ provider: model.provider, model: model.id }), getContextWindow: () => model.contextWindow, complete: async (_pair, context, options) => anthropic(model, context, {
    ...options, apiKey: 'sk-offline-placeholder-not-a-real-key', fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return sse([
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 4, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: cipher } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'UNRETAINED_THINKING', signature: 'UNRETAINED_SIGNED_PLAINTEXT' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Public.' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' }
      ], true);
    }
  }).result() };
  const first = await manager.send({ message: 'Q' }, deps); assert.equal(first.ok, true);
  const next = await manager.send({ session: first.session, message: 'Continue' }, deps); assert.equal(next.ok, true);
  const blocks = requests[1].messages.find(m => m.role === 'assistant').content;
  assert.deepEqual(blocks, [{ type: 'redacted_thinking', data: cipher }, { type: 'text', text: 'Public.' }]);
  assert.doesNotMatch(JSON.stringify(requests), /UNRETAINED_/); assertPrivate(first); assertPrivate(next);
});

test('AC-28 preserved: missing malformed unsupported and cross-model state never leaks', async () => {
  const accessor = { type: 'thinking', thinking: 'UNRETAINED_THINKING' };
  Object.defineProperty(accessor, 'thinkingSignature', { get: () => { throw new Error('UNRETAINED_GETTER'); } });
  const patches = [
    { api: 'unknown' }, { provider: 'other' }, { model: 'other' },
    ...['not-json', '{}', 'null', '[]', JSON.stringify({ ...reason(), encrypted_content: null }), JSON.stringify({ ...reason(), id: 1 })].map(thinkingSignature => ({ content: [{ type: 'thinking', thinking: 'UNRETAINED_THINKING', thinkingSignature }, { type: 'text', text: 'Public.' }] })),
    { api: 'google-generative-ai', content: [{ type: 'thinking', thinking: 'UNRETAINED_THINKING', thinkingSignature: 'not-base64' }, { type: 'text', text: 'Public.' }] },
    { api: 'anthropic-messages', content: [{ type: 'thinking', thinking: 'UNRETAINED_THINKING', thinkingSignature: 'UNRETAINED_SIGNATURE' }, { type: 'text', text: 'Public.' }] },
    { content: [accessor, { type: 'text', text: 'Public.' }] }
  ];
  for (const patch of patches) {
    const manager = new Consultations(), deps = dependencies(async () => signedReply(cipher, patch));
    const first = await manager.send({ message: 'Q' }, deps); assert.equal(first.ok, true);
    await manager.send({ session: first.session, message: 'Continue' }, deps);
    assert.equal(reasonIn(deps.requests[1].context).length, 0);
    assert.doesNotMatch(JSON.stringify([...manager.sessions.values()]), /UNRETAINED_|SYNTHETIC_CIPHERTEXT/);
    assertPrivate(first); assertPrivate(manager.list());
  }
});

test('AC-28 AC-29 context boundary commits exactly and overflow preserves opaque replay atomically', async () => {
  const content = [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(reason()) }, { type: 'text', text: 'Visible advice.', textSignature: JSON.stringify({ v: 1, id: 'msg_fixture', phase: 'final_answer' }) }];
  const bytes = Buffer.byteLength(JSON.stringify([{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'Visible advice.', replay: { api, content } }]));
  const deps = dependencies(async () => signedReply(cipher, { usage: { ...reply().usage, totalTokens: 5000 } })); deps.getContextWindow = () => 5000;
  const manager = new Consultations(), first = await manager.send({ message: 'Q' }, deps); assert.equal(first.ok, true);
  assert.equal(manager.list()[0].historyBytes, bytes); assert.equal(manager.list()[0].contextUsage.tokens, 5000);
  const tooSmall = new Consultations(); deps.getContextWindow = () => 4999;
  const overflow = await tooSmall.send({ message: 'Q' }, deps);
  assert.equal(overflow.error.code, 'limit-exceeded'); assert.equal(overflow.error.limit.resource, 'context-tokens');
  assert.equal(overflow.usageComplete, true); assert.deepEqual(tooSmall.list(), []); assertPrivate(overflow);
  const full = new Consultations(), initialDeps = dependencies(async () => signedReply()); initialDeps.getContextWindow = () => 10000;
  const initial = await full.send({ message: 'Q' }, initialDeps);
  const huge = dependencies(async () => signedReply('BAD_CIPHER', { usage: { ...reply().usage, totalTokens: 10001 } }));
  const rejected = await full.send({ session: initial.session, message: 'OVERFLOW' }, huge);
  assert.equal(rejected.error.code, 'limit-exceeded'); assert.equal(full.list()[0].turns, 1);
  const retry = dependencies(); await full.send({ session: initial.session, message: 'Good' }, retry);
  assert.equal(reasonIn(retry.requests[0].context)[0].thinkingSignature, JSON.stringify(reason()));
  assert.doesNotMatch(JSON.stringify(retry.requests[0].context), /OVERFLOW|BAD_CIPHER/);
});

test('AC-28 changed: replay snapshots resist reply and dispatched-context mutation', async () => {
  const raw = signedReply(), manager = new Consultations(), deps = dependencies(async () => raw);
  const first = await manager.send({ message: 'Q' }, deps);
  raw.content[0].thinkingSignature = 'UNRETAINED_MUTATION'; raw.content[1].text = 'UNRETAINED_MUTATION';
  const mutating = dependencies(async (_pair, context) => {
    assert.equal(reasonIn(context).length, 1, 'committed opaque state must reach the continuation');
    assert.equal(reasonIn(context)[0].thinkingSignature, JSON.stringify(reason()));
    context.messages[2].content[0].thinkingSignature = 'UNRETAINED_MUTATION';
    context.messages[2].content[1].text = 'UNRETAINED_MUTATION';
    return reply('Next.');
  });
  assert.equal((await manager.send({ session: first.session, message: 'Next' }, mutating)).ok, true);
  const final = dependencies(); await manager.send({ session: first.session, message: 'Last' }, final);
  assert.equal(reasonIn(final.requests[0].context)[0].thinkingSignature, JSON.stringify(reason()));
  assert.doesNotMatch(JSON.stringify(final.requests[0].context), /UNRETAINED_/);
});

test('AC-28 changed: failed and cancelled pairs cannot replace committed opaque state', async () => {
  const manager = new Consultations(), first = await manager.send({ message: 'Q' }, dependencies(async () => signedReply()));
  const bad = await manager.send({ session: first.session, message: 'REJECTED' }, dependencies(async () => signedReply('BAD_CIPHER', { stopReason: 'length' })));
  assert.equal(bad.error.code, 'invalid-response'); assertPrivate(bad);
  const late = deferred(), controller = new AbortController(), slow = dependencies(async () => late.promise);
  const pending = manager.send({ session: first.session, message: 'CANCELLED' }, slow, controller.signal);
  await waitFor(() => slow.requests.length === 1); controller.abort(); assert.equal((await pending).error.code, 'cancelled');
  late.resolve(signedReply('BAD_CIPHER')); await new Promise(r => setImmediate(r));
  const next = dependencies(); await manager.send({ session: first.session, message: 'Good' }, next);
  assert.equal(reasonIn(next.requests[0].context).length, 1, 'prior validated opaque state must survive');
  assert.equal(reasonIn(next.requests[0].context)[0].thinkingSignature, JSON.stringify(reason()));
  assert.doesNotMatch(JSON.stringify(next.requests[0].context), /BAD_CIPHER|REJECTED|CANCELLED/);
  assert.equal(manager.list()[0].turns, 2);
});

test('AC-28 changed: replay stays consultation-local and close or clear releases it', async () => {
  const manager = new Consultations(), deps = dependencies(async () => signedReply());
  const first = await manager.send({ message: 'First' }, deps);
  const other = await manager.send({ message: 'Other' }, dependencies());
  const inspect = dependencies(); await manager.send({ session: first.session, message: 'Inspect' }, inspect);
  assert.equal(reasonIn(inspect.requests[0].context).length, 1);
  const separate = dependencies(); await manager.send({ session: other.session, message: 'Separate' }, separate);
  assert.equal(reasonIn(separate.requests[0].context).length, 0);
  assert.equal(manager.close(first.session).ok, true);
  assert.equal((await manager.send({ session: first.session, message: 'Closed' }, deps)).error.code, 'not-found');
  manager.clear(); assert.deepEqual(manager.list(), []);
  const fresh = dependencies(); await manager.send({ message: 'Fresh' }, fresh);
  assert.equal(reasonIn(fresh.requests[0].context).length, 0);
});

test('AC-28 AC-29 README documents private replay and model bounds with signed-plaintext limitation', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const phrase of ['opaque replay', 'encrypted reasoning', 'thought signatures', 'redacted thinking', 'no fixed history-byte cap', 'Ordinary signed plaintext thinking']) assert.ok(readme.includes(phrase), phrase);
});
