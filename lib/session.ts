import { randomUUID } from 'node:crypto';
import type { AssistantMessage, ModelsSimpleStreamOptions, Context, Usage } from '@earendil-works/pi-ai';
import { ADVISOR_PROMPT } from './prompt.ts';
import { AdvisorError, LIMITS, addUsage, checkLimit, failure, parseInput, replyText, zeroUsage, completionCategory, terminalDiagnostics, type Diagnostics, type Failure, type Selection, type SelectionSource, type UsageTotals } from './protocol.ts';

type Exchange = { role: 'user' | 'assistant'; text: string };
type Session = { id: string; label: string; model?: Selection; selectionSource?: SelectionSource; history: Exchange[]; usage: Usage; totalUsageComplete: boolean; pending?: AbortController };
export type Phase = 'preparing' | 'waiting';
export type Dependencies = {
  prepare: (reportSelection?: (model: Selection, source: SelectionSource) => void) => Promise<Selection>;
  complete: (model: Selection, context: Context, options: ModelsSimpleStreamOptions) => Promise<AssistantMessage>;
  progress?: (phase: Phase) => void;
};
export type Advice = { ok: true; advisory: true; session: string; response: string; turns: number; model: Selection; usage: Usage; usageComplete: boolean } & UsageTotals;
export type Metadata = { session: string; label: string; turns: number; model: Selection; busy: boolean; turnsRemaining: number; historyBytes: number; historyBytesRemaining: number } & UsageTotals;
const size = (history: Exchange[]): number => Buffer.byteLength(JSON.stringify(history));
const totals = (session: Session, pending = Boolean(session.pending)): UsageTotals => ({ totalUsage: structuredClone(session.usage), totalUsageComplete: session.totalUsageComplete && !pending });
function progress(deps: Dependencies, phase: Phase): void {
  // Presentation failure must never replace a consultation outcome.
  try { deps.progress?.(phase); } catch { /* The host owns display diagnostics. */ }
}

function context(history: Exchange[], model: Selection): Context {
  return { messages: [
    { role: 'system', content: ADVISOR_PROMPT, toolsAdded: [], timestamp: 0 },
    ...history.map(entry => entry.role === 'user'
      ? { role: 'user' as const, content: entry.text, timestamp: 0 }
      : { role: 'assistant' as const, content: [{ type: 'text' as const, text: entry.text }], provider: model.provider, model: model.model, api: 'advisor-text', timestamp: 0, stopReason: 'stop' as const, usage: zeroUsage() })
  ] };
}
// The caller owns the race. Late provider completion can never commit consultation state.
async function interruptible<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return operation(); }), cancelled]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

