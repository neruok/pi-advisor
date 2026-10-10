import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillPath = join(root, 'skills/adversarial-review/SKILL.md');
async function skillText() {
  try { return await readFile(skillPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

// Check discovery and authored instructions, not model compliance or review quality.
test('AC-36 package discovers both advisor skills with host-provided resources', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-adversarial-'));
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
  const skill = loaded.skills.find(skill => skill.name === 'adversarial-review');
  assert.equal(skill.filePath, skillPath);
  assert.equal(skill.disableModelInvocation, false);
  assert.match(skill.description, /proposed fix|design/i);
  assert.match(skill.description, /counterexamples/i);
  assert.ok(skill.description.length <= 1024);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  assert.ok(manifest.files.includes('skills/**'));
  assert.equal(manifest.dependencies, undefined);
});

test('AC-37 skill frames a versioned candidate and requests concrete criticism without a defect quota', async () => {
  const text = await skillText();
  for (const term of ['## Frame the candidate', '## Ask for counterexamples', '## Verify findings', '## Continue or stop', '## Report and close',
    'candidate identity', 'uncommitted diff', 'requirements', 'assumptions', 'constraints', 'counterexamples',
    'failure conditions', 'missing tests', 'unsupported claims', 'expected behavior', 'observed behavior']) assert.ok(text.includes(term), term);
  assert.match(text, /Do not.*defect quota/);
  assert.match(text, /advisor cannot read this skill/);
  assert.match(text, /review.only/i);
  assert.match(text, /"session": "adv_<returned-id>"/);
});

test('AC-37 skill separates confirmed, refuted and unresolved findings using covering evidence', async () => {
  const text = await skillText();
  for (const term of ['Confirmed', 'Refuted', 'Unresolved', 'consequence', 'source', 'affected claims',
    'changed candidate', 'non-covering test', 'not evidence or authorization', 'No findings', 'not approval',
    'user-owned decision', 'reviewed dimensions']) assert.ok(text.includes(term), term);
  assert.match(text, /verify.*claims/i);
  assert.match(text, /non-covering test.*not.*refute/i);
  assert.match(text, /Do not.*invent.*defects/);
  assert.match(text, /Do not.*implement.*unless.*authorized/i);
  assert.match(text, /labels.*main.agent bookkeeping/i);
  assert.match(text, /recheck.*affected claims/i);
});

test('AC-37 skill bounds consultation progress and preserves authority, cost and privacy limits', async () => {
  const text = await skillText();
  for (const term of ['new evidence', 'changed candidate', 'testable concern', 'stop reason', 'cancel', 'user limit',
    'failure', 'Do not retry', 'missing', 'unavailable', 'inaccessible', 'charges', 'secrets',
    'private chain-of-thought', 'ephemeral', 'transcript', 'advisor_sessions', 'advisor_close']) assert.ok(text.includes(term), term);
  assert.match(text, /Before each.*call/);
  assert.match(text, /same issue.*same session/);
  assert.match(text, /Do not.*expand.*scope/);
  assert.match(text, /Do not.*change.*settings/);
  assert.match(text, /Do not.*JSON.*markers/);
  assert.match(text, /idle consultation/);
  assert.match(text, /does not.*erase.*transcript/);
  assert.match(text, /does not enforce.*termination.*billing/);
});

test('AC-37 README documents explicit invocation and distinguishes review from Socratic investigation', async () => {
  const text = await readFile(join(root, 'README.md'), 'utf8');
  assert.match(text, /\/skill:adversarial-review/);
  assert.match(text, /adversarial.*review.*concrete candidate/i);
  assert.match(text, /Socratic.*unresolved problem/i);
  assert.match(text, /review.only/i);
  assert.match(text, /does not change the fixed default advisor prompt/);
});
