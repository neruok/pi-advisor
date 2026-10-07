import { Type } from 'typebox';
import { FAILURE_PHASES, FAILURE_CATEGORIES, REASONING_LEVELS } from './protocol.ts';
const text = Type.String({ minLength: 1 });
const object = { additionalProperties: false };
export const ModelSchema = Type.Object({ provider: text, model: text, reasoning: Type.Optional(Type.Union(REASONING_LEVELS.map(level => Type.Literal(level)))) }, object);
export const UsageSchema = Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), totalTokens: Type.Number(), reasoning: Type.Optional(Type.Number()), cacheWrite1h: Type.Optional(Type.Number()), cost: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), total: Type.Number() }, object) }, object);
const totals = { totalUsage: UsageSchema, totalUsageComplete: Type.Boolean() };
const LimitSchema = Type.Object({
  resource: Type.Union(['input-bytes', 'reply-bytes', 'history-bytes', 'turns', 'sessions'].map(s => Type.Literal(s))),
  maximum: Type.Integer({ minimum: 0 }), actual: Type.Integer({ minimum: 0 })
}, object);
export const DiagnosticsSchema = Type.Object({
  phase: Type.Union(FAILURE_PHASES.map(s => Type.Literal(s))),
  category: Type.Union(FAILURE_CATEGORIES.map(s => Type.Literal(s))),
  model: Type.Optional(ModelSchema),
  selectionSource: Type.Optional(Type.Union(['global', 'project', 'unknown'].map(s => Type.Literal(s))))
}, object);
const failure = {
  ok: Type.Literal(false), error: Type.Object({ code: text, message: text, limit: Type.Optional(LimitSchema), diagnostics: Type.Optional(DiagnosticsSchema) }, object),
  usage: UsageSchema, usageComplete: Type.Boolean(), session: Type.Optional(text)
};
// Cumulative usage and its completeness indicator must appear together.
export const FailureSchema = Type.Union([Type.Object(failure, object), Type.Object({ ...failure, ...totals }, object)]);
export const InputSchema = Type.Object({ message: text, session: Type.Optional(text), diagnostics: Type.Optional(Type.Boolean({ description: 'Opt in for safe failure phase, category and selected model metadata. No raw provider errors. Does not retry.' })) }, object);
export const CloseInputSchema = Type.Object({ session: text }, object);
export const EmptyInputSchema = Type.Object({}, object);
export const AdviceSchema = Type.Union([Type.Object({ ok: Type.Literal(true), advisory: Type.Literal(true), session: text, response: text, turns: Type.Integer({ minimum: 1, maximum: 24 }), model: ModelSchema, usage: UsageSchema, usageComplete: Type.Boolean(), ...totals }, object), FailureSchema]);
export const ListSchema = Type.Union([Type.Object({ ok: Type.Literal(true), sessions: Type.Array(Type.Object({
  session: text, label: text, turns: Type.Integer({ minimum: 0, maximum: 24 }), model: ModelSchema, busy: Type.Boolean(),
  ...totals, turnsRemaining: Type.Integer({ minimum: 0, maximum: 24 }),
  historyBytes: Type.Integer({ minimum: 0, maximum: 49152 }), historyBytesRemaining: Type.Integer({ minimum: 0, maximum: 49152 })
}, object), { maxItems: 8 }) }, object), FailureSchema]);
export const CloseSchema = Type.Union([Type.Object({ ok: Type.Literal(true), session: text }, object), FailureSchema]);
