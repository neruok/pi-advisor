import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import extension from '../advisor.ts';
import { Consultations } from '../lib/session.ts';
import { parseInput, zeroUsage } from '../lib/protocol.ts';
import { ADVISOR_PROMPT } from '../lib/prompt.ts';
import { InputSchema, AdviceSchema, ListSchema, FailureSchema, CloseSchema } from '../lib/schemas.ts';
import { toolRenderers } from '../lib/render.ts';
import { dependencies, reply, deferred, waitFor } from './helpers.mjs';

const presets = ['default', 'socratic-reasoning', 'adversarial-review'];
const theme = { fg: (_key, text) => text, bold: text => text };
const emptyReply = text => reply(text, { usage: zeroUsage() });
const tokens = messages => messages.reduce((sum, message) => sum + estimateTokens(message), 0);
const view = (kind, details, expanded) => toolRenderers(kind).renderResult({ details }, { expanded, isPartial: false }, theme).render(240).join('\n');
const withWindow = (window, complete = async () => emptyReply('A')) => Object.assign(dependencies(complete), { getContextWindow: () => window });

// All provider work is mocked. Prompt/instruction checks do not establish compliance.
test('AC-39 optional and explicit default preserve the previous system prompt', async () => {
  // Golden bytes from the pre-preset prompt at project revision 11667b1.
  assert.equal(createHash('sha256').update(ADVISOR_PROMPT).digest('hex'), 'b31f425ad31b93f2c6fa6eea3142e51881f7b5b2ce62b25e1d5cfa18060daaae');
  for (const input of [{ message: 'Q' }, { message: 'Q', preset: 'default' }]) {
    const deps = dependencies(), manager = new Consultations();
    const result = await manager.send(input, deps);
    assert.equal(result.ok, true);
    assert.equal(result.preset, 'default');
    assert.equal(deps.requests[0].context.messages[0].content, ADVISOR_PROMPT);
    assert.equal(manager.list()[0].preset, 'default');
  }
});

test('AC-39 strict preset names reject invalid values and arbitrary prompt fields before preparation', async () => {
  const schema = Compile(InputSchema);
  for (const preset of presets) assert.equal(schema.Check({ message: 'Q', preset }), true);
  for (const preset of ['', ' default', 'default ', 'Socratic', 'socratic', 'custom', null, false, 1, [], {}, ADVISOR_PROMPT]) {
    const manager = new Consultations(), deps = dependencies();
    deps.prepare = async () => assert.fail('invalid input must not prepare');
    assert.equal(schema.Check({ message: 'Q', preset }), false);
    assert.throws(() => parseInput({ message: 'Q', preset }), { code: 'invalid-argument' });
    const result = await manager.send({ message: 'Q', preset }, deps);
    assert.equal(result.error.code, 'invalid-argument'); assert.equal(result.usageComplete, true);
    assert.equal(deps.requests.length, 0); assert.deepEqual(manager.list(), []);
  }
  for (const key of ['prompt', 'systemPrompt']) {
    const input = { message: 'Q', [key]: 'OVERRIDE' }, deps = dependencies();
    deps.prepare = async () => assert.fail('prompt override must not prepare');
    assert.equal(schema.Check(input), false);
    assert.equal((await new Consultations().send(input, deps)).error.code, 'invalid-argument');
    assert.equal(deps.requests.length, 0);
  }
});

