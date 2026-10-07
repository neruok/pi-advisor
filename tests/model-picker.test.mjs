import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURSOR_MARKER, fuzzyFilter, visibleWidth } from '@earendil-works/pi-tui';
import extension from '../advisor.ts';

async function fixture(t, unicode = false) {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-model-picker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => saved === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = saved);
  const global = join(dir, 'advisor.json'), project = join(dir, 'workspace', '.pi', 'advisor.json');
  await mkdir(join(dir, 'workspace', '.pi'), { recursive: true });
  const models = Array.from({ length: 100 }, (_, i) => ({ provider: 'catalog', id: `model-${String(i).padStart(3, '0')}${unicode ? '-界😀'.repeat(25) : ''}`, name: `Display ${i}`, api: 'mock-api' }));
  const current = { provider: models[73].provider, model: models[73].id };
  await writeFile(global, JSON.stringify({ model: current }));
  const commands = new Map(); let generation = 0;
  extension({ registerCommand: (name, command) => commands.set(name, command), registerTool() {}, on() {}, setModel: () => assert.fail('Conversation model must not change') });
  const ctx = { cwd: join(dir, 'workspace'), mode: 'tui', hasUI: true, isProjectTrusted: () => true, waitForIdle: async () => {},
    modelRegistry: { getAvailable: () => [...models, { provider: 'pi-virtual', id: 'router', api: 'pi-virtual' }], find: (provider, id) => models.find(m => m.provider === provider && m.id === id), streamSimple: () => { generation++; assert.fail('Picker must not generate'); } },
    ui: { notify() {} }
  };
  return { ctx, models, current, global, project, invoke: args => commands.get('advisor').handler(args, ctx), generation: () => generation };
}
function exercisePicker(f, exercise) {
  const terminal = { rows: 24 }, tui = { terminal, requestRender() {} };
  const theme = { fg: (_color, text) => text, bold: text => text };
  let customCalls = 0, exerciseCalls = 0, fallbackCalls = 0, failure;
  f.ctx.ui.select = async () => { fallbackCalls++; return undefined; };
  f.ctx.ui.custom = async (factory, options) => {
    customCalls++; let result, finished = false;
    const component = await factory(tui, theme, {}, value => { result = value; finished = true; });
    try { exerciseCalls++; exercise(component, terminal, options, () => finished); assert.equal(finished, true, 'picker must finish'); }
    catch (error) { failure = error; }
    return result;
  };
  return () => {
    assert.equal(customCalls, 1, 'TUI command must use its inline model component, not the generic select dialog');
    assert.equal(fallbackCalls, 0);
    assert.equal(exerciseCalls, 1, 'the command must construct and exercise the real component');
    if (failure) throw failure;
    assert.equal(f.generation(), 0);
  };
}
function fits(component, terminal, width, selected) {
  const lines = component.render(width);
  assert.ok(lines.length <= Math.max(1, terminal.rows - 2), `height overflow at ${terminal.rows} rows`);
  assert.ok(lines.every(line => visibleWidth(line) <= width), `width overflow at ${width} columns`);
  assert.ok(lines.some(line => line.includes('→') && line.includes(selected)), `selected ${selected} must stay visible`);
  return lines;
}
const searchText = model => `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${model.name ? ` ${model.name}` : ''}`;

