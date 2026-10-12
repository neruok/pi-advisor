import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { argumentCompletions as complete, type Choice } from '@neruok/pi-common/commands';
import { parseSelection } from './protocol.ts';
import { supportedReasoning } from './reasoning.ts';
import { loadSettings, settingsPaths } from './settings.ts';

export type CompletionContext = Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>;
const commands: Choice[] = [
  { value: 'show', description: 'Show effective settings and their sources' },
  { value: 'model', description: 'Set the advisor provider and model' },
  { value: 'reasoning', description: 'Inspect or set reasoning effort' },
  { value: 'timeout', description: 'Inspect or set the deadline in milliseconds' },
];

export function argumentCompletions(prefix: string, ctx?: CompletionContext) {
  return complete(prefix, {
    commands, modelCommands: ['model'],
    validateModel: (_command, pair) => { parseSelection(pair); },
    models: () => {
      if (!ctx) return [];
      return ctx.modelRegistry.getAvailable().filter(model => model.api !== 'pi-virtual');
    },
    reasoning: async project => {
      if (!ctx || (project && !ctx.isProjectTrusted())) return [];
      const pair = (await loadSettings(settingsPaths(ctx.cwd, getAgentDir()), project)).settings.model;
      if (!pair) return [];
      const model = ctx.modelRegistry.find(pair.provider, pair.model);
      if (!model || model.api === 'pi-virtual') return [];
      return supportedReasoning(model).map(value => ({ value, description: value === 'default' ? 'Keep legacy provider behavior' : `Set reasoning to ${value}` }));
    },
  });
}
