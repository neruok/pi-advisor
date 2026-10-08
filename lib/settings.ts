import { constants } from 'node:fs';
import { lstat, open, mkdir, rename, link, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { AdvisorError, LIMITS, object, parseSelection, parseTimeoutMs, type Selection } from './protocol.ts';

export type Settings = { model?: Selection; timeoutMs?: number };
export type Scope = 'global' | 'project';
export type SettingsPaths = Record<Scope, string>;
export type LoadedSettings = { settings: Settings; source?: Scope; timeoutSource?: Scope };
export function settingsPaths(cwd: string, agentDir: string): SettingsPaths { return { global: join(agentDir, 'advisor.json'), project: join(cwd, '.pi', 'advisor.json') }; }
export function parseSettings(value: unknown): Settings {
  const settings = object(value, ['model', 'timeoutMs'], 'invalid-config');
  return {
    ...(settings.model === undefined ? {} : { model: parseSelection(settings.model) }),
    ...(settings.timeoutMs === undefined ? {} : { timeoutMs: parseTimeoutMs(settings.timeoutMs) })
  };
}
function missing(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'); }
function safe(error: unknown): never { throw error instanceof AdvisorError ? error : new AdvisorError('settings-unavailable'); }
async function checkParent(path: string): Promise<void> {
  try { const stat = await lstat(dirname(path)); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AdvisorError('settings-unavailable'); }
  catch (error) { if (!missing(error)) safe(error); }
}
async function readLayer(path: string): Promise<{ settings: Settings; raw?: Buffer }> {
  let handle: FileHandle | undefined;
  try {
    await checkParent(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AdvisorError('settings-unavailable');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new AdvisorError('settings-unavailable');
    if (opened.size > LIMITS.messageBytes) throw new AdvisorError('invalid-config');
    const buffer = Buffer.alloc(LIMITS.messageBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > LIMITS.messageBytes) throw new AdvisorError('invalid-config');
    const raw = buffer.subarray(0, length);
    try { return { settings: parseSettings(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))), raw }; }
    catch { throw new AdvisorError('invalid-config'); }
  } catch (error) { if (missing(error)) return { settings: {} }; return safe(error); }
  finally { try { await handle?.close(); } catch (error) { safe(error); } }
}
export async function loadSettings(paths: SettingsPaths, trusted: boolean): Promise<LoadedSettings> {
  const global = (await readLayer(paths.global)).settings;
  const project = trusted ? (await readLayer(paths.project)).settings : {};
  const model = project.model ?? global.model, timeoutMs = project.timeoutMs ?? global.timeoutMs;
  return {
    settings: { ...(model ? { model } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    ...(model ? { source: project.model ? 'project' as const : 'global' as const } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutSource: project.timeoutMs === undefined ? 'global' as const : 'project' as const })
  };
}
export async function saveSettings(paths: SettingsPaths, scope: Scope, value: unknown, trusted: boolean, preserve?: keyof Settings): Promise<void> {
  if (scope === 'project' && !trusted) throw new AdvisorError('settings-unavailable');
  const settings = parseSettings(value);
  const path = paths[scope];
  try {
    await withFileMutationQueue(path, async () => {
      await checkParent(path); await mkdir(dirname(path), { recursive: true }); await checkParent(path);
      const lockPath = path + '.lock', temp = path + '.' + randomUUID() + '.tmp';
      let lock: FileHandle | undefined;
      let ownedTemp = false;
      try {
        lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        const before = await readLayer(path);
        // Preserve the independent field from the locked checkpoint, not a prior command read.
        const next = { ...(preserve ? { [preserve]: before.settings[preserve] } : {}), ...settings };
        const text = JSON.stringify(next, null, 2) + '\n';
        if (Buffer.byteLength(text) > LIMITS.messageBytes) throw new AdvisorError('invalid-config');
        const output = await open(temp, 'wx', 0o600); ownedTemp = true;
        try { await output.writeFile(text, 'utf8'); await output.sync(); } finally { await output.close(); }
        const current = await readLayer(path);
        if (before.raw ? !current.raw?.equals(before.raw) : current.raw !== undefined) throw new AdvisorError('settings-unavailable');
        if (before.raw) await rename(temp, path);
        else await link(temp, path);
      } finally {
        try { if (ownedTemp) { try { await unlink(temp); } catch (error) { if (!missing(error)) throw error; } } }
        finally {
          if (lock) {
            try {
              const owned = await lock.stat(), current = await lstat(lockPath);
              if (owned.ino !== current.ino || owned.dev !== current.dev || current.isSymbolicLink()) throw new AdvisorError('settings-unavailable');
              await unlink(lockPath);
            } finally { await lock.close(); }
          }
        }
      }
    });
  } catch (error) { safe(error); }
}