test('AC-10 inline picker selects current model, caps rows, forwards focus and handles resize', async t => {
  const f = await fixture(t);
  const verify = exercisePicker(f, (component, terminal, options) => {
    assert.ok(!options?.overlay, 'match /model inline placement');
    terminal.rows = 60;
    const lines = fits(component, terminal, 80, 'model-073');
    assert.equal(lines.filter(line => /^(→ |  ).*model-\d{3}/.test(line) && !line.includes('Model Name:')).length, 10);
    assert.ok(lines.some(line => line.includes('→') && line.includes('✓') && line.includes('model-073')));
    assert.ok(lines.some(line => line.includes('Model Name: Display 73')));
    assert.ok(lines.some(line => line.includes('navigate')));
    component.focused = true; assert.equal(component.focused, true);
    assert.ok(component.render(80).join('\n').includes(CURSOR_MARKER), 'focus must reach the search Input');
    for (const rows of [60, 24, 10, 6, 3, 1]) { terminal.rows = rows; for (const width of [30, 80]) fits(component, terminal, width, 'model-073'); }
    terminal.rows = 10;
    for (let i = 0; i < 99; i++) { component.handleInput('\x1b[B'); fits(component, terminal, 30, `model-${String(i < 73 ? i : i + 1).padStart(3, '0')}`); }
    component.handleInput('\r');
  });
  await f.invoke(''); verify();
  assert.deepEqual(JSON.parse(await readFile(f.global, 'utf8')), { model: { provider: 'catalog', model: 'model-099' } });
});

test('AC-10 fuzzy search matches names and provider/model tokens with editable j/k', async t => {
  const f = await fixture(t); f.models[73].name = 'Jovial King'; f.models[26].name = 'Jungle Kite';
  const verify = exercisePicker(f, (component, terminal) => {
    component.handleInput('j'); component.handleInput('k');
    // Pi ranks the current-first list. Equal fuzzy scores preserve that input order.
    const currentFirst = [f.models[73], ...f.models.filter(m => m.id !== f.current.model)];
    fits(component, terminal, 80, fuzzyFilter(currentFirst, 'jk', searchText)[0].id);
    assert.ok(component.render(80).some(line => line.includes('> jk')));
    component.handleInput('\x15'); component.handleInput('JvL Kng'); fits(component, terminal, 80, 'model-073');
    component.handleInput('\x7f'); component.handleInput('g'); fits(component, terminal, 80, 'model-073');
    component.handleInput('\x15'); component.handleInput('cTlg/mD099'); fits(component, terminal, 80, 'model-099');
    component.handleInput('\r');
  });
  await f.invoke(''); verify();
  assert.deepEqual(JSON.parse(await readFile(f.global, 'utf8')), { model: { provider: 'catalog', model: 'model-099' } });
});

test('AC-10 no-match Enter stays open, clear restores results, arrows wrap and cancellation writes nothing', async t => {
  const f = await fixture(t); await writeFile(f.project, JSON.stringify({ model: { provider: 'catalog', model: 'model-026' } }));
  const before = await Promise.all([f.global, f.project].map(path => readFile(path, 'utf8')));
  for (const cancel of ['\x1b', '\x03']) {
    const verify = exercisePicker(f, (component, terminal, _options, finished) => {
      fits(component, terminal, 80, 'model-026');
      component.handleInput('zzzzzzzz'); assert.ok(component.render(80).some(line => line.includes('No matching models')));
      component.handleInput('\r'); assert.equal(finished(), false);
      component.handleInput('\x15'); fits(component, terminal, 80, 'model-026');
      component.handleInput('\x1b[A'); fits(component, terminal, 80, 'model-099');
      component.handleInput('\x1b[B'); fits(component, terminal, 80, 'model-026');
      component.handleInput(cancel);
    });
    await f.invoke(''); verify();
    assert.deepEqual(await Promise.all([f.global, f.project].map(path => readFile(path, 'utf8'))), before);
  }
});

test('AC-10 Unicode truncation preserves complete saved identifiers', async t => {
  const f = await fixture(t, true);
  const verify = exercisePicker(f, (component, terminal) => {
    for (const rows of [24, 10, 6, 3, 1]) { terminal.rows = rows; fits(component, terminal, 30, 'model-073'); }
    component.handleInput('\x1b[B'); fits(component, terminal, 30, 'model-000');
    component.handleInput('\r');
  });
  await f.invoke(''); verify();
  assert.deepEqual(JSON.parse(await readFile(f.global, 'utf8')), { model: { provider: 'catalog', model: f.models[0].id } });
});
