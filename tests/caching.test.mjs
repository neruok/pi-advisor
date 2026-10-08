import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { streamSimple as openai } from '@earendil-works/pi-ai/api/openai-responses';
import { streamSimple as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { Consultations } from '../lib/session.ts';
import { dependencies, reply, usage } from './helpers.mjs';

// Exercise actual payload construction without provider requests or credential reads.
function sse(events, named = false) {
  return new Response(events.map(event => `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' }
  });
}
function openaiSuccess() {
  const item = { type: 'message', id: 'msg_offline', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Offline advice.', annotations: [] }] };
  return sse([
    { type: 'response.created', response: { id: 'resp_offline' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Offline advice.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_offline', status: 'completed', output: [item], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } }
  ]);
}
function anthropicSuccess() {
  return sse([
    { type: 'message_start', message: { id: 'msg_offline', type: 'message', role: 'assistant', model: 'offline', content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Offline advice.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' }
  ], true);
}
function adapter(model, stream, response) {
  const requests = [];
  return { requests, prepare: async () => ({ provider: model.provider, model: model.id }), getContextWindow: () => model.contextWindow, complete: async (_pair, context, options) => {
    return stream(model, context, { ...options, apiKey: 'sk-offline-placeholder-not-a-real-key', env: { PI_CACHE_RETENTION: 'long' }, fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return response();
    } }).result();
  } };
}

test('AC-27 AC-31 identifiers prefixes pinning request controls and cache usage remain stable without an output override', async () => {
  const manager = new Consultations(), deps = dependencies(async () => reply('Preserve this advice.'));
  const first = await manager.send({ message: 'First issue' }, deps);
  const other = await manager.send({ message: 'Separate issue' }, deps);
  assert.equal(first.ok, true); assert.equal(other.ok, true);
  deps.prepare = async () => ({ provider: 'changed', model: 'different' });
  const next = await manager.send({ session: first.session, message: 'More evidence' }, deps);
  assert.equal(next.ok, true); assert.deepEqual(next.model, first.model);
  const [start, separate, continued] = deps.requests;
  assert.equal(start.options.sessionId, first.session);
  assert.equal(continued.options.sessionId, first.session);
  assert.notEqual(separate.options.sessionId, first.session);
  assert.deepEqual(continued.context.messages.slice(0, 2), start.context.messages);
  assert.equal(continued.context.messages[2].content[0].text, first.response);
  assert.equal(continued.context.messages[3].content, 'More evidence');
  assert.equal(separate.context.messages.length, 2);
  for (const request of deps.requests) {
    assert.deepEqual(request.context.messages[0].toolsAdded, []);
    assert.equal(Object.hasOwn(request.options, 'toolChoice'), false);
    assert.equal(request.options.maxRetries, 0); assert.equal(Object.hasOwn(request.options, 'maxTokens'), false);
    assert.ok(Number.isInteger(request.options.timeoutMs) && request.options.timeoutMs > 0 && request.options.timeoutMs <= 300000);
    assert.ok(request.options.signal instanceof AbortSignal);
  }
  assert.equal(next.usage.cacheRead, usage.cacheRead);
  assert.equal(next.totalUsage.cacheRead, usage.cacheRead * 2);
  assert.equal(next.usageComplete, true); assert.equal(next.totalUsageComplete, true);
  assert.equal(manager.close(first.session).ok, true);
  assert.deepEqual(manager.list().map(entry => entry.session), [other.session]);
});

test('AC-27 changed: OpenAI Responses sends stable consultation cache key without extended retention', async () => {
  const manager = new Consultations(), deps = adapter(OPENAI_MODELS['gpt-4.1'], openai, openaiSuccess);
  const first = await manager.send({ message: 'Offline first' }, deps);
  assert.equal(first.ok, true);
  const next = await manager.send({ session: first.session, message: 'Offline continuation' }, deps);
  assert.equal(next.ok, true); assert.equal(deps.requests.length, 2);
  for (const payload of deps.requests) {
    assert.equal(payload.prompt_cache_key, first.session);
    assert.equal(Object.hasOwn(payload, 'prompt_cache_retention'), false);
    assert.equal(payload.store, false);
  }
});

test('AC-27 changed: Anthropic sends ephemeral cache markers without one-hour ttl', async () => {
  const model = Object.values(ANTHROPIC_MODELS).find(model => model.api === 'anthropic-messages' && model.id.startsWith('claude-sonnet-4'));
  assert.ok(model, 'installed catalog must supply a Sonnet 4 model');
  const manager = new Consultations(), deps = adapter(model, anthropic, anthropicSuccess);
  const first = await manager.send({ message: 'Offline first' }, deps);
  assert.equal(first.ok, true);
  const next = await manager.send({ session: first.session, message: 'Offline continuation' }, deps);
  assert.equal(next.ok, true); assert.equal(deps.requests.length, 2);
  for (const payload of deps.requests) {
    assert.deepEqual(payload.system[0].cache_control, { type: 'ephemeral' });
    const last = payload.messages.at(-1).content.at(-1);
    assert.deepEqual(last.cache_control, { type: 'ephemeral' });
  }
});

test('AC-27 changed: README describes short caching and provider retention limits', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /cacheRetention: 'short'/);
  assert.match(readme, /Cache hits.*provider/);
  assert.match(readme, /Closing a consultation does not delete provider caches/);
  assert.match(readme, /Continue the same session/);
});