for (const preset of presets) {
  test(`AC-39 AC-40 ${preset}: reject all continuation presets without changing history`, async () => {
    const manager = new Consultations(), first = await manager.send({ message: 'Q', preset }, dependencies());
    assert.equal(first.ok, true);
    const before = manager.list();
    for (const supplied of [...presets, undefined, null, 'unknown']) {
      const deps = dependencies(); deps.prepare = async () => assert.fail('continuation validation must not prepare');
      const result = await manager.send({ session: first.session, message: 'NOT_COMMITTED', preset: supplied }, deps);
      assert.equal(result.error.code, 'invalid-argument'); assert.equal(deps.requests.length, 0);
      assert.deepEqual(manager.list(), before);
      assert.equal(Compile(FailureSchema).Check(result), true);
    }
    const unknown = await manager.send({ session: 'adv_UNKNOWN', message: 'Q' }, dependencies());
    assert.equal(unknown.error.code, 'not-found');
    const nextDeps = dependencies(), next = await manager.send({ session: first.session, message: 'Evidence' }, nextDeps);
    assert.equal(next.ok, true); assert.equal(next.turns, 2); assert.equal(next.preset, preset);
    assert.doesNotMatch(JSON.stringify(nextDeps.requests), /NOT_COMMITTED/);
    assert.equal(nextDeps.requests[0].context.messages[0].content, (await capturePrompt(preset)));
  });

  test(`AC-40 ${preset}: every context consumer uses the pinned prompt with zero reported usage`, async () => {
    const manager = new Consultations(), deps = withWindow(10000), first = await manager.send({ message: 'Q', preset }, deps);
    assert.equal(first.ok, true);
    const request = deps.requests[0], prompt = request.context.messages[0].content;
    const committed = [...request.context.messages, emptyReply('A')];
    assert.equal(first.contextUsage.tokens, tokens(committed));
    assert.deepEqual(manager.list()[0].contextUsage, first.contextUsage);
    const gate = deferred(), nextDeps = withWindow(1, async () => gate.promise);
    nextDeps.prepare = async () => assert.fail('model must remain pinned');
    const pending = manager.send({ session: first.session, message: 'Evidence' }, nextDeps);
    await waitFor(() => nextDeps.requests.length === 1);
    const busy = manager.list()[0]; assert.equal(busy.busy, true); assert.equal(busy.preset, preset);
    assert.deepEqual(busy.contextUsage, first.contextUsage);
    const busyDeps = dependencies(), busyResult = await manager.send({ session: first.session, message: 'CONCURRENT' }, busyDeps);
    assert.equal(busyResult.error.code, 'busy'); assert.equal(busyDeps.requests.length, 0);
    assert.deepEqual(busyResult.contextUsage, first.contextUsage); assert.equal(busyResult.totalUsageComplete, false);
    const continued = nextDeps.requests[0];
    assert.equal(continued.context.messages[0].content, prompt);
    assert.equal(continued.options.sessionId, request.options.sessionId);
    assert.equal(continued.options.cacheRetention, 'short'); assert.equal(continued.options.maxRetries, 0);
    assert.deepEqual(continued.context.messages[0].toolsAdded, []);
    assert.equal(continued.context.tools, undefined);
    gate.resolve(emptyReply('B'));
    const next = await pending; assert.equal(next.ok, true);
    assert.equal(next.contextUsage.tokens, tokens([...continued.context.messages, emptyReply('B')]));
    assert.deepEqual(manager.list()[0].contextUsage, next.contextUsage);
    const badDeps = dependencies(async () => reply('REJECTED', { stopReason: 'length' }));
    const failed = await manager.send({ session: first.session, message: 'FAILURE' }, badDeps);
    assert.equal(failed.error.code, 'invalid-response'); assert.deepEqual(failed.contextUsage, next.contextUsage);
    assert.equal(badDeps.requests[0].context.messages[0].content, prompt);
    assert.equal(manager.list()[0].turns, 2); assert.equal(manager.list()[0].preset, preset);
    assert.equal(failed.totalUsage.totalTokens, 13); assert.equal(failed.usageComplete, true);
    assert.equal(Object.hasOwn(failed, 'preset'), false);
    const resume = dependencies(), resumed = await manager.send({ session: first.session, message: 'Resume' }, resume);
    assert.equal(resumed.ok, true); assert.equal(resumed.preset, preset);
    assert.doesNotMatch(JSON.stringify(resume.requests), /REJECTED|FAILURE/);
  });

  test(`AC-40 ${preset}: pending and committed context equality is inclusive, overflow rolls back`, async () => {
    const sampleDeps = withWindow(10000);
    assert.equal((await new Consultations().send({ message: 'Q', preset }, sampleDeps)).ok, true);
    const messages = sampleDeps.requests[0].context.messages, pending = tokens(messages), committed = tokens([...messages, emptyReply('A')]);
    const atPending = withWindow(pending);
    // Positive model usage is authoritative after dispatch; isolate the pending boundary.
    atPending.complete = dependencies(async () => reply('A', { usage: { ...zeroUsage(), totalTokens: pending } })).complete;
    assert.equal((await new Consultations().send({ message: 'Q', preset }, atPending)).ok, true);
    const overPending = withWindow(pending - 1), noSend = new Consultations();
    const preflight = await noSend.send({ message: 'Q', preset }, overPending);
    assert.deepEqual(preflight.error.limit, { resource: 'context-tokens', maximum: pending - 1, actual: pending });
    assert.equal(overPending.requests.length, 0); assert.deepEqual(noSend.list(), []);
    const equal = new Consultations(), accepted = await equal.send({ message: 'Q', preset }, withWindow(committed));
    assert.equal(accepted.ok, true); assert.equal(accepted.contextUsage.percent, 100);
    const overflow = new Consultations(), rejected = await overflow.send({ message: 'Q', preset }, withWindow(committed - 1));
    assert.deepEqual(rejected.error.limit, { resource: 'context-tokens', maximum: committed - 1, actual: committed });
    assert.deepEqual(overflow.list(), []); assert.equal(rejected.usageComplete, true);
    const deps = withWindow(1); const rolledBack = await equal.send({ session: accepted.session, message: 'More' }, deps);
    assert.equal(rolledBack.error.code, 'limit-exceeded'); assert.equal(deps.requests.length, 0);
    assert.deepEqual(rolledBack.contextUsage, accepted.contextUsage); assert.equal(equal.list()[0].turns, 1);
  });
}

