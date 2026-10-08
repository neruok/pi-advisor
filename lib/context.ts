import type { Context } from '@earendil-works/pi-ai';
import { calculateContextTokens, estimateTokens } from '@earendil-works/pi-coding-agent';

export type ContextUsage = { tokens: number; contextWindow: number; percent: number };
// Match Pi's usage-backed context estimate. Ciphertext bytes are not model tokens.
export function contextUsage(messages: Context['messages'], contextWindow: number): ContextUsage {
  let trailing = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      const reported = calculateContextTokens(message.usage);
      if (reported > 0) return { tokens: reported + trailing, contextWindow, percent: (reported + trailing) / contextWindow * 100 };
    }
    trailing += estimateTokens(message);
  }
  return { tokens: trailing, contextWindow, percent: trailing / contextWindow * 100 };
}
