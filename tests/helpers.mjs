export const usage = { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13, cost: { input: .01, output: .002, cacheRead: .001, cacheWrite: 0, total: .013 } };
export const model = { provider: 'mock', model: 'chat' };
export function reply(text = 'Investigate the missing evidence.', patch = {}) {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage, api: 'mock-api', provider: 'mock', model: 'chat', timestamp: 1, ...patch };
}
export function dependencies(complete = async () => reply()) {
  const requests = [];
  return { requests, prepare: async () => model, getContextWindow: () => 272000, complete: async (pair, context, options) => { requests.push({ pair, context, options }); return complete(pair, context, options); } };
}
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export async function waitFor(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 1)); } throw new Error('fixture did not reach condition'); }
