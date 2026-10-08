import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Compile } from 'typebox/compile';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { Consultations } from '../lib/session.ts';
import { AdviceSchema } from '../lib/schemas.ts';
import { toolRenderers } from '../lib/render.ts';
import { dependencies, reply } from './helpers.mjs';

const rejection = 'Invalid request content: A tool_choice was set on the request but no tools were specified.';
const selected = { provider: 'xai', model: 'grok-4.7' };
const sdkModel = XAI_MODELS['grok-4.7'];
const input = { message: 'Offline tool-free request', diagnostics: true };
function successResponse() {
  const item = { type: 'message', id: 'msg_offline', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Offline success.', annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_offline' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Offline success.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_offline', status: 'completed', output: [item], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } }
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function realAdapter(reasoning, omitChoice = false, model = sdkModel) {
  const requests = [];
  return { requests, prepare: async () => ({ provider: model.provider, model: model.id, ...(reasoning ? { reasoning } : {}) }), getContextWindow: () => model.contextWindow, complete: async (_pair, context, options) => {
    assert.equal(Number.isInteger(options.timeoutMs), true);
    assert.equal(options.maxRetries, 0);
    const { toolChoice, ...withoutChoice } = options;
    return streamSimple(model, context, { ...(omitChoice ? withoutChoice : options), apiKey: 'sk-offline-placeholder-not-a-real-key', fetch: async (_url, request) => {
      const payload = JSON.parse(request.body);
      requests.push(payload);
      if (model.provider === 'xai' && payload.tool_choice !== undefined && !payload.tools?.length) return new Response(rejection, { status: 400, headers: { 'content-type': 'text/plain' } });
      return successResponse();
    } }).result();
  } };
}

for (const reasoning of [undefined, 'high']) test(`AC-24 changed: xAI real-adapter requests omit tool_choice with ${reasoning ?? 'default'} effort`, async () => {
  const manager = new Consultations(), deps = realAdapter(reasoning);
  const first = await manager.send(input, deps);
  assert.equal(first.ok, true, 'tool-free xAI request must pass the no-tools validation fixture');
  const next = await manager.send({ ...input, session: first.session }, deps);
  assert.equal(next.ok, true);
  assert.equal(next.turns, 2);
  assert.equal(next.response, 'Offline success.');
  assert.equal(deps.requests.length, 2);
  for (const request of deps.requests) {
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    assert.equal(request.max_output_tokens, 4096);
    assert.equal(request.store, false);
    assert.equal(request.reasoning?.effort, reasoning);
  }
  assert.equal(Compile(AdviceSchema).Check(next), true);
});

test('AC-25 AC-26 AC-27 changed: every provider omits toolChoice and requests short caching on creation and pinned continuation', async () => {
  for (const provider of ['mock', 'xai', 'openai', 'anthropic', 'openai-codex', 'custom']) {
    const manager = new Consultations(), deps = dependencies();
    const selection = { provider, model: 'offline', reasoning: 'high' };
    deps.prepare = async () => selection;
    const first = await manager.send(input, deps);
    assert.equal(first.ok, true);
    deps.prepare = async () => ({ provider: 'changed', model: 'different', reasoning: 'low' });
    const next = await manager.send({ ...input, session: first.session }, deps);
    assert.equal(next.ok, true);
    assert.equal(next.turns, 2);
    assert.deepEqual(next.model, selection);
    assert.equal(deps.requests.length, 2);
    for (const request of deps.requests) {
      assert.equal(Object.hasOwn(request.options, 'toolChoice'), false, `${provider} must leave tool choice to Pi`);
      assert.deepEqual(request.pair, selection);
      assert.deepEqual(request.context.messages[0].toolsAdded, []);
      assert.equal(request.options.reasoning, 'high');
      assert.equal(request.options.maxRetries, 0);
      assert.equal(request.options.maxTokens, 4096);
      assert.equal(request.options.cacheRetention, 'short');
      assert.equal(request.options.sessionId, first.session);
      assert.ok(Number.isInteger(request.options.timeoutMs) && request.options.timeoutMs > 120000 && request.options.timeoutMs <= 300000);
      assert.ok(request.options.signal instanceof AbortSignal);
    }
    assert.equal(deps.requests[1].context.messages.length, 4);
  }
});

test('AC-25 changed: OpenAI real-adapter creation and continuation omit tools and tool_choice', async () => {
  // A large-context model keeps Pi's input-budget clamp from reducing the requested 4096-token bound.
  const model = OPENAI_MODELS['gpt-4.1'];
  assert.equal(model?.api, 'openai-responses', 'installed gpt-4.1 must use the Responses adapter');
  const manager = new Consultations(), deps = realAdapter(undefined, false, model);
  const first = await manager.send(input, deps);
  assert.equal(first.ok, true);
  const next = await manager.send({ ...input, session: first.session }, deps);
  assert.equal(next.ok, true);
  assert.equal(next.turns, 2);
  assert.equal(deps.requests.length, 2);
  for (const request of deps.requests) {
    assert.equal(Object.hasOwn(request, 'tools'), false);
    assert.equal(Object.hasOwn(request, 'tool_choice'), false);
    assert.equal(request.max_output_tokens, 4096);
    assert.equal(request.store, false);
  }
});

test('AC-25 changed: README documents Pi-owned tool choice for every provider', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /omit `toolChoice` for every provider/);
  assert.match(readme, /Pi controls provider payload construction/);
  assert.doesNotMatch(readme, /Other providers retain `toolChoice: "none"`/);
});

