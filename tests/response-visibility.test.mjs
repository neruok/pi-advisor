import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth, wrapTextWithAnsi, truncateToWidth } from '@earendil-works/pi-tui';
import { Compile } from 'typebox/compile';
import extension from '../advisor.ts';
import { reply, model } from './helpers.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-visibility-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved);
  await writeFile(join(dir, 'advisor.json'), JSON.stringify({ model }));
  const tools = new Map(), sideEffects = [];
  extension({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {},
    sendMessage: (...args) => sideEffects.push(['message', args]), sendUserMessage: (...args) => sideEffects.push(['user', args]), appendEntry: (...args) => sideEffects.push(['entry', args]) });
  let requests = 0;
  const ctx = { cwd: dir, mode: 'tui', hasUI: true, isProjectTrusted: () => false, modelRegistry: {
    find: () => ({ provider: model.provider, id: model.model, api: 'mock-api', contextWindow: 272000 }), hasConfiguredAuth: () => true,
    streamSimple: () => { requests++; return { result: async () => reply() }; }
  } };
  return { tools, ctx, sideEffects, requestCount: () => requests };
}
const theme = { fg: (_key, text) => text, bold: text => text };
const normalized = text => text.replace(/\x1b\[0m/g, '').replace(/\s/gu, '');
function view(tool, result, expanded, width, isPartial = false) {
  const lines = tool.renderResult(result, { expanded, isPartial }, theme).render(width);
  assert.ok(lines.every(line => visibleWidth(line) <= width));
  assert.ok(lines.every(line => !/[\x00-\x1f\x7f-\x9f]/u.test(line.replace(/\x1b\[0m/g, ''))));
  return lines.join('\n');
}

const hint = '… Expand for full advice.';
const wrapped = (text, width) => wrapTextWithAnsi(text, width).map(line => truncateToWidth(line, width));

function assertPreview(tool, result, width) {
  const compact = view(tool, result, false, width), expanded = view(tool, result, true, width);
  const adviceRows = wrapped(result.details.response, width), hintRows = wrapped(hint, width);
  assert.ok(adviceRows.length > 8);
  const rows = compact.split('\n');
  assert.deepEqual(rows.slice(-hintRows.length), hintRows);
  assert.deepEqual(rows.slice(-hintRows.length - 8, -hintRows.length), adviceRows.slice(0, 8));
  assert.doesNotMatch(normalized(compact), /UNIQUE_ADVICE_TAIL/);
  if (width >= 8) assert.ok(normalized(expanded).includes(normalized(result.details.response)));
  assert.ok(normalized(expanded).includes('UNIQUE_ADVICE_TAIL'));
  assert.doesNotMatch(compact, /mock\/chat|Consultation total:/);
  assert.ok(normalized(expanded).includes('mock/chat'));
  assert.ok(normalized(expanded).includes('Consultationtotal:'));
  assert.ok(!normalized(expanded).includes(normalized(hint)));
}

test('AC-19 changed: long Unicode and wrapped replies preview eight rows with full expansion', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor');
  const response = ['Start é界😀.', 'x'.repeat(800), 'Third paragraph.', 'Fourth paragraph.', 'UNIQUE_ADVICE_TAIL'].join('\n');
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply(response) });
  const result = await tool.execute('one', { message: 'Q' }, undefined, undefined, f.ctx);
  assert.equal(result.details.ok, true);
  for (const width of [1, 8, 30, 80]) assertPreview(tool, result, width);
});

test('AC-19 changed: ninth advice row triggers preview without counting headers or hint', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor');
  const response = [...Array.from({ length: 8 }, (_, i) => `Row ${i + 1}`), 'UNIQUE_ADVICE_TAIL'].join('\n');
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply(response) });
  const result = await tool.execute('one', { message: 'Q' }, undefined, undefined, f.ctx);
  assertPreview(tool, result, 80);
});

test('AC-19 changed: resize recomputes whether advice needs a preview', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor'), response = 'a'.repeat(240) + 'UNIQUE_ADVICE_TAIL';
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply(response) });
  const result = await tool.execute('one', { message: 'Q' }, undefined, undefined, f.ctx);
  const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme);
  assert.ok(normalized(component.render(80).join('\n')).includes(normalized(response)));
  component.invalidate();
  assert.ok(normalized(component.render(8).join('\n')).includes(normalized(hint)));
  assert.doesNotMatch(normalized(component.render(8).join('\n')), /UNIQUE_ADVICE_TAIL/);
  component.invalidate();
  assert.ok(normalized(component.render(80).join('\n')).includes(normalized(response)));
  assert.ok(!normalized(component.render(80).join('\n')).includes(normalized(hint)));
});

test('AC-19 preserved: one-row, eight-row and over-160-character short replies stay fully visible', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor');
  for (const [response, width] of [['Short advice.', 80], ['a'.repeat(8), 1], ['é界😀'.repeat(40), 80], [Array.from({ length: 8 }, (_, i) => `Row ${i + 1}`).join('\n'), 80]]) {
    f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply(response) });
    const result = await tool.execute('short', { message: 'Q' }, undefined, undefined, f.ctx);
    assert.ok(wrapped(response, width).length <= 8);
    const compact = view(tool, result, false, width);
    assert.ok(normalized(compact).includes(normalized(response)));
    assert.ok(!normalized(compact).includes(normalized(hint)));
  }
});

test('AC-19 changed: README documents eight-row previews and full expanded advice', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /at most eight wrapped.*rows.*full/i);
  assert.match(readme, /longer replies.*first eight.*rows/i);
  assert.match(readme, /expand.*full advice.*model.*cumulative usage/i);
});

test('AC-18 preserved: rendering does not duplicate messages, mutate results, or run model work', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor');
  const result = await tool.execute('one', { message: 'Q' }, undefined, undefined, f.ctx);
  assert.equal(Compile(tool.outputSchema).Check(result.structuredContent), true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.deepEqual(result.structuredContent, result.details);
  const snapshot = structuredClone(result), requests = f.requestCount();
  for (const expanded of [false, true, false]) for (const width of [1, 8, 30, 80]) view(tool, result, expanded, width);
  assert.deepEqual(result, snapshot);
  assert.equal(f.requestCount(), requests);
  assert.deepEqual(f.sideEffects, []);
  const sessions = await f.tools.get('advisor_sessions').execute('list', {}, undefined, undefined, f.ctx);
  assert.equal(sessions.details.sessions.length, 1);
  assert.equal(sessions.details.sessions[0].turns, 1);
  assert.equal(sessions.details.sessions[0].totalUsage.input, result.usage.input);
});

test('AC-18 preserved: partial, failed, and missing details never reveal unchecked advice', async t => {
  const f = await fixture(t), tool = f.tools.get('advisor');
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => reply('REJECTED_SECRET', { stopReason: 'length' }) });
  const failed = await tool.execute('failed', { message: 'Q' }, undefined, undefined, f.ctx);
  const partial = { details: { phase: 'waiting', response: 'PARTIAL_SECRET' } };
  const missing = { content: [{ type: 'text', text: 'RAW_SECRET' }] };
  for (const expanded of [false, true]) for (const width of [1, 8, 30, 80]) {
    for (const [result, isPartial] of [[failed, false], [partial, true], [missing, false]]) {
      assert.doesNotMatch(normalized(view(tool, result, expanded, width, isPartial)), /REJECTED_SECRET|PARTIAL_SECRET|RAW_SECRET/);
    }
  }
  assert.deepEqual(f.sideEffects, []);
});
