import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { SettingsError, loadScopedSettings, settingsPaths as commonPaths, updateJsonSettings, type SettingsPaths, type Scope } from '@neruok/pi-common/settings';
import { AdvisorError, object, parseSelection, parseTimeoutMs, type Selection } from './protocol.ts';

const MAX_SETTINGS_BYTES = 16384;
export type Settings = { model?: Selection; timeoutMs?: number };
export type { Scope, SettingsPaths };
export type LoadedSettings = { settings: Settings; source?: Scope; timeoutSource?: Scope };
export const settingsPaths = (cwd: string, agentDir: string): SettingsPaths => commonPaths(cwd, agentDir, 'advisor.json');
export function parseSettings(value: unknown): Settings {
  const settings = object(value, ['model', 'timeoutMs'], 'invalid-config');
  return {
    ...(settings.model === undefined ? {} : { model: parseSelection(settings.model) }),
    ...(settings.timeoutMs === undefined ? {} : { timeoutMs: parseTimeoutMs(settings.timeoutMs) })
  };
}
function safe(error: unknown): never {
  throw error instanceof AdvisorError ? error
    : new AdvisorError(error instanceof SettingsError ? error.code : 'settings-unavailable');
}
export async function loadSettings(paths: SettingsPaths, trusted: boolean): Promise<LoadedSettings> {
  try {
    const { settings, sources } = await loadScopedSettings(paths, trusted, MAX_SETTINGS_BYTES, parseSettings);
    return { settings, ...(sources.model ? { source: sources.model } : {}), ...(sources.timeoutMs ? { timeoutSource: sources.timeoutMs } : {}) };
  } catch (error) { return safe(error); }
}
export async function saveSettings(paths: SettingsPaths, scope: Scope, value: unknown, trusted: boolean, preserve?: keyof Settings): Promise<void> {
  if (scope === 'project' && !trusted) throw new AdvisorError('settings-unavailable');
  const settings = parseSettings(value);
  try {
    await withFileMutationQueue(paths[scope], () => updateJsonSettings(paths[scope], MAX_SETTINGS_BYTES, value => {
      let before: Settings;
      try { before = parseSettings(value); } catch { throw new SettingsError('invalid-config'); }
      return { ...(preserve ? { [preserve]: before[preserve] } : {}), ...settings };
    }));
  } catch (error) { safe(error); }
}