async function capturePrompt(preset) {
  const deps = dependencies(), first = await new Consultations().send({ message: 'Q', preset }, deps);
  assert.equal(first.ok, true); return deps.requests[0].context.messages[0].content;
}

test('AC-40 AC-42 presets preserve the entire safeguard prompt and isolate role and history', async () => {
  const manager = new Consultations(), seen = [];
  for (const preset of presets) {
    const deps = dependencies(async () => reply(`Answer for ${preset}`));
    const first = await manager.send({ message: `Question for ${preset}`, preset }, deps);
    assert.equal(first.ok, true);
    const messages = deps.requests[0].context.messages, prompt = messages[0].content;
    assert.equal(messages.length, 2); assert.equal(messages[1].content, `Question for ${preset}`);
    assert.ok(prompt.startsWith(ADVISOR_PROMPT));
    const suffix = prompt.slice(ADVISOR_PROMPT.length); assert.ok(suffix.length < 1600);
    assert.doesNotMatch(suffix, /\[(?:CONTINUE|ACTIONABLE|APPROVAL_NEEDED|EXHAUSTED)\]|must.*(?:JSON|marker)|private chain.of.thought/i);
    if (preset === 'socratic-reasoning') {
      assert.match(suffix, /focused questions/i); assert.match(suffix, /alternative explanations/i);
      assert.match(suffix, /distinguish/i); assert.match(suffix, /finished solution/i);
      assert.doesNotMatch(suffix, /defect quota/);
    } else if (preset === 'adversarial-review') {
      for (const term of ['concrete candidate', 'counterexamples', 'failure conditions', 'missing tests', 'unsupported claims', 'defect quota']) assert.ok(suffix.includes(term), term);
      assert.match(suffix, /missing evidence.*demonstrated defect/i);
      assert.doesNotMatch(suffix, /questioning partner/);
    } else assert.equal(suffix, '');
    seen.push({ preset, prompt, session: first.session, cacheId: deps.requests[0].options.sessionId });
  }
  assert.equal(new Set(seen.map(entry => entry.prompt)).size, 3);
  assert.equal(new Set(seen.map(entry => entry.cacheId)).size, 3);
  for (const entry of seen) {
    const deps = dependencies(), next = await manager.send({ session: entry.session, message: `Evidence for ${entry.preset}` }, deps);
    assert.equal(next.ok, true); assert.equal(next.preset, entry.preset);
    const messages = deps.requests[0].context.messages;
    assert.equal(messages.length, 4); assert.equal(messages[0].content, entry.prompt);
    assert.equal(messages[1].content, `Question for ${entry.preset}`);
    assert.equal(messages[2].content[0].text, `Answer for ${entry.preset}`);
    assert.equal(messages[3].content, `Evidence for ${entry.preset}`);
  }
});

test('AC-40 initial busy discovery measures the pinned prompt without uncommitted input', async () => {
  for (const preset of presets) {
    const manager = new Consultations(), gate = deferred(), deps = withWindow(10000, async () => gate.promise);
    const pending = manager.send({ message: 'NOT_YET_COMMITTED', preset }, deps);
    await waitFor(() => deps.requests.length === 1);
    const entry = manager.list()[0];
    assert.equal(entry.busy, true); assert.equal(entry.turns, 0); assert.equal(entry.preset, preset);
    assert.equal(entry.contextUsage.tokens, tokens([deps.requests[0].context.messages[0]]));
    assert.equal(entry.totalUsageComplete, false);
    gate.resolve(emptyReply('A'));
    const first = await pending; assert.equal(first.ok, true); assert.equal(first.session, entry.session);
    assert.equal(manager.close(first.session).ok, true);
  }
});

