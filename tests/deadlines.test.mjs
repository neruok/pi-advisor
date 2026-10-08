import test from 'node:test';
import assert from 'node:assert/strict';
import { Consultations } from '../lib/session.ts';
import { LIMITS } from '../lib/protocol.ts';
import { dependencies, reply, deferred, model } from './helpers.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function clock(t) {
  let elapsed = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => elapsed);
  return milliseconds => { elapsed += milliseconds; t.mock.timers.tick(milliseconds); };
}

test('AC-26 changed: default deadline permits completion after two minutes', async t => {
  const tick = clock(t), manager = new Consultations(), pending = deferred();
  const deps = dependencies(async () => pending.promise);
  const call = manager.send({ message: 'Offline long request' }, deps);
  try {
    await flush();
    assert.equal(LIMITS.timeoutMs, 300000);
    assert.equal(deps.requests.length, 1);
    assert.equal(deps.requests[0].options.timeoutMs, 300000);
    tick(120001); await flush();
    assert.equal(deps.requests[0].options.signal.aborted, false);
    pending.resolve(reply());
    assert.equal((await call).ok, true);
    assert.equal(manager.list()[0].turns, 1);
  } finally { manager.clear(); pending.resolve(reply()); await call; }
});

test('AC-26 changed: configured deadline includes preparation and rejects late completion', async t => {
  const tick = clock(t), manager = new Consultations(), prepared = deferred(), pending = deferred();
  const deps = dependencies(async () => pending.promise);
  deps.prepare = async (selection, timeout) => { await prepared.promise; selection?.(model, 'global'); timeout?.(10000); return model; };
  const call = manager.send({ message: 'Offline configured deadline', diagnostics: true }, deps);
  try {
    await flush(); tick(4000); prepared.resolve(); await flush();
    assert.equal(deps.requests.length, 1);
    assert.equal(deps.requests[0].options.timeoutMs, 6000);
    assert.equal(deps.requests[0].options.maxRetries, 0);
    tick(5999); await flush(); assert.equal(deps.requests[0].options.signal.aborted, false);
    tick(1); const result = await call;
    assert.equal(result.error.code, 'timeout');
    assert.equal(result.error.diagnostics.phase, 'completion');
    assert.equal(result.error.diagnostics.category, 'advisor-error');
    assert.equal(result.usageComplete, false);
    assert.deepEqual(manager.list(), []);
    pending.resolve(reply()); await flush();
    assert.deepEqual(manager.list(), []);
    assert.equal(deps.requests.length, 1);
  } finally { manager.clear(); prepared.resolve(); pending.resolve(reply()); await call; }
});

test('AC-26 changed: already elapsed configured budget expires before generation', async t => {
  const tick = clock(t), manager = new Consultations(), prepared = deferred(), deps = dependencies();
  deps.prepare = async (selection, timeout) => { await prepared.promise; selection?.(model, 'project'); timeout?.(1000); return model; };
  const call = manager.send({ message: 'Offline preparation expiry', diagnostics: true }, deps);
  try {
    await flush(); tick(1500); prepared.resolve();
    const result = await call;
    assert.equal(result.error?.code, 'timeout');
    assert.equal(result.error.diagnostics.phase, 'preparation');
    assert.equal(result.usageComplete, true);
    assert.equal(deps.requests.length, 0);
    assert.deepEqual(manager.list(), []);
  } finally { manager.clear(); prepared.resolve(); await call; }
});

test('AC-26 changed: elapsed preparation stops generation even before timer dispatch', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const manager = new Consultations(), deps = dependencies();
  deps.prepare = async (_selection, timeout) => { timeout?.(1000); elapsed = 1500; return model; };
  const result = await manager.send({ message: 'Offline stalled preparation', diagnostics: true }, deps);
  assert.equal(result.error?.code, 'timeout');
  assert.equal(deps.requests.length, 0);
  assert.equal(result.usageComplete, true);
  assert.equal(result.error.diagnostics.phase, 'preparation');
  assert.deepEqual(manager.list(), []);
});

test('AC-26 preserved: late preparation callbacks after failure schedule no new timer', async t => {
  clock(t);
  const native = globalThis.setTimeout, scheduled = [];
  t.mock.method(globalThis, 'setTimeout', (...args) => { scheduled.push(args[1]); return Reflect.apply(native, globalThis, args); });
  let reportSelection, reportTimeout;
  const manager = new Consultations(), deps = dependencies();
  deps.prepare = async (selection, timeout) => { reportSelection = selection; reportTimeout = timeout; throw new Error('PRIVATE_PREPARATION_ERROR'); };
  const result = await manager.send({ message: 'Offline preparation failure', diagnostics: true }, deps);
  const snapshot = JSON.stringify(result), count = scheduled.length;
  reportSelection?.(model, 'project'); reportTimeout?.(20000); await flush();
  assert.equal(scheduled.length, count);
  assert.equal(JSON.stringify(result), snapshot);
  assert.deepEqual(manager.list(), []);
  assert.equal(deps.requests.length, 0);
});

test('AC-26 preserved: caller cancellation and ignored abort cannot commit a late reply', async t => {
  clock(t);
  const manager = new Consultations(), pending = deferred(), controller = new AbortController();
  const deps = dependencies(async () => pending.promise);
  const call = manager.send({ message: 'Offline cancellation', diagnostics: true }, deps, controller.signal);
  try {
    await flush(); controller.abort();
    const result = await call;
    assert.equal(result.error.code, 'cancelled');
    assert.equal(result.usageComplete, false);
    assert.equal(deps.requests.length, 1);
    assert.equal(deps.requests[0].options.maxRetries, 0);
    assert.equal(deps.requests[0].options.signal.aborted, true);
    pending.resolve(reply()); await flush();
    assert.deepEqual(manager.list(), []);
  } finally { manager.clear(); pending.resolve(reply()); await call; }
});
