import type { Api, Model } from '@earendil-works/pi-ai';
import { supportedReasoning, supportsReasoning } from '@neruok/pi-common/models';
import { AdvisorError, type Reasoning } from './protocol.ts';
export { supportedReasoning };
export function assertReasoning(model: Model<Api>, level?: Reasoning): void {
  if (!supportsReasoning(model, level)) throw new AdvisorError('unsupported-reasoning');
}
