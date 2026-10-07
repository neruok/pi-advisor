import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { Compile } from 'typebox/compile';
import { Consultations } from '../lib/session.ts';
import { AdviceSchema } from '../lib/schemas.ts';
import { toolRenderers } from '../lib/render.ts';
import { dependencies, reply, model } from './helpers.mjs';

const secret = 'PRIVATE_credentials_headers_advice_thinking_payload';
const selected = { provider: 'xai', model: 'offline-mock' };
const sdkModel = { provider: 'xai', id: selected.model, name: 'Offline mock', api: 'openai-responses', baseUrl: 'https://offline.invalid/v1', input: ['text'], reasoning: true, contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const input = { message: 'Offline mock only', diagnostics: true };
function checked(result) {
  assert.equal(Compile(AdviceSchema).Check(result), true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  return result.error.diagnostics;
}
function sdkDependencies(overrideTimeout) {
  const state = { fetches: 0, attempts: 0, timeout: undefined, terminal: undefined };
  return { state, prepare: async () => selected, complete: async (_pair, context, options) => {
    state.attempts++;
    state.timeout = options.timeoutMs;
    assert.equal(options.maxRetries, 0);
    state.terminal = await streamSimple(sdkModel, context, {
      ...options, ...(overrideTimeout === undefined ? {} : { timeoutMs: overrideTimeout }), apiKey: 'offline-placeholder-not-a-real-key',
      fetch: async () => {
        state.fetches++;
        return new Response(JSON.stringify({ error: { message: secret, code: 'invalid_api_key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
    }).result();
    return state.terminal;
  } };
}

test('AC-23 changed: integer manager timeout reaches the real Responses adapter mock fetch', async () => {
  const deps = sdkDependencies();
  const result = await new Consultations().send(input, deps);
  assert.equal(Number.isInteger(deps.state.timeout), true, 'SDK request timeout must be an integer');
  assert.ok(deps.state.timeout >= 1 && deps.state.timeout <= 120000);
  assert.equal(deps.state.fetches, 1, deps.state.terminal.errorMessage);
  assert.equal(deps.state.attempts, 1);
  assert.equal(result.error.code, 'provider-failed');
  assert.deepEqual(checked(result), { phase: 'response-validation', category: 'authentication', httpStatus: 401, model: selected, selectionSource: 'unknown' });
});

test('AC-23 changed: SDK timeout validation surfaces a fixed code without network or raw text', async () => {
  const deps = sdkDependencies(1.5);
  const result = await new Consultations().send(input, deps);
  assert.equal(deps.state.fetches, 0);
  assert.equal(deps.state.terminal.errorMessage, 'timeout must be an integer');
  assert.equal(checked(result).category, 'sdk-error');
  assert.equal(result.error.diagnostics.code, 'sdk-invalid-timeout');
  for (const errorMessage of ['timeout must be an integer', 'timeout must be a positive integer']) {
    const failure = await new Consultations().send(input, dependencies(async () => reply(secret, { stopReason: 'error', errorMessage })));
    assert.equal(checked(failure).code, 'sdk-invalid-timeout');
  }
});

test('AC-23 changed: SDK wrapper statuses expose only allowlisted hints', async () => {
  for (const [statuses, category] of [
    [[401, 403], 'authentication'], [[400, 404, 409, 413, 422], 'provider-rejection'], [[429], 'rate-limit'],
    [[408, 500, 502, 503, 504], 'transport'], [[418], 'provider-error']
  ]) for (const httpStatus of statuses) {
    const deps = dependencies(async () => reply(secret, { stopReason: 'error', errorMessage: `mock API error (${httpStatus}): ${secret}` }));
    const result = await new Consultations().send(input, deps);
    assert.deepEqual(checked(result), { phase: 'response-validation', category, httpStatus, model, selectionSource: 'unknown' });
    assert.equal(deps.requests.length, 1);
  }
  const deps = dependencies(async () => reply(secret, { stopReason: 'error', errorMessage: `OpenAI API error (401): ${secret}` }));
  deps.prepare = async () => ({ provider: 'openai', model: 'offline-mock' });
  assert.equal(checked(await new Consultations().send(input, deps)).httpStatus, 401);
});

test('AC-23 preserved: arbitrary messages, malformed wrappers, getters and terminal abort stay private', async () => {
  for (const errorMessage of [secret, `HTTP 401 ${secret}`, `other API error (401): ${secret}`, `mock API error (0401): ${secret}`, `mock API error (601): ${secret}`, `mock API error (200): ${secret}`, `mock API error (401) ${secret}`, `prefix mock API error (401): ${secret}`, `timeout must be an integer ${secret}`]) {
    const result = await new Consultations().send(input, dependencies(async () => reply(secret, { stopReason: 'error', errorMessage })));
    assert.deepEqual(checked(result), { phase: 'response-validation', category: 'provider-error', model, selectionSource: 'unknown' });
  }
  let reads = 0;
  const terminal = reply(secret, { stopReason: 'error' });
  Object.defineProperty(terminal, 'errorMessage', { get() { reads++; throw new Error(secret); } });
  checked(await new Consultations().send(input, dependencies(async () => terminal)));
  assert.equal(reads, 0);
  const hostile = new Proxy(reply(secret, { stopReason: 'error' }), { getOwnPropertyDescriptor() { throw new Error(secret); } });
  assert.equal(checked(await new Consultations().send(input, dependencies(async () => hostile))).category, 'provider-error');
  const aborted = await new Consultations().send(input, dependencies(async () => reply(secret, { stopReason: 'aborted', errorMessage: `mock API error (401): ${secret}` })));
  assert.equal(checked(aborted).category, 'provider-aborted');
  assert.equal(aborted.error.diagnostics.httpStatus, undefined);
});

test('AC-23 preserved: default envelopes, accounting, rollback and no retry remain unchanged', async () => {
  const manager = new Consultations();
  const first = await manager.send({ message: 'Start' }, dependencies());
  for (const diagnostics of [undefined, false]) {
    const deps = dependencies(async () => reply(secret, { stopReason: 'error', errorMessage: `mock API error (401): ${secret}` }));
    const failure = await manager.send({ message: 'Continue', session: first.session, ...(diagnostics === undefined ? {} : { diagnostics }) }, deps);
    assert.equal(failure.error.diagnostics, undefined);
    assert.equal(failure.usageComplete, true);
    assert.equal(deps.requests.length, 1);
    assert.equal(deps.requests[0].options.maxRetries, 0);
    assert.equal(manager.list()[0].turns, 1);
    checked(failure);
  }
  const next = dependencies();
  const success = await manager.send({ ...input, session: first.session }, next);
  assert.equal(success.ok, true);
  assert.equal(success.diagnostics, undefined);
  assert.equal(JSON.stringify(next.requests[0].context).includes(secret), false);
});

test('AC-23 changed: schemas and renderers show fixed SDK and HTTP diagnostics', () => {
  const theme = { fg: (_color, text) => text, bold: text => text };
  const renderer = toolRenderers('advisor');
  for (const [hint, expected] of [
    [{ category: 'sdk-error', code: 'sdk-invalid-timeout' }, /SDK timeout must be a positive integer/],
    [{ category: 'authentication', httpStatus: 401 }, /HTTP status: 401/]
  ]) {
    const data = { ok: false, error: { code: 'provider-failed', message: 'Advisor provider request failed. No exchange was committed.', diagnostics: { phase: 'response-validation', ...hint } }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, usageComplete: true };
    assert.equal(Compile(AdviceSchema).Check(data), true);
    assert.match(renderer.renderResult({ details: data }, { expanded: false, isPartial: false }, theme).render(200).join('\n'), expected);
    for (const width of [1, 8, 30, 80]) for (const line of renderer.renderResult({ details: data }, { expanded: true, isPartial: false }, theme).render(width)) assert.ok(line.length <= width);
  }
});

test('AC-23 changed: README documents SDK hints without raw provider payloads', async () => {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const term of ['sdk-invalid-timeout', 'httpStatus', 'SDK wrapper', 'positive integer']) assert.ok(text.includes(term), term);
});
