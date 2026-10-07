import type { JsonValue, Usage } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { Consultations, type Dependencies, type Metadata } from './lib/session.ts';
import { AdvisorError, failure, object, type Failure } from './lib/protocol.ts';
import { MAIN_GUIDANCE } from './lib/prompt.ts';
import { AdviceSchema, InputSchema, EmptyInputSchema, CloseInputSchema, ListSchema, CloseSchema } from './lib/schemas.ts';
import { loadSettings, settingsPaths } from './lib/settings.ts';
import { registerSettingsCommand, resolveModel } from './lib/settings-command.ts';

function dependencies(ctx: ExtensionToolContext): Dependencies {
  return {
    async prepare() {
      const pair = (await loadSettings(settingsPaths(ctx.cwd, getAgentDir()), ctx.isProjectTrusted())).settings.model;
      if (!pair) throw new AdvisorError('not-configured');
      resolveModel(ctx, pair, true);
      return pair;
    },
    async complete(pair, context, options) {
      const model = resolveModel(ctx, pair, true);
      return ctx.modelRegistry.streamSimple(model, context, options).result();
    }
  };
}
function result<T extends { ok: boolean; usage?: Usage }>(data: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: data, structuredContent: data as unknown as JsonValue, isError: !data.ok, ...(data.usage ? { usage: data.usage } : {}) };
}
export default function advisor(pi: ExtensionAPI): void {
  const consultations = new Consultations();
  registerSettingsCommand(pi);
  const reset = async () => { consultations.clear(); };
  pi.on('session_start', reset);
  pi.on('session_tree', reset);
  pi.on('session_shutdown', reset);
  pi.registerTool({
    name: 'advisor', label: 'Advisor', exposure: 'model-only',
    description: 'Consult an isolated, tool-free advisor. Explain your problem, evidence and uncertainty. Omit session to start, or supply it to continue. Advice is not evidence or authorization. No automatic workspace or parent context access. Explicit host-configured model required. Provider calls may incur charges.',
    promptGuidelines: MAIN_GUIDANCE, parameters: InputSchema, outputSchema: AdviceSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async execute(_id, args, signal, _update, ctx) { return result(await consultations.send(args, dependencies(ctx), signal ?? ctx.signal)); }
  });
  pi.registerTool({
    name: 'advisor_sessions', label: 'Advisor sessions', exposure: 'model-only',
    description: 'List active ephemeral advisor sessions and metadata, without full transcripts. Recover the identifier for the same issue.',
    parameters: EmptyInputSchema, outputSchema: ListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, args) {
      let data: { ok: true; sessions: Metadata[] } | Failure;
      try { object(args, [], 'invalid-argument'); data = { ok: true, sessions: consultations.list() }; }
      catch (error) { data = failure(error); }
      return result(data);
    }
  });
  pi.registerTool({
    name: 'advisor_close', label: 'Close advisor session', exposure: 'model-only',
    description: 'Close an idle advisor consultation and release its history. Busy or unknown sessions return errors. Closing does not erase the parent Pi transcript.',
    parameters: CloseInputSchema, outputSchema: CloseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_id, args) {
      try { object(args, ['session'], 'invalid-argument'); if (typeof args.session !== 'string' || !args.session.trim()) throw new AdvisorError('invalid-argument'); return result(consultations.close(args.session)); }
      catch (error) { return result(failure(error)); }
    }
  });
}