test('AC-41 successful results, strict discovery schemas and both TUI views expose preset snapshots', async () => {
  const manager = new Consultations();
  for (const preset of presets) {
    const first = await manager.send({ message: 'Q', preset }, dependencies()); assert.equal(first.ok, true);
    assert.equal(Compile(AdviceSchema).Check(first), true); assert.equal(first.preset, preset);
    const { preset: _preset, ...withoutPreset } = first;
    assert.equal(Compile(AdviceSchema).Check(withoutPreset), false);
    assert.equal(Compile(AdviceSchema).Check({ ...first, preset: 'custom' }), false);
    for (const expanded of [false, true]) assert.ok(view('advisor', first, expanded).includes(`preset: ${preset}`));
    first.preset = 'MUTATED'; manager.list().find(entry => entry.session === first.session).preset = 'MUTATED';
    assert.equal(manager.list().find(entry => entry.session === first.session).preset, preset);
  }
  const entries = manager.list(); assert.equal(Compile(ListSchema).Check({ ok: true, sessions: entries }), true);
  for (const expanded of [false, true]) for (const preset of presets) assert.ok(view('advisor_sessions', { ok: true, sessions: entries }, expanded).includes(`preset: ${preset}`));
  const invalid = structuredClone(entries); delete invalid[0].preset;
  assert.equal(Compile(ListSchema).Check({ ok: true, sessions: invalid }), false);
  invalid[0].preset = 'custom';
  assert.equal(Compile(ListSchema).Check({ ok: true, sessions: invalid }), false);
  assert.equal(Compile(CloseSchema).Check(manager.close(entries[0].session)), true);
});

test('AC-41 each skill selects its own preset only at creation and checks recovery metadata', async () => {
  for (const preset of presets.slice(1)) {
    const text = await readFile(new URL(`../skills/${preset}/SKILL.md`, import.meta.url), 'utf8');
    const examples = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    assert.equal(examples[0].preset, preset);
    assert.ok(examples[0].message.length > 100); assert.equal(examples[0].session, undefined);
    assert.equal(examples[1].preset, undefined); assert.ok(examples[1].session);
    assert.match(text, /preset.*mismatch|mismatch.*preset/i);
    assert.match(text, /Do not.*preset.*continuation/i);
    assert.match(text, /selected.*prompt|preset.*prompt/i);
  }
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /start.only/i); assert.match(readme, /byte.for.byte/i);
  for (const preset of presets) assert.ok(readme.includes(preset));
});

test('AC-41 registered tool dispatch and structured outputs carry presets without settings changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-presets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => old === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = old);
  const settings = JSON.stringify({ model: { provider: 'mock', model: 'chat' } });
  await writeFile(join(dir, 'advisor.json'), settings);
  const tools = new Map(), requests = [];
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  const ctx = { cwd: dir, isProjectTrusted: () => false, modelRegistry: {
    find: (provider, id) => ({ provider, id, api: 'mock-api', contextWindow: 10000 }), hasConfiguredAuth: () => true,
    streamSimple: (_model, context, options) => { requests.push({ context, options }); return { result: async () => reply('Advice') }; }
  } };
  for (const preset of presets) {
    const result = await tools.get('advisor').execute('start', { message: 'Q', preset }, undefined, undefined, ctx);
    assert.equal(result.isError, false); assert.equal(result.details.preset, preset);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details); assert.deepEqual(result.structuredContent, result.details);
    assert.equal(Compile(tools.get('advisor').outputSchema).Check(result.details), true);
  }
  assert.equal(requests.length, 3);
  const listing = await tools.get('advisor_sessions').execute('list', {}, undefined, undefined, ctx);
  assert.deepEqual(listing.details.sessions.map(entry => entry.preset), presets);
  assert.equal(Compile(tools.get('advisor_sessions').outputSchema).Check(listing.details), true);
  assert.match(tools.get('advisor').parameters.properties.preset.description, /start.only/i);
  assert.equal(await readFile(join(dir, 'advisor.json'), 'utf8'), settings);
});

test('AC-42 all presets return marker-looking and JSON-looking text unchanged', async () => {
  for (const preset of presets) for (const response of ['  Natural-language advice.\n ', '[CONTINUE]', '{"status":"confirmed"}']) {
    const manager = new Consultations(), first = await manager.send({ message: 'Q', preset }, dependencies(async () => reply(response)));
    assert.equal(first.ok, true); assert.equal(first.response, response); assert.equal(first.status, undefined);
    const next = dependencies(); await manager.send({ session: first.session, message: 'Evidence' }, next);
    assert.equal(next.requests[0].context.messages[2].content[0].text, response);
  }
});