test('AC-24 changed: exact xAI no-tools rejection details return a fixed diagnostic code', async () => {
  for (const detail of [rejection, 'A tool_choice was set on the request but no tools were specified.', `400 ${rejection}`]) {
    const deps = dependencies(async () => reply('PRIVATE_REJECTED_ADVICE', { stopReason: 'error', errorMessage: `xai API error (400): ${detail}` }));
    deps.prepare = async () => selected;
    const failure = await new Consultations().send(input, deps);
    assert.equal(failure.error.diagnostics.code, 'tool-choice-without-tools');
    assert.equal(failure.error.diagnostics.httpStatus, 400);
    assert.equal(failure.error.diagnostics.category, 'provider-rejection');
    assert.equal(Compile(AdviceSchema).Check(failure), true);
    assert.equal(JSON.stringify(failure).includes(detail), false);
    assert.equal(JSON.stringify(failure).includes('PRIVATE_REJECTED_ADVICE'), false);
  }
});

test('AC-24 AC-25 preserved: known-good SSE fixture succeeds', async () => {
  const deps = realAdapter('high', true);
  const result = await new Consultations().send(input, deps);
  assert.equal(result.ok, true);
  assert.equal(result.response, 'Offline success.');
  assert.equal(deps.requests.length, 1);

});

test('AC-24 preserved: unrecognized details, providers, statuses and aborts add no rejection code', async () => {
  for (const [provider, status, detail, stopReason] of [
    ['xai', 400, rejection + ' PRIVATE_EXTRA', 'error'], ['xai', 400, rejection.slice(0, -1), 'error'],
    ['other', 400, rejection, 'error'], ['xai', 401, rejection, 'error'], ['xai', 400, rejection, 'aborted']
  ]) {
    const deps = dependencies(async () => reply('PRIVATE_REJECTED_ADVICE', { stopReason, errorMessage: `${provider} API error (${status}): ${detail}` }));
    deps.prepare = async () => ({ provider, model: 'offline' });
    const result = await new Consultations().send(input, deps);
    assert.equal(result.error.diagnostics.code, undefined);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
    assert.equal(deps.requests.length, 1);
  }
});

test('AC-24 changed: schemas and renderers expose the fixed no-tools explanation', () => {
  const data = { ok: false, error: { code: 'provider-failed', message: 'Advisor provider request failed. No exchange was committed.', diagnostics: { phase: 'response-validation', category: 'provider-rejection', code: 'tool-choice-without-tools', httpStatus: 400 } }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, usageComplete: true };
  assert.equal(Compile(AdviceSchema).Check(data), true);
  const renderer = toolRenderers('advisor'), theme = { fg: (_color, text) => text, bold: text => text };
  assert.match(renderer.renderResult({ details: data }, { expanded: false, isPartial: false }, theme).render(200).join('\n'), /xAI rejected tool_choice without tools/);
  for (const width of [1, 8, 30, 80]) for (const line of renderer.renderResult({ details: data }, { expanded: true, isPartial: false }, theme).render(width)) assert.ok(line.length <= width);
});
