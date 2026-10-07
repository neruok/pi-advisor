import { randomUUID } from 'node:crypto';
import type { AssistantMessage, ModelsSimpleStreamOptions, Context, Usage } from '@earendil-works/pi-ai';
import { ADVISOR_PROMPT } from './prompt.ts';
import { AdvisorError, LIMITS, addUsage, failure, parseInput, parseReply, zeroUsage, type Failure, type Selection, type Status } from './protocol.ts';

type Exchange = { role: 'user' | 'assistant'; text: string };
type Session = { id: string; label: string; model?: Selection; history: Exchange[]; status: Status; usage: Usage; pending?: AbortController };
export type Dependencies = {
  prepare: () => Promise<Selection>;
  complete: (model: Selection, context: Context, options: ModelsSimpleStreamOptions) => Promise<AssistantMessage>;
};
export type Advice = { ok: true; advisory: true; session: string; response: string; status: Status; turns: number; model: Selection; usage: Usage; totalUsage: Usage };
export type Metadata = { session: string; label: string; turns: number; status: Status; model: Selection; busy: boolean };
const size = (history: Exchange[]): number => Buffer.byteLength(JSON.stringify(history));

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
    return [...this.sessions.values()].filter((s): s is Session & { model: Selection } => Boolean(s.model)).map(s => ({ session: s.id, label: s.label, turns: s.history.length / 2, status: s.status, model: { ...s.model }, busy: Boolean(s.pending) }));
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
    const started = performance.now();
    try {
      input = parseInput(value);
      if (signal?.aborted) throw new AdvisorError('cancelled');
      session = this.reserve(input);
      controller = new AbortController();
      session.pending = controller;
      relay = () => controller!.abort(new AdvisorError('cancelled'));
      signal?.addEventListener('abort', relay, { once: true });
      timer = setTimeout(() => controller!.abort(new AdvisorError('timeout')), Math.max(0, this.limits.timeoutMs - (performance.now() - started)));
      const pending: Exchange[] = [...session.history, { role: 'user', text: input.message }];
      if (pending.length / 2 > this.limits.turns || size(pending) > this.limits.historyBytes) throw new AdvisorError('limit-exceeded');
      const selected = session.model ?? await interruptible(() => deps.prepare(), controller.signal);
      const model = { ...selected };
      // Pin before awaiting model work. Reserving the map slot bounds concurrent creation.
      session.model = model;
      const reply = await interruptible(() => deps.complete(model, context(pending, model), {
        signal: controller!.signal, timeoutMs: Math.max(1, this.limits.timeoutMs - (performance.now() - started)), maxRetries: 0,
        maxTokens: this.limits.maxTokens, toolChoice: 'none', cacheRetention: 'none', sessionId: session!.id
      }), controller.signal);
      usage = addUsage(usage, reply.usage);
      const parsed = parseReply(reply);
      const next: Exchange[] = [...pending, { role: 'assistant', text: parsed.raw }];
      if (size(next) > this.limits.historyBytes) throw new AdvisorError('limit-exceeded');
      if (controller.signal.aborted || this.sessions.get(session.id) !== session) throw new AdvisorError('cancelled');
      if (performance.now() - started >= this.limits.timeoutMs) throw new AdvisorError('timeout');
      session.history = next;
      session.status = parsed.status;
      session.usage = addUsage(session.usage, usage);
      return { ok: true, advisory: true, session: session.id, response: parsed.response, status: parsed.status, turns: next.length / 2, model: { ...model }, usage, totalUsage: structuredClone(session.usage) };
    } catch (error) {
      if (session && controller && session.history.length === 0 && this.sessions.get(session.id) === session) this.sessions.delete(session.id);
      // Completed invalid replies still consumed provider resources.
      if (session && controller && session.history.length > 0) session.usage = addUsage(session.usage, usage);
      return failure(error, usage, requestedSession);
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
    if (this.sessions.size >= this.limits.sessions) throw new AdvisorError('limit-exceeded');
    const session: Session = { id: 'adv_' + randomUUID(), label: Array.from(input.message.trim().replace(/\s+/gu, ' ')).slice(0, 80).join(''), history: [], status: 'continue', usage: zeroUsage() };
    this.sessions.set(session.id, session);
    return session;
  }
}
