import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Consultations } from '../lib/session.ts';
import { ADVISOR_PROMPT, MAIN_GUIDANCE } from '../lib/prompt.ts';
import { dependencies, reply } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillPath = join(root, 'skills/socratic-reasoning/SKILL.md');
async function skillText() {
  try { return await readFile(skillPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

// Structural/instruction checks only. No claim that a model obeys the workflow.
test('AC-33 AC-36 package loader discovers the Socratic skill alongside adversarial review without provider work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-socratic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [root],
  });
  await loader.reload();
  const loaded = loader.getSkills();
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.skills.map(skill => skill.name).sort(), ['adversarial-review', 'socratic-reasoning']);
  const skill = loaded.skills.find(skill => skill.name === 'socratic-reasoning');
  assert.equal(skill.filePath, skillPath);
  assert.equal(skill.disableModelInvocation, false);
  assert.match(skill.description, /agent.advisor/i);
  assert.match(skill.description, /debugging|design|diagnosis/i);
  assert.ok(skill.description.length <= 1024);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  assert.ok(manifest.files.includes('skills/**'));
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  assert.equal(extensions.extensions.length, 1);
  assert.deepEqual([...extensions.extensions[0].tools.keys()].sort(), ['advisor', 'advisor_close', 'advisor_sessions']);
  assert.deepEqual([...extensions.extensions[0].commands.keys()], ['advisor']);
});

test('AC-34 skill describes framing, focused questions, evidence and same-session continuation', async () => {
  const text = await skillText();
  for (const term of ['## Frame the issue', '## Ask the advisor', '## Gather evidence', '## Continue or stop', '## Finish',
    'acceptance criteria', 'observations', 'assumptions', 'uncertainty', 'constraints', 'alternative explanations',
    'distinguish', 'same session', 'new evidence', 'private chain-of-thought']) assert.ok(text.includes(term), term);
  assert.match(text, /not evidence or authorization/);
  assert.match(text, /verify.*claims/i);
  assert.match(text, /"session": "adv_<returned-id>"/);
  assert.match(text, /questions.*rather than.*finished solution/i);
});

test('AC-34 skill defines progress, stopping, failure and privacy boundaries', async () => {
  const text = await skillText();
  for (const term of ['no new evidence', 'inaccessible', 'user-owned decision', 'user limit', 'cancel', 'failure',
    'Do not retry', 'unavailable', 'missing', 'secrets', 'charges', 'ephemeral', 'transcript',
    'advisor_sessions', 'advisor_close', 'stop reason', 'does not enforce']) assert.ok(text.includes(term), term);
  assert.match(text, /Before each.*call/);
  assert.match(text, /Do not.*expand.*task/);
  assert.match(text, /Do not.*change.*settings/);
  assert.match(text, /Do not.*JSON.*markers/);
  assert.match(text, /idle consultation/);
  assert.match(text, /does not.*erase.*transcript/);
});

test('AC-34 README explains explicit invocation and main-agent-only scope', async () => {
  const text = await readFile(join(root, 'README.md'), 'utf8');
  assert.match(text, /\/skill:socratic-reasoning/);
  assert.match(text, /agent.advisor questioning loop/i);
  assert.match(text, /skill guides the main agent/i);
  assert.match(text, /does not change the fixed default advisor prompt/i);
  assert.match(text, /not a user interview/i);
});

test('AC-35 AC-38 ordinary natural-language consultation, isolation and cleanup stay unchanged', async () => {
  const manager = new Consultations();
  const firstDeps = dependencies(async () => reply('Test the signal before assuming a lost wakeup.'));
  const first = await manager.send({ message: 'The worker does not wake.' }, firstDeps);
  assert.equal(first.ok, true);
  assert.equal(first.response, 'Test the signal before assuming a lost wakeup.');
  assert.equal(firstDeps.requests[0].context.messages[0].content, ADVISOR_PROMPT);
  assert.equal(firstDeps.requests[0].context.messages.length, 2);
  assert.deepEqual(firstDeps.requests[0].context.messages[0].toolsAdded, []);
  const nextDeps = dependencies(async () => reply('Check the predicate under the lock.'));
  const next = await manager.send({ session: first.session, message: 'The signal fires before the wait.' }, nextDeps);
  assert.equal(next.ok, true);
  assert.equal(next.session, first.session);
  assert.equal(next.turns, 2);
  assert.equal(nextDeps.requests[0].context.messages.length, 4);
  assert.equal(nextDeps.requests[0].context.messages[2].content[0].text, first.response);
  assert.doesNotMatch(ADVISOR_PROMPT + MAIN_GUIDANCE.join('\n'), /socratic-reasoning|Socratic|adversarial-review/);
  assert.equal(manager.list()[0].session, first.session);
  assert.equal(manager.close(first.session).ok, true);
  assert.deepEqual(manager.list(), []);
});
