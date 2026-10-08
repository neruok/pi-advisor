import { randomUUID } from 'node:crypto';
import type { AssistantMessage, ModelsSimpleStreamOptions, Context, Usage } from '@earendil-works/pi-ai';
import { ADVISOR_PROMPT } from './prompt.ts';
import { replay, type Replay } from './replay.ts';
import { contextUsage, type ContextUsage } from './context.ts';
import { AdvisorError, LIMITS, parseTimeoutMs, addUsage, checkLimit, failure, parseInput, replyText, zeroUsage, completionCategory, terminalDiagnostics, type Diagnostics, type Failure, type Selection, type SelectionSource, type UsageTotals } from './protocol.ts';

type Exchange = { role: 'user' | 'assistant'; text: string; replay?: Replay; usage?: Usage };
type Session = { id: string; label: string; model?: Selection; selectionSource?: SelectionSource; timeoutMs?: number; contextWindow?: number; history: Exchange[]; usage: Usage; totalUsageComplete: boolean; pending?: AbortController };
export type Phase = 'preparing' | 'waiting';
export type Dependencies = {
  prepare: (reportSelection?: (model: Selection, source: SelectionSource) => void, reportTimeout?: (timeoutMs: number) => void) => Promise<Selection>;
  getContextWindow: (model: Selection) => number;
  complete: (model: Selection, context: Context, options: ModelsSimpleStreamOptions) => Promise<AssistantMessage>;
  progress?: (phase: Phase) => void;
};
export type Advice = { ok: true; advisory: true; session: string; response: string; turns: number; model: Selection; usage: Usage; usageComplete: boolean; contextUsage: ContextUsage } & UsageTotals;
export type Metadata = { session: string; label: string; turns: number; model: Selection; busy: boolean; turnsRemaining: number; historyBytes: number; contextUsage: ContextUsage } & UsageTotals;
const size = (history: Exchange[]): number => Buffer.byteLength(JSON.stringify(history.map(({ role, text, replay }) => ({ role, text, ...(replay ? { replay } : {}) }))));
const retainedContext = (session: Session): ContextUsage => contextUsage(context(session.history, session.model!).messages, session.contextWindow!);
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
      : { role: 'assistant' as const, content: entry.replay ? structuredClone(entry.replay.content) : [{ type: 'text' as const, text: entry.text }], provider: model.provider, model: model.model, api: entry.replay?.api ?? 'advisor-text', timestamp: 0, stopReason: 'stop' as const, usage: structuredClone(entry.usage ?? zeroUsage()) })
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
  constructor(overrides: Partial<Pick<typeof LIMITS, 'timeoutMs'>> = {}) {
    if (Object.keys(overrides).some(key => key !== 'timeoutMs')) throw new AdvisorError('invalid-argument');
    for (const value of Object.values(overrides)) if (!Number.isSafeInteger(value) || value < 1) throw new AdvisorError('invalid-argument');
    if (overrides.timeoutMs !== undefined) parseTimeoutMs(overrides.timeoutMs, 'invalid-argument');
    this.limits = { ...LIMITS, ...overrides };
  }
  list(): Metadata[] {
    return [...this.sessions.values()].filter((s): s is Session & { model: Selection } => Boolean(s.model)).map(s => ({
      session: s.id, label: s.label, turns: s.history.length / 2, model: { ...s.model }, busy: Boolean(s.pending),
      ...totals(s), turnsRemaining: this.limits.turns - s.history.length / 2,
      historyBytes: size(s.history), contextUsage: retainedContext(s)
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
    let timeoutMs: number = this.limits.timeoutMs, finished = false;
    const started = performance.now();
    const armDeadline = (): void => {
      if (timer) clearTimeout(timer);
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) throw new AdvisorError('timeout');
      timer = setTimeout(() => controller!.abort(new AdvisorError('timeout')), remaining);
    };
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
      timeoutMs = session.timeoutMs ?? this.limits.timeoutMs;
      armDeadline();
      const pending: Exchange[] = [...session.history, { role: 'user', text: input.message }];
      checkLimit('turns', this.limits.turns, session.history.length / 2 + 1);
      phase = 'preparation';
      const selected = session.model ?? await interruptible(() => {
        progress(deps, 'preparing');
        if (controller!.signal.aborted) throw controller!.signal.reason;
        return deps.prepare((model, source) => {
          // A late preparation must not mutate pinned state or the returned diagnostics.
          if (!finished && phase === 'preparation' && !controller!.signal.aborted) { diagnosticModel = { ...model }; selectionSource = source; }
        }, configured => {
          if (!finished && phase === 'preparation' && !controller!.signal.aborted) {
            timeoutMs = parseTimeoutMs(configured);
            armDeadline();
          }
        });
      }, controller.signal);
      if (performance.now() - started >= timeoutMs) throw new AdvisorError('timeout');
      const model = { ...selected };
      const window = session.contextWindow ?? deps.getContextWindow?.(model);
      if (!Number.isSafeInteger(window) || window < 1) throw new AdvisorError('model-unavailable');
      // Pin before awaiting model work. Reserving the map slot bounds concurrent creation.
      session.model = model;
      session.contextWindow = window;
      session.selectionSource = selectionSource;
      session.timeoutMs = timeoutMs;
      diagnosticModel = { ...model };
      checkLimit('context-tokens', window, contextUsage(context(pending, model).messages, window).tokens + this.limits.maxTokens);
      phase = 'completion';
      const reply = await interruptible(() => {
        progress(deps, 'waiting');
        if (controller!.signal.aborted) throw controller!.signal.reason;
        if (performance.now() - started >= timeoutMs) throw new AdvisorError('timeout');
        usageComplete = false;
        return deps.complete(model, context(pending, model), {
          signal: controller!.signal, timeoutMs: Math.max(1, Math.floor(timeoutMs - (performance.now() - started))), maxRetries: 0,
          maxTokens: this.limits.maxTokens, cacheRetention: 'short', sessionId: session!.id,
          ...(model.reasoning && model.reasoning !== 'default' && model.reasoning !== 'off' ? { reasoning: model.reasoning } : {})
        });
      }, controller.signal);
      phase = 'response-validation';
      if (reply.stopReason === 'error') terminalHint = diagnosticsEnabled ? terminalDiagnostics(reply, model.provider) : { category: 'provider-error' };
      if (reply.stopReason === 'aborted') terminalHint = { category: 'provider-aborted' };
      usage = addUsage(usage, reply.usage);
      usageComplete = true;
      const response = replyText(reply);
      const opaque = replay(reply, model);
      const next: Exchange[] = [...pending, { role: 'assistant', text: response, usage: structuredClone(usage), ...(opaque ? { replay: opaque } : {}) }];
      const nextContext = contextUsage(context(next, model).messages, window);
      checkLimit('context-tokens', window, nextContext.tokens);
      phase = 'commit';
      if (controller.signal.aborted || this.sessions.get(session.id) !== session) throw new AdvisorError('cancelled');
      if (performance.now() - started >= timeoutMs) throw new AdvisorError('timeout');
      session.history = next;
      session.usage = addUsage(session.usage, usage);
      return { ok: true, advisory: true, session: session.id, response, turns: next.length / 2, model: { ...model }, usage, usageComplete, contextUsage: nextContext, ...totals(session, false) };
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
      return { ...result, ...(existing ? { ...totals(existing, existing.pending !== controller && Boolean(existing.pending)), ...(existing.contextWindow && existing.model ? { contextUsage: retainedContext(existing) } : {}) } : {}) };
    } finally {
      finished = true;
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
