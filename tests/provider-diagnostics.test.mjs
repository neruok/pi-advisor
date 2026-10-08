import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import extension from '../advisor.ts';
import { Consultations } from '../lib/session.ts';
import { AdvisorError, completionCategory, parseInput, zeroUsage } from '../lib/protocol.ts';
import { AdviceSchema, InputSchema } from '../lib/schemas.ts';
import { toolRenderers } from '../lib/render.ts';
import { dependencies, deferred, model, reply, waitFor } from './helpers.mjs';

const secret = 'PRIVATE_credentials_headers_advice_thinking_payload';
const input = { message: 'Q', diagnostics: true };
function check(result) {
  assert.equal(Compile(AdviceSchema).Check(result), true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  return result.error.diagnostics;
}

test('AC-22 preparation exceptions and zero-usage terminal errors are distinguishable without private content', async () => {
  const manager = new Consultations();
  const preparation = await manager.send(input, { prepare: async () => { throw new Error(secret); }, complete: async () => { assert.fail('no completion'); } });
  const terminal = await manager.send(input, dependencies(async () => reply(secret, { stopReason: 'error', errorMessage: secret, usage: zeroUsage(), content: [{ type: 'thinking', thinking: secret }] })));
  assert.deepEqual(check(preparation), { phase: 'preparation', category: 'local-error' });
  assert.deepEqual(check(terminal), { phase: 'response-validation', category: 'provider-error', model, selectionSource: 'unknown' });
  for (const result of [preparation, terminal]) {
    assert.equal(result.error.code, 'provider-failed');
    assert.equal(result.usageComplete, true);
    assert.deepEqual(result.usage, zeroUsage());
  }
  assert.deepEqual(manager.list(), []);
});

test('AC-22 opt-in is per-call, strict, and leaves default failures and successes unchanged', async () => {
  for (const diagnostics of [undefined, false]) {
    const result = await new Consultations().send({ message: 'Q', ...(diagnostics === undefined ? {} : { diagnostics }) }, dependencies(async () => { throw new Error(secret); }));
    assert.equal(result.error.diagnostics, undefined);
    assert.deepEqual(Object.keys(result.error), ['code', 'message']);
    assert.equal(result.usageComplete, false);
    check(result);
  }
  for (const diagnostics of [null, 'true', 1, {}]) {
    assert.equal(Compile(InputSchema).Check({ message: 'Q', diagnostics }), false);
    assert.throws(() => parseInput({ message: 'Q', diagnostics }), AdvisorError);
  }
  assert.equal(Compile(InputSchema).Check(input), true);
  const manager = new Consultations();
  const success = await manager.send(input, dependencies());
  assert.equal(success.ok, true);
  assert.equal(success.diagnostics, undefined);
  const failure = await manager.send({ message: 'Q', session: success.session }, dependencies(async () => { throw new Error(secret); }));
  assert.equal(failure.error.diagnostics, undefined, 'option must not be pinned');
  assert.equal(manager.list()[0].turns, 1);
  const invalid = await manager.send({ message: '', diagnostics: true }, dependencies());
  assert.deepEqual(check(invalid), { phase: 'validation', category: 'advisor-error' });
});

test('AC-22 structured completion categories are allowlisted, do not read getters or messages, and handle hostile metadata', async () => {
  for (const [metadata, category] of [
    [{ status: 401 }, 'authentication'], [{ status: 403 }, 'authentication'],
    [{ status: 400 }, 'provider-rejection'], [{ status: 429 }, 'rate-limit'],
    [{ status: 503 }, 'transport'], [{ code: 'ECONNRESET' }, 'transport'],
    [{ status: 429, code: 'ECONNRESET' }, 'rate-limit'],
    [{ status: '401', code: secret }, 'unknown'], [{ status: 418 }, 'unknown'],
    [{ errorMessage: 'HTTP 401 ' + secret }, 'unknown'],
    [secret, 'unknown'], [null, 'unknown']
  ]) {
    const deps = dependencies(async () => { throw typeof metadata === 'object' && metadata ? { ...metadata, message: secret, headers: secret, cause: secret } : metadata; });
    const result = await new Consultations().send(input, deps);
    assert.equal(check(result).category, category);
    assert.equal(result.error.diagnostics.phase, 'completion');
    assert.equal(result.usageComplete, false);
    assert.equal(deps.requests.length, 1);
    assert.equal(deps.requests[0].options.maxRetries, 0);
  }
  for (const [statuses, category] of [
    [[401, 403], 'authentication'], [[400, 404, 409, 413, 422], 'provider-rejection'],
    [[429], 'rate-limit'], [[408, 500, 502, 503, 504], 'transport']
  ]) for (const status of statuses) assert.equal(completionCategory({ status }), category);
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) assert.equal(completionCategory({ code }), 'transport');
  assert.equal(completionCategory(Object.create({ status: 401 })), 'unknown', 'inherited metadata is ignored');
  let reads = 0;
  const getters = Object.defineProperties({}, { status: { get() { reads++; throw new Error(secret); } }, code: { get() { reads++; return secret; } }, message: { get() { reads++; return secret; } } });
  assert.equal(completionCategory(getters), 'unknown');
  assert.equal(reads, 0);
  assert.equal(completionCategory(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } })), 'unknown');
});