export class Consultations {
  private readonly sessions = new Map<string, Session>();
  private readonly limits: typeof LIMITS;
  constructor(overrides: Partial<Pick<typeof LIMITS, 'timeoutMs' | 'historyBytes'>> = {}) {
    for (const value of Object.values(overrides)) if (!Number.isSafeInteger(value) || value < 1) throw new AdvisorError('invalid-argument');
    this.limits = { ...LIMITS, ...overrides };
  }
  list(): Metadata[] {
    return [...this.sessions.values()].filter((s): s is Session & { model: Selection } => Boolean(s.model)).map(s => ({
      session: s.id, label: s.label, turns: s.history.length / 2, model: { ...s.model }, busy: Boolean(s.pending),
      ...totals(s), turnsRemaining: this.limits.turns - s.history.length / 2,
      historyBytes: size(s.history), historyBytesRemaining: this.limits.historyBytes - size(s.history)
    }));
  }
  close(id: string): { ok: true; session: string } | Failure {
    const session = this.sessions.get(id);
    if (!session) return failure(new AdvisorError('not-found'), zeroUsage(), id);
    if (session.pending) return failure(new AdvisorError('busy'), zeroUsage(), id);
    this.sessions.delete(id);
    return { ok: true, session: id };
  }
  clear(): void {
    for (const session of this.sessions.values()) session.pending?.abort(new AdvisorError('cancelled'));
    this.sessions.clear();
  }
  async send(value: unknown, deps: Dependencies, signal?: AbortSignal): Promise<Advice | Failure> {
    let session: Session | undefined;
    let input: ReturnType<typeof parseInput> | undefined;
    const requestedSession = value && typeof value === 'object' && 'session' in value && typeof value.session === 'string' && value.session.trim() ? value.session : undefined;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let relay: (() => void) | undefined;
    let usage = zeroUsage();
    let usageComplete = true;
    const diagnosticsEnabled = Boolean(value && typeof value === 'object' && 'diagnostics' in value && value.diagnostics === true);
    let phase: Diagnostics['phase'] = 'validation';
    let terminalHint: Pick<Diagnostics, 'category' | 'code' | 'httpStatus'> | undefined;
    let diagnosticModel: Selection | undefined;
    let selectionSource: SelectionSource = 'unknown';
    const started = performance.now();
    try {
      input = parseInput(value);
      if (signal?.aborted) throw new AdvisorError('cancelled');
      session = this.reserve(input);
      diagnosticModel = session.model ? { ...session.model } : undefined;
      selectionSource = session.selectionSource ?? 'unknown';
      controller = new AbortController();
      session.pending = controller;
      relay = () => controller!.abort(new AdvisorError('cancelled'));
      signal?.addEventListener('abort', relay, { once: true });
      timer = setTimeout(() => controller!.abort(new AdvisorError('timeout')), Math.max(0, this.limits.timeoutMs - (performance.now() - started)));
      const pending: Exchange[] = [...session.history, { role: 'user', text: input.message }];
      checkLimit('turns', this.limits.turns, session.history.length / 2 + 1);
      checkLimit('history-bytes', this.limits.historyBytes, size(pending));
      phase = 'preparation';
      const selected = session.model ?? await interruptible(() => {
        progress(deps, 'preparing');
        if (controller!.signal.aborted) throw controller!.signal.reason;
        return deps.prepare((model, source) => {
          // A late preparation must not mutate pinned state or the returned diagnostics.
          if (!controller!.signal.aborted) { diagnosticModel = { ...model }; selectionSource = source; }
        });
      }, controller.signal);
      const model = { ...selected };
      // Pin before awaiting model work. Reserving the map slot bounds concurrent creation.
      session.model = model;
      session.selectionSource = selectionSource;
      diagnosticModel = { ...model };
      phase = 'completion';
      const reply = await interruptible(() => {
        progress(deps, 'waiting');
        if (controller!.signal.aborted) throw controller!.signal.reason;
        usageComplete = false;
        return deps.complete(model, context(pending, model), {
          signal: controller!.signal, timeoutMs: Math.max(1, Math.floor(this.limits.timeoutMs - (performance.now() - started))), maxRetries: 0,
          maxTokens: this.limits.maxTokens, cacheRetention: 'none', sessionId: session!.id,
          ...(model.reasoning && model.reasoning !== 'default' && model.reasoning !== 'off' ? { reasoning: model.reasoning } : {})
        });
      }, controller.signal);
      phase = 'response-validation';
      if (reply.stopReason === 'error') terminalHint = diagnosticsEnabled ? terminalDiagnostics(reply, model.provider) : { category: 'provider-error' };
      if (reply.stopReason === 'aborted') terminalHint = { category: 'provider-aborted' };
      usage = addUsage(usage, reply.usage);
      usageComplete = true;
      const response = replyText(reply);
      const next: Exchange[] = [...pending, { role: 'assistant', text: response }];
      checkLimit('history-bytes', this.limits.historyBytes, size(next));
      phase = 'commit';
      if (controller.signal.aborted || this.sessions.get(session.id) !== session) throw new AdvisorError('cancelled');
      if (performance.now() - started >= this.limits.timeoutMs) throw new AdvisorError('timeout');
      session.history = next;
      session.usage = addUsage(session.usage, usage);
      return { ok: true, advisory: true, session: session.id, response, turns: next.length / 2, model: { ...model }, usage, usageComplete, ...totals(session, false) };
    } catch (error) {
      if (session && controller && session.history.length === 0 && this.sessions.get(session.id) === session) this.sessions.delete(session.id);
      // Only the request owner updates accounting. Rejected replies still consume resources.
      if (session && controller && session.history.length > 0 && this.sessions.get(session.id) === session) {
        session.usage = addUsage(session.usage, usage);
        session.totalUsageComplete &&= usageComplete;
      }
      const existing = requestedSession ? this.sessions.get(requestedSession) : undefined;
      const result = failure(error, usage, requestedSession, usageComplete);
      if (diagnosticsEnabled) result.error.diagnostics = {
        phase,
        category: error instanceof AdvisorError ? 'advisor-error' : phase === 'completion' ? completionCategory(error) : 'local-error',
        ...terminalHint,
        ...(diagnosticModel ? { model: { ...diagnosticModel }, selectionSource } : {})
      };
      return { ...result, ...(existing ? totals(existing, existing.pending !== controller && Boolean(existing.pending)) : {}) };
    } finally {
      if (timer) clearTimeout(timer);
      if (relay) signal?.removeEventListener('abort', relay);
      if (session && controller && session.pending === controller) session.pending = undefined;
    }
  }
  private reserve(input: ReturnType<typeof parseInput>): Session {
    if (input.session !== undefined) {
      const existing = this.sessions.get(input.session);
      if (!existing) throw new AdvisorError('not-found');
      if (existing.pending) throw new AdvisorError('busy');
      return existing;
    }
    checkLimit('sessions', this.limits.sessions, this.sessions.size + 1);
    const session: Session = { id: 'adv_' + randomUUID(), label: Array.from(input.message.trim().replace(/\s+/gu, ' ')).slice(0, 80).join(''), history: [], usage: zeroUsage(), totalUsageComplete: true };
    this.sessions.set(session.id, session);
    return session;
  }
}
