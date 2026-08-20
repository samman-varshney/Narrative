import type { IContentModerationProvider } from './IContentModerationProvider';
import { ruleBasedModerationProvider } from './RuleBasedModerationProvider';

/**
 * The active content-evaluation provider.
 *
 * A module-level binding rather than an env-selected factory, because there is
 * exactly one implementation and a `switch` over a setting with one case is a
 * configuration surface pretending to be a feature. When a second provider
 * exists — an external spam service, a classifier — this becomes the selector,
 * mirroring `core/providers/storage` and `core/providers/email`, and nothing
 * outside this file changes.
 *
 * No third-party moderation service is wired up, deliberately: none is
 * configured for this project, and making content creation depend on a vendor
 * that is not there would be a worse default than local rules.
 */
export const activeContentModerationProvider: IContentModerationProvider =
  ruleBasedModerationProvider;

export type {
  ContentEvaluationRequest,
  ContentEvaluationResult,
  IContentModerationProvider,
} from './IContentModerationProvider';
export { RuleBasedModerationProvider } from './RuleBasedModerationProvider';