test('AC-22 terminal abort and invalid reply diagnostics preserve rollback, usage and pinned history', async () => {
  const manager = new Consultations();
  const deps = dependencies();
  deps.prepare = async report => { report(model, 'project'); return model; };
  const first = await manager.send(input, deps);
  for (const [patch, category] of [[{ stopReason: 'aborted' }, 'provider-aborted'], [{ stopReason: 'length' }, 'advisor-error'], [{ content: [null] }, 'advisor-error']]) {
    const failing = dependencies(async () => reply(secret, { ...patch, errorMessage: secret }));
    failing.prepare = async () => { assert.fail('must remain pinned'); };
    const result = await manager.send({ ...input, session: first.session }, failing);
    assert.deepEqual(check(result), { phase: 'response-validation', category, model, selectionSource: 'project' });
    assert.equal(result.usageComplete, true);
    assert.equal(manager.list()[0].turns, 1);
    assert.equal(failing.requests.length, 1);
  }
  const continuation = dependencies();
  const next = await manager.send({ ...input, session: first.session }, continuation);
  assert.equal(next.turns, 2);
  assert.equal(JSON.stringify(continuation.requests[0].context).includes(secret), false);
});

test('AC-22 cancellation and timeout report the active phase and prevent late mutations', async () => {
  for (const preparing of [true, false]) {
    const manager = new Consultations({ timeoutMs: 20 });
    const held = deferred();
    const deps = preparing ? { prepare: async report => { const selected = await held.promise; report(selected, 'project'); return selected; }, complete: async () => { assert.fail('no completion'); } } : dependencies(async () => held.promise);
    const result = await manager.send(input, deps);
    const snapshot = JSON.stringify(result);
    assert.equal(result.error.code, 'timeout');
    assert.equal(check(result).phase, preparing ? 'preparation' : 'completion');
    assert.equal(result.usageComplete, preparing);
    held.resolve(preparing ? model : reply(secret));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(result), snapshot);
    assert.deepEqual(manager.list(), []);
  }
  const controller = new AbortController(), held = deferred(), manager = new Consultations();
  const deps = dependencies(async () => held.promise);
  const pending = manager.send(input, deps, controller.signal);
  await waitFor(() => deps.requests.length === 1);
  controller.abort();
  const result = await pending;
  assert.equal(result.error.code, 'cancelled');
  assert.equal(check(result).phase, 'completion');
  held.resolve(reply(secret));
});

test('AC-22 registered tool reports project overrides before preparation failures and pins source on continuation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-provider-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved);
  const cwd = join(dir, 'workspace');
  await mkdir(join(cwd, '.pi'), { recursive: true });
  const selected = { provider: 'project-provider', model: 'project-chat', reasoning: 'high' };
  await writeFile(join(dir, 'advisor.json'), JSON.stringify({ model }));
  const projectPath = join(cwd, '.pi', 'advisor.json');
  await writeFile(projectPath, JSON.stringify({ model: selected }));
  const tools = new Map();
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  let auth = false, response = reply(), calls = 0;
  const ctx = { cwd, isProjectTrusted: () => true, modelRegistry: {
    find: (provider, id) => ({ provider, id, api: 'mock-api', reasoning: true, contextWindow: 272000 }),
    hasConfiguredAuth: () => auth,
    streamSimple: () => { calls++; return { result: async () => response }; }
  } };
  const tool = tools.get('advisor');
  async function execute(args) {
    const result = await tool.execute('id', args, undefined, undefined, ctx);
    assert.equal(Compile(tool.outputSchema).Check(result.structuredContent), true);
    assert.deepEqual(result.details, result.structuredContent);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    assert.equal(result.isError, !result.details.ok);
    return result.details;
  }
  const unavailable = await execute(input);
  assert.deepEqual(check(unavailable), { phase: 'preparation', category: 'advisor-error', model: selected, selectionSource: 'project' });
  assert.equal(calls, 0);
  auth = true;
  const first = await execute(input);
  assert.equal(first.ok, true);
  await writeFile(projectPath, JSON.stringify({ model }));
  response = reply(secret, { stopReason: 'error', errorMessage: secret });
  const failed = await execute({ ...input, session: first.session });
  assert.deepEqual(check(failed), { phase: 'response-validation', category: 'provider-error', model: selected, selectionSource: 'project' });
  assert.equal(calls, 2);
  const defaultResult = await execute({ message: 'Q' });
  assert.equal(defaultResult.error.diagnostics, undefined);
  ctx.isProjectTrusted = () => false;
  const globalFailure = await execute(input);
  assert.deepEqual(check(globalFailure), { phase: 'response-validation', category: 'provider-error', model, selectionSource: 'global' });
});

test('AC-22 failure renderer displays only safe diagnostics with terminal width protections', async () => {
  const result = await new Consultations().send(input, dependencies(async () => { throw { status: 401, message: secret }; }));
  const theme = { fg: (_color, text) => text, bold: text => text };
  const renderer = toolRenderers('advisor');
  const text = renderer.renderResult({ details: result }, { expanded: false, isPartial: false }, theme).render(200).join('\n');
  assert.match(text, /Failure phase: completion.*authentication/);
  assert.match(text, /mock\/chat.*unknown/);
  assert.equal(text.includes(secret), false);
  for (const width of [1, 8, 30, 80]) {
    for (const line of renderer.renderResult({ details: result }, { expanded: true, isPartial: false }, theme).render(width)) assert.ok(line.length <= width);
  }
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const text of ['"diagnostics": true', 'selectionSource', 'provider-error', 'local-error', 'zero billing', 'not permission to retry']) assert.ok(readme.includes(text), text);
});
