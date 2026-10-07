import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';

export const LIMITS = Object.freeze({ sessions: 8, turns: 24, messageBytes: 16384, replyBytes: 16384, historyBytes: 49152, timeoutMs: 120000, maxTokens: 4096 });
export const REASONING_LEVELS = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Reasoning = typeof REASONING_LEVELS[number];
export type Selection = { provider: string; model: string; reasoning?: Reasoning };
export type ErrorCode = 'invalid-argument' | 'not-found' | 'busy' | 'limit-exceeded' | 'not-configured' | 'invalid-config' | 'settings-unavailable' | 'model-unavailable' | 'unsupported-reasoning' | 'provider-failed' | 'invalid-response' | 'cancelled' | 'timeout';
const ERRORS: Record<ErrorCode, string> = {
  'invalid-argument': 'Use a nonblank message and an existing session identifier, if supplied.',
  'not-found': 'Consultation not found. It may have closed or its parent session may have changed.',
  busy: 'Consultation has a pending request. Wait for it before sending or closing.',
  'limit-exceeded': 'Consultation limit exceeded. Close unused sessions or start a new consultation with an explicit summary.',
  'not-configured': 'No advisor model configured. Use /advisor model <provider> <model>.',
  'invalid-config': 'Advisor settings must be strict JSON with one optional model selection.',
  'settings-unavailable': 'Cannot safely read or save advisor settings. Inspect settings and locks before retrying.',
  'model-unavailable': 'Configured advisor model is unavailable, virtual, or lacks authentication.',
  'unsupported-reasoning': 'Configured advisor reasoning is not supported by the selected model. Use /advisor reasoning to inspect supported levels.',
  'provider-failed': 'Advisor provider request failed. No exchange was committed.',
  'invalid-response': 'Advisor reply was not a usable text completion. No exchange was committed.',
  cancelled: 'Advisor request cancelled. No exchange was committed.',
  timeout: 'Advisor request deadline exceeded. No exchange was committed.'
};
export type LimitResource = 'input-bytes' | 'reply-bytes' | 'history-bytes' | 'turns' | 'sessions';
export type LimitDetails = { resource: LimitResource; maximum: number; actual: number };
const LIMIT_MESSAGES: Record<LimitResource, string> = {
  'input-bytes': 'Input byte limit exceeded. Send a shorter message.',
  'reply-bytes': 'Reply byte limit exceeded. Request a shorter answer.',
  'history-bytes': 'History byte limit exceeded. Start a new consultation with an explicit summary.',
  turns: 'Exchange limit exceeded. Start a new consultation with an explicit summary.',
  sessions: 'Active consultation limit exceeded. Close idle consultations before starting another.'
};
const REPLY_MESSAGES = {
  completion: 'Advisor completion did not stop normally.',
  content: 'Advisor reply contained unsupported or malformed content.',
  text: 'Advisor reply contained no nonblank text.'
} as const;
export class AdvisorError extends Error {
  readonly code: ErrorCode;
  readonly limit?: LimitDetails;
  constructor(code: ErrorCode, limit?: LimitDetails, replyReason?: keyof typeof REPLY_MESSAGES) {
    super(replyReason && code === 'invalid-response'
      ? REPLY_MESSAGES[replyReason] + ' No exchange was committed.'
      : limit && code === 'limit-exceeded' ? LIMIT_MESSAGES[limit.resource] : ERRORS[code]);
    this.name = 'AdvisorError'; this.code = code; this.limit = limit;
  }
}
export function checkLimit(resource: LimitResource, maximum: number, actual: number): void {
  if (actual > maximum) throw new AdvisorError('limit-exceeded', { resource, maximum, actual });
}
export function zeroUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
export function addUsage(a: Usage, b: Usage): Usage {
  const result = zeroUsage();
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) result[key] = a[key] + b[key];
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) result.cost[key] = a.cost[key] + b.cost[key];
  for (const key of ['reasoning', 'cacheWrite1h'] as const) if (a[key] !== undefined || b[key] !== undefined) result[key] = (a[key] ?? 0) + (b[key] ?? 0);
  return result;
}
export type UsageTotals = { totalUsage: Usage; totalUsageComplete: boolean };
export type Failure = { ok: false; error: { code: ErrorCode; message: string; limit?: LimitDetails }; usage: Usage; usageComplete: boolean; session?: string } & Partial<UsageTotals>;
export function failure(error: unknown, usage = zeroUsage(), session?: string, usageComplete = true): Failure {
  const safe = error instanceof AdvisorError ? error : new AdvisorError('provider-failed');
  return { ok: false, error: { code: safe.code, message: safe.message, ...(safe.limit ? { limit: { ...safe.limit } } : {}) }, usage, usageComplete, ...(session === undefined ? {} : { session }) };
}
export function object(value: unknown, keys: string[], code: ErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AdvisorError(code);
  return value as Record<string, unknown>;
}
export function parseSelection(value: unknown): Selection {
  const pair = object(value, ['provider', 'model', 'reasoning'], 'invalid-config');
  for (const value of [pair.provider, pair.model]) if (typeof value !== 'string' || !value || /[\s\x00-\x1f\x7f-\x9f]/u.test(value)) throw new AdvisorError('invalid-config');
  if (pair.reasoning !== undefined && !REASONING_LEVELS.includes(pair.reasoning as Reasoning)) throw new AdvisorError('invalid-config');
  return { provider: pair.provider as string, model: pair.model as string, ...(pair.reasoning === undefined ? {} : { reasoning: pair.reasoning as Reasoning }) };
}
export function parseInput(value: unknown): { message: string; session?: string } {
  const input = object(value, ['message', 'session'], 'invalid-argument');
  if (typeof input.message !== 'string' || !input.message.trim() || (input.session !== undefined && (typeof input.session !== 'string' || !input.session.trim()))) throw new AdvisorError('invalid-argument');
  checkLimit('input-bytes', LIMITS.messageBytes, Buffer.byteLength(input.message));
  return { message: input.message, ...(input.session === undefined ? {} : { session: input.session as string }) };
}
export function replyText(message: AssistantMessage): string {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new AdvisorError('provider-failed');
  if (message.stopReason !== 'stop') throw new AdvisorError('invalid-response', undefined, 'completion');
  if (!Array.isArray(message.content) || message.content.some(block => !block ||
    (block.type !== 'text' && block.type !== 'thinking') || (block.type === 'text' && typeof block.text !== 'string'))) {
    throw new AdvisorError('invalid-response', undefined, 'content');
  }
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  checkLimit('reply-bytes', LIMITS.replyBytes, Buffer.byteLength(text));
  if (!text.trim()) throw new AdvisorError('invalid-response', undefined, 'text');
  return text;
}
