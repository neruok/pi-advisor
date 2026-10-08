import type { AssistantMessage, TextContent, ThinkingContent } from '@earendil-works/pi-ai';
import type { Selection } from './protocol.ts';

export type Replay = { api: AssistantMessage['api']; content: (TextContent | ThinkingContent)[] };
const responsesApis = new Set(['openai-responses', 'openai-codex-responses', 'azure-openai-responses']);
const googleApis = new Set(['google-generative-ai', 'google-vertex']);
const redactedApis = new Set(['anthropic-messages', 'bedrock-converse-stream']);
// Optional metadata must not execute accessors, retain arbitrary fields, or invalidate advice.
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}
function reasoningSignature(value: unknown): string | undefined {
  const item = parsed(value), id = own(item, 'id'), encrypted = own(item, 'encrypted_content');
  if (own(item, 'type') !== 'reasoning' || !nonempty(id) || !nonempty(encrypted)) return undefined;
  const status = own(item, 'status');
  return JSON.stringify({ type: 'reasoning', id, encrypted_content: encrypted, summary: [],
    ...(['completed', 'incomplete', 'in_progress'].includes(status as string) ? { status } : {}) });
}
function textSignature(value: unknown): string | undefined {
  const signature = parsed(value), id = own(signature, 'id'), phase = own(signature, 'phase');
  if (own(signature, 'v') !== 1 || typeof id !== 'string') return undefined;
  return JSON.stringify({ v: 1, id, ...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}) });
}
function googleSignature(value: unknown): string | undefined {
  return nonempty(value) && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
}

// Called only after replyText validates the completion. Never keep the original reply.
export function replay(message: AssistantMessage, model: Selection): Replay | undefined {
  const api = own(message, 'api');
  if (own(message, 'provider') !== model.provider || own(message, 'model') !== model.model || typeof api !== 'string') return undefined;
  const responses = responsesApis.has(api), google = googleApis.has(api);
  if (!responses && !google && !redactedApis.has(api)) return undefined;
  const content: Replay['content'] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      const text = own(block, 'text');
      if (typeof text !== 'string') return undefined;
      const signature = responses ? textSignature(own(block, 'textSignature')) : google ? googleSignature(own(block, 'textSignature')) : undefined;
      content.push({ type: 'text', text, ...(signature ? { textSignature: signature } : {}) });
    } else {
      const signature = responses ? reasoningSignature(own(block, 'thinkingSignature'))
        : google ? googleSignature(own(block, 'thinkingSignature'))
        : own(block, 'redacted') === true && nonempty(own(block, 'thinkingSignature')) ? own(block, 'thinkingSignature') as string : undefined;
      if (signature) content.push({ type: 'thinking', thinking: '', thinkingSignature: signature, ...(!responses && !google ? { redacted: true } : {}) });
    }
  }
  return { api, content };
}
