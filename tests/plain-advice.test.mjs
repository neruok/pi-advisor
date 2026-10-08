import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import extension from '../advisor.ts';
import { Consultations } from '../lib/session.ts';
import { ADVISOR_PROMPT, MAIN_GUIDANCE } from '../lib/prompt.ts';
import { AdviceSchema, ListSchema } from '../lib/schemas.ts';
import { dependencies, reply, model } from './helpers.mjs';

const examples = [
  ['ordinary advice', 'Test addition with zero and a negative operand.'],
  ['surrounding whitespace', ' \nAdvice without a classification.\n\t '],
  ['quoted marker', 'The literal "[CONTINUE]" is just text.'],
  ['inline marker', 'Advice. [ACTIONABLE]'],
  ['repeated markers', 'Advice.\n[CONTINUE]\n[EXHAUSTED]'],
  ['unknown marker', 'Advice.\n[UNKNOWN]'],
  ['marker-only text', '[APPROVAL_NEEDED]'],
  ['JSON-looking text', '{"status":"actionable","advice":"Test zero."}'],
  ['code-fenced text', '```text\nAdvice.\n[ACTIONABLE]\n```']
];
for (const [name, response] of examples) {
  test(`AC-17 ${name} is returned and retained without interpretation`, async () => {
    const manager = new Consultations(), firstDeps = dependencies(async () => reply(response));
    const first = await manager.send({ message: 'Q' }, firstDeps);
    assert.equal(first.ok, true);
    assert.equal(first.response, response);
    assert.equal(firstDeps.requests.length, 1);
    assert.equal(first.usageComplete, true);
    const nextDeps = dependencies();
    await manager.send({ session: first.session, message: 'Next' }, nextDeps);
    assert.equal(nextDeps.requests[0].context.messages[2].content[0].text, response);
  });
}

test('AC-17 AC-29 success and discovery omit status without a replacement classification', async () => {
  const manager = new Consultations();
  const result = await manager.send({ message: 'Q' }, dependencies());
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, 'status'), false);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'advisory', 'session', 'response', 'turns', 'model', 'usage', 'usageComplete', 'totalUsage', 'totalUsageComplete', 'contextUsage'].sort());
  const entry = manager.list()[0];
  assert.equal(Object.hasOwn(entry, 'status'), false);
  assert.deepEqual(Object.keys(entry).sort(), ['session', 'label', 'turns', 'model', 'busy', 'turnsRemaining', 'historyBytes', 'contextUsage', 'totalUsage', 'totalUsageComplete'].sort());
});

test('AC-17 joins text blocks without trimming or retaining thinking', async () => {
  const manager = new Consultations();
  const content = [{ type: 'text', text: '  First paragraph.' }, { type: 'thinking', thinking: 'SECRET_REASONING' }, { type: 'text', text: 'Second paragraph.\n ' }];
  const response = '  First paragraph.\nSecond paragraph.\n ';
  const first = await manager.send({ message: 'Q' }, dependencies(async () => reply(undefined, { content })));
  assert.equal(first.ok, true);
  assert.equal(first.response, response);
  const next = dependencies();
  await manager.send({ session: first.session, message: 'Evidence' }, next);
  assert.equal(next.requests[0].context.messages[2].content[0].text, response);
  assert.doesNotMatch(JSON.stringify(first) + JSON.stringify(next.requests), /SECRET_REASONING/);
});

test('AC-17 prompt and guidance impose no response marker or status protocol', () => {
  assert.doesNotMatch(ADVISOR_PROMPT, /\[(?:CONTINUE|ACTIONABLE|APPROVAL_NEEDED|EXHAUSTED)\]|standalone final marker/i);
  assert.doesNotMatch(MAIN_GUIDANCE.join('\n'), /statuses|status marker/i);
  assert.match(ADVISOR_PROMPT, /natural.language/i);
  assert.match(ADVISOR_PROMPT, /not evidence or authorization/i);
});

test('AC-17 strict schemas accept status-free envelopes and reject old status fields', async () => {
  const manager = new Consultations();
  const result = await manager.send({ message: 'Q' }, dependencies());
  const { status: _oldStatus, ...withoutStatus } = result;
  assert.equal(Compile(AdviceSchema).Check(withoutStatus), true);
  assert.equal(Compile(AdviceSchema).Check({ ...withoutStatus, status: 'continue' }), false);
  const entries = manager.list().map(({ status: _status, ...entry }) => entry);
  assert.equal(Compile(ListSchema).Check({ ok: true, sessions: entries }), true);
  assert.equal(Compile(ListSchema).Check({ ok: true, sessions: [{ ...entries[0], status: 'continue' }] }), false);
});

test('AC-17 registered tools and renderers return plain advice without semantic status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-plain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved);
  await writeFile(join(dir, 'advisor.json'), JSON.stringify({ model }));
  const tools = new Map();
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  const requests = [];
  const ctx = { cwd: dir, isProjectTrusted: () => false, modelRegistry: {
    find: () => ({ provider: model.provider, id: model.model, api: 'mock-api', contextWindow: 272000 }), hasConfiguredAuth: () => true,
    streamSimple: (_model, context) => { requests.push(context); return { result: async () => reply('Plain recommendation.') }; }
  } };
  const tool = tools.get('advisor');
  const first = await tool.execute('one', { message: 'Q' }, undefined, undefined, ctx);
  assert.equal(first.details.ok, true);
  assert.equal(first.details.response, 'Plain recommendation.');
  assert.deepEqual(JSON.parse(first.content[0].text), first.details);
  assert.deepEqual(first.structuredContent, first.details);
  assert.equal(Compile(tool.outputSchema).Check(first.details), true);
  const second = await tool.execute('two', { session: first.details.session, message: 'Evidence' }, undefined, undefined, ctx);
  assert.equal(second.details.turns, 2);
  assert.equal(second.details.totalUsage.input, 20);
  assert.equal(requests[1].messages[2].content[0].text, first.details.response);
  const theme = { fg: (_key, text) => text, bold: text => text };
  for (const expanded of [false, true]) {
    const view = tool.renderResult(first, { expanded, isPartial: false }, theme).render(120).join('\n');
    assert.match(view, /Advisory •/);
    assert.doesNotMatch(view, /undefined|continue|actionable|approval_needed|exhausted/);
  }
  const listTool = tools.get('advisor_sessions');
  const list = await listTool.execute('list', {}, undefined, undefined, ctx);
  assert.equal(Compile(listTool.outputSchema).Check(list.details), true);
  for (const expanded of [false, true]) {
    const view = listTool.renderResult(list, { expanded, isPartial: false }, theme).render(120).join('\n');
    assert.doesNotMatch(view, /undefined|continue|actionable|approval_needed|exhausted/);
  }
  await tools.get('advisor_close').execute('close', { session: first.details.session }, undefined, undefined, ctx);
});

test('AC-17 README describes free-form advice and extension-generated envelopes', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /free.form/i);
  assert.match(readme, /extension.*structured.*envelope/i);
  assert.doesNotMatch(readme, /Statuses are|response, status|advisory status|Replies must end/);
});
