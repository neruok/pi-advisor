import test from 'node:test';
import assert from 'node:assert/strict';
import { Consultations } from '../lib/session.ts';
import { dependencies, reply, deferred, waitFor, usage } from './helpers.mjs';

const text = c => JSON.stringify(c.messages);

test('AC-1 AC-25 AC-31 isolated starts and continuations pin the selected model without toolChoice', async () => {
  const manager = new Consultations(), deps = dependencies();
  const a = await manager.send({ message: 'FIRST_PROBLEM' }, deps);
  assert.equal(a.ok, true, 'starting must produce a consultation');
  const b = await manager.send({ message: 'SECOND_PROBLEM' }, deps);
  assert.notEqual(a.session, b.session);
  deps.prepare = async () => ({ provider: 'changed', model: 'new' });
  const c = await manager.send({ session: a.session, message: 'FIRST_EVIDENCE' }, deps);
  assert.equal(c.turns, 2);
  assert.deepEqual(deps.requests[2].pair, a.model);
  assert.equal(deps.requests[2].context.messages.length, 4);
  assert.match(text(deps.requests[2].context), /FIRST_PROBLEM/);
  assert.doesNotMatch(text(deps.requests[2].context), /SECOND_PROBLEM/);
  for (const r of deps.requests) { assert.deepEqual(r.context.messages[0].toolsAdded, []); assert.equal(Object.hasOwn(r.options, 'toolChoice'), false); assert.equal(r.options.maxRetries, 0); assert.equal(Object.hasOwn(r.options, 'maxTokens'), false); assert.notEqual(r.options.sessionId, 'PARENT_SESSION'); }
});

test('AC-2 AC-17 text completion validation does not expose thinking', async () => {
  const manager = new Consultations();
  const deps = dependencies(async () => reply(undefined, { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: 'Advice.' }] }));
  const r = await manager.send({ message: 'Explain' }, deps);
  assert.equal(r.ok, true); assert.equal(r.response, 'Advice.'); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_REASONING/);
  assert.equal((await manager.send({ session: r.session, message: 'Another fact' }, dependencies())).ok, true);
  for (const content of ['', ' \n\t ']) {
    const r = await manager.send({ message: 'Q' }, dependencies(async () => reply(content)));
    assert.equal(r.error.code, 'invalid-response');
  }
  for (const patch of [{ stopReason: 'length' }, { stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'read', arguments: {} }] }, { content: [{ type: 'image', data: 'x' }] }, { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }] }]) {
    assert.equal((await manager.send({ message: 'Q' }, dependencies(async () => reply(undefined, patch)))).error.code, 'invalid-response');
  }
  const prompt = dependencies(); await manager.send({ message: 'Q' }, prompt);
  assert.match(prompt.requests[0].context.messages[0].content, /interpretations/i);
  assert.match(prompt.requests[0].context.messages[0].content, /hypotheses/i);
  assert.match(prompt.requests[0].context.messages[0].content, /not evidence or authorization/i);
});

