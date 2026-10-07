import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';

export const LIMITS = Object.freeze({ sessions: 8, turns: 24, messageBytes: 16384, replyBytes: 16384, historyBytes: 49152, timeoutMs: 120000, maxTokens: 4096 });
export type Selection = { provider: string; model: string };
export type Status = 'continue' | 'actionable' | 'approval_needed' | 'exhausted';
export type ErrorCode = 'invalid-argument' | 'not-found' | 'busy' | 'limit-exceeded' | 'not-configured' | 'invalid-config' | 'settings-unavailable' | 'model-unavailable' | 'provider-failed' | 'invalid-response' | 'cancelled' | 'timeout';
const ERRORS: Record<ErrorCode, string> = {
  'invalid-argument': 'Use a nonblank message and an existing session identifier, if supplied.',
  'not-found': 'Consultation not found. It may have closed or its parent session may have changed.',
  busy: 'Consultation has a pending request. Wait for it before sending or closing.',
  'limit-exceeded': 'Consultation limit exceeded. Close unused sessions or start a new consultation with an explicit summary.',
  'not-configured': 'No advisor model configured. Use /advisor model <provider> <model>.',
  'invalid-config': 'Advisor settings must be strict JSON with one optional model selection.',
  'settings-unavailable': 'Cannot safely read or save advisor settings. Inspect settings and locks before retrying.',
  'model-unavailable': 'Configured advisor model is unavailable, virtual, or lacks authentication.',
  'provider-failed': 'Advisor provider request failed. No exchange was committed.',
  'invalid-response': 'Advisor reply violated the text and final-status-marker protocol. No exchange was committed.',
  cancelled: 'Advisor request cancelled. No exchange was committed.',
  timeout: 'Advisor request deadline exceeded. No exchange was committed.'
};
export class AdvisorError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(ERRORS[code]); this.name = 'AdvisorError'; this.code = code; }
}
export function zeroUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
export function addUsage(a: Usage, b: Usage): Usage {
  const result = zeroUsage();
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) result[key] = a[key] + b[key];
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) result.cost[key] = a.cost[key] + b.cost[key];
  for (const key of ['reasoning', 'cacheWrite1h'] as const) if (a[key] !== undefined || b[key] !== undefined) result[key] = (a[key] ?? 0) + (b[key] ?? 0);
  return result;
}
export type Failure = { ok: false; error: { code: ErrorCode; message: string }; usage: Usage; session?: string };
export function failure(error: unknown, usage = zeroUsage(), session?: string): Failure {
  const safe = error instanceof AdvisorError ? error : new AdvisorError('provider-failed');
  return { ok: false, error: { code: safe.code, message: safe.message }, usage, ...(session === undefined ? {} : { session }) };
}
export function object(value: unknown, keys: string[], code: ErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AdvisorError(code);
  return value as Record<string, unknown>;
}
export function parseSelection(value: unknown): Selection {
  const pair = object(value, ['provider', 'model'], 'invalid-config');
  for (const value of [pair.provider, pair.model]) if (typeof value !== 'string' || !value || /[\s\x00-\x1f\x7f-\x9f]/u.test(value)) throw new AdvisorError('invalid-config');
  return { provider: pair.provider as string, model: pair.model as string };
}
export function parseInput(value: unknown): { message: string; session?: string } {
  const input = object(value, ['message', 'session'], 'invalid-argument');
  if (typeof input.message !== 'string' || !input.message.trim() || (input.session !== undefined && (typeof input.session !== 'string' || !input.session.trim()))) throw new AdvisorError('invalid-argument');
  if (Buffer.byteLength(input.message) > LIMITS.messageBytes) throw new AdvisorError('limit-exceeded');
  return { message: input.message, ...(input.session === undefined ? {} : { session: input.session as string }) };
}
const MARKERS = { CONTINUE: 'continue', ACTIONABLE: 'actionable', APPROVAL_NEEDED: 'approval_needed', EXHAUSTED: 'exhausted' } as const;
export function parseReply(message: AssistantMessage): { raw: string; response: string; status: Status } {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new AdvisorError('provider-failed');
  if (message.stopReason !== 'stop' || !Array.isArray(message.content) || message.content.some(block => block.type !== 'text' && block.type !== 'thinking')) throw new AdvisorError('invalid-response');
  const raw = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  if (Buffer.byteLength(raw) > LIMITS.replyBytes) throw new AdvisorError('limit-exceeded');
  const matches = [...raw.matchAll(/\[(CONTINUE|ACTIONABLE|APPROVAL_NEEDED|EXHAUSTED)\]/g)];
  const markerLines = [...raw.matchAll(/^\[[A-Z_]+\][ \t\r]*$/gm)];
  const final = /(?:^|\n)\[(CONTINUE|ACTIONABLE|APPROVAL_NEEDED|EXHAUSTED)\]\s*$/.exec(raw);
  if (matches.length !== 1 || markerLines.length !== 1 || !final) throw new AdvisorError('invalid-response');
  const response = raw.slice(0, final.index).trim();
  if (!response) throw new AdvisorError('invalid-response');
  return { raw, response, status: MARKERS[final[1] as keyof typeof MARKERS] };
}
