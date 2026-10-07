import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { AdvisorError, REASONING_LEVELS, parseSelection, type Reasoning, type Selection } from './protocol.ts';
import { argumentCompletions, type CompletionContext } from './completions.ts';
import { assertReasoning, supportedReasoning } from './reasoning.ts';
import { selectModel } from './model-picker.ts';
import { loadSettings, saveSettings, settingsPaths, type LoadedSettings, type Scope } from './settings.ts';

const USAGE = 'Usage: /advisor [--global|--project] [show | model <provider> <model> | reasoning [level]]. Bare command opens model selection with UI. Saves default to global.';
export function resolveModel(ctx: ExtensionContext, pair: Selection, requireAuth: boolean): Model<Api> {
  const model = ctx.modelRegistry.find(pair.provider, pair.model);
  if (!model || model.api === 'pi-virtual' || (requireAuth && !ctx.modelRegistry.hasConfiguredAuth(model))) throw new AdvisorError('model-unavailable');
  assertReasoning(model, pair.reasoning);
  return model;
}
function parseCommand(args: string): { scope: Scope; show: boolean; pair?: Selection; reasoning?: Reasoning; reasoningQuery?: boolean } {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const flags = tokens.filter(t => t.startsWith('--'));
  if (flags.length > 1 || flags.some(f => f !== '--global' && f !== '--project')) throw new AdvisorError('invalid-argument');
  const scope = flags[0] === '--project' ? 'project' : 'global';
  const rest = tokens.filter(t => !t.startsWith('--'));
  if (!rest.length) return { scope, show: false };
  if (rest.length === 1 && rest[0] === 'show') return { scope, show: true };
  if (rest[0] === 'reasoning') {
    if (rest.length === 1) return { scope, show: false, reasoningQuery: true };
    if (rest.length === 2 && REASONING_LEVELS.includes(rest[1] as Reasoning)) return { scope, show: false, reasoning: rest[1] as Reasoning };
    throw new AdvisorError('invalid-argument');
  }
  if (rest.length === 3 && rest[0] === 'model') return { scope, show: false, pair: parseSelection({ provider: rest[1], model: rest[2] }) };
  throw new AdvisorError('invalid-argument');
}
function describe(loaded: LoadedSettings): string {
  const pair = loaded.settings.model;
  return `Advisor model: ${pair ? `${pair.provider}/${pair.model} (${loaded.source})` : 'not configured'}. Reasoning: ${pair?.reasoning ?? 'default (legacy provider behavior)'}. Configuration changes affect new consultations only.`;
}
async function pick(ctx: ExtensionCommandContext, current?: Selection): Promise<Selection | undefined> {
  const models = ctx.modelRegistry.getAvailable().filter(m => m.api !== 'pi-virtual');
  if (!models.length) throw new AdvisorError('model-unavailable');
  return selectModel(ctx, 'Advisor model', models, current);
}
export function registerSettingsCommand(pi: ExtensionAPI): (ctx?: CompletionContext) => void {
  let context: CompletionContext | undefined;
  let contextRevision = 0;
  const report = (ctx: ExtensionCommandContext, text: string, level: 'info' | 'error'): void => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else pi.sendMessage({ customType: 'advisor-settings', content: text, display: true, details: { level } }, { triggerTurn: false });
  };
  pi.registerCommand('advisor', {
    description: 'Configure the isolated advisor: picker, show, model <provider> <model>, reasoning [level], --global/--project',
    async getArgumentCompletions(prefix) {
      const revision = contextRevision;
      const items = await argumentCompletions(prefix, context);
      return revision === contextRevision ? items : null;
    },
    async handler(args, ctx) {
      const paths = settingsPaths(ctx.cwd, getAgentDir());
      let saveStarted = false;
      try {
        let command: ReturnType<typeof parseCommand>;
        try { command = parseCommand(args); } catch { report(ctx, USAGE, 'error'); return; }
        const loaded = await loadSettings(paths, ctx.isProjectTrusted());
        if (command.reasoningQuery) {
          const pair = loaded.settings.model;
          if (!pair) throw new AdvisorError('not-configured');
          const model = ctx.modelRegistry.find(pair.provider, pair.model);
          if (!model || model.api === 'pi-virtual') throw new AdvisorError('model-unavailable');
          report(ctx, `${describe(loaded)}\nSupported advisor reasoning: ${supportedReasoning(model).join(', ')}.\nUse /advisor [--global|--project] reasoning <level>. Higher reasoning can increase cost and latency.`, 'info');
          return;
        }
        if (command.show || (!command.pair && command.reasoning === undefined && !ctx.hasUI)) { report(ctx, `${describe(loaded)}\n${USAGE}\nglobal: ${paths.global}\nproject: ${paths.project}${ctx.isProjectTrusted() ? '' : ' (ignored: untrusted)'}`, 'info'); return; }
        if (command.scope === 'project' && !ctx.isProjectTrusted()) throw new AdvisorError('settings-unavailable');
        await ctx.waitForIdle();
        let pair: Selection | undefined;
        if (command.reasoning !== undefined) {
          const target = command.scope === 'global' ? await loadSettings(paths, false) : loaded;
          if (!target.settings.model) throw new AdvisorError('not-configured');
          pair = { ...target.settings.model, reasoning: command.reasoning };
        } else pair = command.pair ?? await pick(ctx, loaded.settings.model);
        if (!pair) { report(ctx, 'Advisor configuration cancelled. Settings unchanged.', 'info'); return; }
        resolveModel(ctx, pair, false);
        saveStarted = true;
        await saveSettings(paths, command.scope, { model: pair }, ctx.isProjectTrusted());
        report(ctx, `Saved ${command.scope} settings at ${paths[command.scope]}.\n${describe(await loadSettings(paths, ctx.isProjectTrusted()))}`, 'info');
      } catch (error) {
        const message = error instanceof AdvisorError ? error.message : 'Cannot configure advisor settings.';
        report(ctx, `${message}\n${saveStarted ? 'A save may have completed. Inspect before retrying.' : 'This command did not save settings.'}\nUse /advisor show to inspect.`, 'error');
      }
    }
  });
  return ctx => { context = ctx; contextRevision++; };
}