test('AC-3 atomic failures, usage, busy, abort, timeout and late completions', async () => {
  const manager = new Consultations(), initial = await manager.send({ message: 'Q' }, dependencies());
  assert.equal(initial.ok, true, 'baseline consultation must exist');
  const failed = dependencies(async () => { throw new Error('SECRET_PROVIDER_ERROR'); });
  const r = await manager.send({ session: initial.session, message: 'BAD_INPUT' }, failed);
  assert.equal(r.error.code, 'provider-failed'); assert.doesNotMatch(JSON.stringify(r), /SECRET_PROVIDER_ERROR/); assert.equal(failed.requests.length, 1);
  const invalid = await manager.send({ session: initial.session, message: 'BAD_INPUT' }, dependencies(async () => reply(undefined, { stopReason: 'error', errorMessage: 'SECRET' })));
  assert.equal(invalid.error.code, 'provider-failed'); assert.equal(invalid.usage.input, 10); assert.equal(manager.list()[0].turns, 1);
  const next = dependencies(); const good = await manager.send({ session: initial.session, message: 'GOOD' }, next); assert.equal(good.totalUsage.input, 30); assert.doesNotMatch(text(next.requests[0].context), /BAD_INPUT/);
  const pending = deferred(), slow = dependencies(async () => pending.promise), controller = new AbortController();
  const p = manager.send({ session: initial.session, message: 'PENDING' }, slow, controller.signal);
  await waitFor(() => slow.requests.length === 1);
  assert.equal((await manager.send({ session: initial.session, message: 'OVERLAP' }, next)).error.code, 'busy');
  controller.abort(); assert.equal((await p).error.code, 'cancelled'); assert.equal(slow.requests[0].options.signal.aborted, true);
  pending.resolve(reply()); await new Promise(r => setImmediate(r)); assert.equal(manager.list()[0].turns, 2);
  const fastDeadline = new Consultations({ timeoutMs: 5 }), late = deferred();
  const timed = await fastDeadline.send({ message: 'Q' }, dependencies(async () => late.promise)); assert.equal(timed.error.code, 'timeout');
  late.resolve(reply()); await new Promise(r => setImmediate(r)); assert.deepEqual(fastDeadline.list(), []);
  const pre = new AbortController(); pre.abort(); const noCall = dependencies(); assert.equal((await manager.send({ message: 'Q' }, noCall, pre.signal)).error.code, 'cancelled'); assert.equal(noCall.requests.length, 0);
});

test('AC-29 AC-31 context limits preserve state after fixed resource caps are removed', async () => {
  const deps = dependencies();
  // REQ-31 removes fixed resource caps. The model context window still holds.
  const boundary = dependencies(async () => reply('A\n[CONTINUE]', { usage: { ...usage, totalTokens: 5000 } }));
  boundary.getContextWindow = () => 5000;
  const bounded = new Consultations(), ok = await bounded.send({ message: 'Q' }, boundary); assert.equal(ok.ok, true);
  assert.equal(ok.contextUsage.tokens, 5000);
  const overflow = await bounded.send({ session: ok.session, message: 'Q' }, deps);
  assert.equal(overflow.error.code, 'limit-exceeded'); assert.equal(overflow.error.limit.resource, 'context-tokens');
  boundary.getContextWindow = () => 4999;
  const tooSmall = new Consultations(); assert.equal((await tooSmall.send({ message: 'Q' }, boundary)).error.code, 'limit-exceeded'); assert.deepEqual(tooSmall.list(), []);
});

test('AC-5 metadata-only discovery, busy close, deletion and reset', async () => {
  const manager = new Consultations(), first = await manager.send({ message: '😀'.repeat(100) + '\nSECRET_TAIL' }, dependencies());
  assert.equal(first.ok, true, 'consultation must exist before listing');
  const list = manager.list(); assert.equal(Array.from(list[0].label).length, 80); assert.doesNotMatch(JSON.stringify(list), /SECRET_TAIL|response|content/);
  assert.equal(manager.close('unknown').error.code, 'not-found');
  const pending = deferred(), deps = dependencies(async () => pending.promise); const p = manager.send({ session: first.session, message: 'new' }, deps);
  await waitFor(() => deps.requests.length === 1); assert.equal(manager.list()[0].busy, true); assert.equal(manager.close(first.session).error.code, 'busy');
  manager.clear(); assert.equal((await p).error.code, 'cancelled'); pending.resolve(reply()); await new Promise(r => setImmediate(r)); assert.deepEqual(manager.list(), []);
  assert.equal((await manager.send({ session: first.session, message: 'Q' }, dependencies())).error.code, 'not-found');
  const newSession = await manager.send({ message: 'New' }, dependencies()); assert.equal(manager.close(newSession.session).ok, true); assert.equal(manager.close(newSession.session).error.code, 'not-found');
});
