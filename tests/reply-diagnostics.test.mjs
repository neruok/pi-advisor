import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import extension from '../advisor.ts';
import { Consultations } from '../lib/session.ts';
import { dependencies, reply, model } from './helpers.mjs';

const suffix = ' No exchange was committed.';
const cases = [
  ['abnormal completion', { stopReason: 'length' }, 'Advisor completion did not stop normally.'],
  ['unsupported content', { content: [{ type: 'toolCall', name: 'SECRET_TOOL', arguments: {} }] }, 'Advisor reply contained unsupported or malformed content.'],
  ['null content', { content: [null] }, 'Advisor reply contained unsupported or malformed content.'],
  ['nonstring text', { content: [{ type: 'text', text: 123 }] }, 'Advisor reply contained unsupported or malformed content.'],
  ['absent text', { content: [{ type: 'thinking', thinking: 'SECRET_THINKING' }] }, 'Advisor reply contained no nonblank text.']
];

for (const [name, patch, message] of cases) {
  test(`AC-16 ${name} has a fixed private diagnostic and rolls back creation`, async () => {
    const manager = new Consultations(), deps = dependencies(async () => reply(undefined, patch));
    const result = await manager.send({ message: 'Q' }, deps);
    assert.equal(result.error.code, 'invalid-response');
    assert.equal(result.error.message, message + suffix);
    assert.equal(deps.requests.length, 1);
    assert.equal(result.usageComplete, true);
    assert.equal(result.usage.input, 10);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_|123/);
    assert.deepEqual(manager.list(), []);
  });
}

test('AC-16 rejected continuation preserves history and counts usage without retry', async () => {
  const manager = new Consultations();
  const first = await manager.send({ message: 'INITIAL' }, dependencies());
  const bad = dependencies(async () => reply('SECRET_REPLY', { stopReason: 'length' }));
  const failed = await manager.send({ session: first.session, message: 'REJECTED_INPUT' }, bad);
  assert.equal(failed.error.message, 'Advisor completion did not stop normally.' + suffix);
  assert.equal(bad.requests.length, 1);
  assert.equal(failed.session, first.session);
  assert.equal(failed.totalUsage.input, 20);
  assert.equal(failed.totalUsageComplete, true);
  assert.equal(manager.list()[0].turns, 1);
  const good = dependencies();
  const next = await manager.send({ session: first.session, message: 'NEXT' }, good);
  assert.equal(next.turns, 2);
  assert.equal(next.totalUsage.input, 30);
  assert.doesNotMatch(JSON.stringify(good.requests[0].context), /REJECTED_INPUT|SECRET_REPLY/);
});

test('AC-16 tool diagnostics preserve schemas and coherent final results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved);
  await writeFile(join(dir, 'advisor.json'), JSON.stringify({ model }));
  const tools = new Map();
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  const tool = tools.get('advisor');
  let requests = 0;
  const ctx = { cwd: dir, isProjectTrusted: () => false, modelRegistry: {
    find: () => ({ provider: model.provider, id: model.model, api: 'mock-api', contextWindow: 272000 }),
    hasConfiguredAuth: () => true,
    streamSimple: () => { requests++; return { result: async () => reply('SECRET_REPLY', { stopReason: 'length' }) }; }
  } };
  const result = await tool.execute('test', { message: 'Q' }, undefined, undefined, ctx);
  assert.equal(result.details.error.message, 'Advisor completion did not stop normally.' + suffix);
  assert.equal(Compile(tool.outputSchema).Check(result.structuredContent), true);
  assert.deepEqual(result.details, result.structuredContent);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.equal(result.isError, true);
  assert.equal(result.usage.input, 10);
  assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_REPLY/);
});
