import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import { AdvisorError, type Reasoning } from './protocol.ts';

export function supportedReasoning(model: Model<Api>): Reasoning[] {
  return ['default', ...getSupportedThinkingLevels(model)];
}
export function assertReasoning(model: Model<Api>, level?: Reasoning): void {
  if (level !== undefined && !supportedReasoning(model).includes(level)) throw new AdvisorError('unsupported-reasoning');
}
