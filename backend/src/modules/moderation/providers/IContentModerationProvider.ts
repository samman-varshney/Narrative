import type { ReportReason } from '@prisma/client';

/**
 * The seam between moderation policy and whatever evaluates content.
 *
 * The domain depends on THIS, never on a concrete evaluator. That is what makes
 * the eventual choice between a hosted spam service, a Perspective-style
 * classifier, an LLM and the local rules below a configuration decision rather
 * than a rewrite — and what keeps the platform from being unable to accept a
 * comment because a third party is down.
 *
 * Three properties the interface deliberately has:
 *
 *   it SUGGESTS, never acts        `evaluate` returns a verdict. Nothing in it
 *                                  can hide a blog. The service decides what a
 *                                  verdict is worth, so a miscalibrated provider
 *                                  can at worst fill the queue — never remove
 *                                  content on its own.
 *
 *   it speaks the report vocabulary  the suggested `reason` is a `ReportReason`,
 *                                  so an automated finding lands in the same
 *                                  queue, with the same filters, as a human
 *                                  report. A parallel taxonomy for machine
 *                                  findings would mean two queues.
 *
 *   it takes TEXT, not entities    a provider never learns what a Blog is. It
 *                                  receives plain text and identifiers, which is
 *                                  also exactly what an external API would be
 *                                  sent — so adding one changes this module and
 *                                  nothing else.
 */

export interface ContentEvaluationRequest {
  targetType: 'BLOG' | 'COMMENT';
  targetId: string;
  /** The content's author, for providers that weigh reputation. Never used to judge. */
  authorId: string;
  /** Plain text. Callers truncate; providers must not assume a bound. */
  text: string;
  /** Title, for the target types that have one. */
  title?: string;
}

export interface ContentEvaluationResult {
  /** Whether the provider believes this warrants review. */
  flagged: boolean;
  /** Confidence in [0, 1]. The service, not the provider, owns the threshold. */
  score: number;
  /** Which report reason this would be filed under. */
  reason: ReportReason;
  /**
   * Human-readable signal names that produced the score ("many-links",
   * "shouting"). Stored on the report so a moderator can see WHY the machine
   * flagged it — an automated report with no explanation is one a moderator
   * cannot evaluate, only obey.
   */
  signals: string[];
  /** Which provider produced this, recorded on the report for later comparison. */
  provider: string;
}

export interface IContentModerationProvider {
  readonly name: string;
  /**
   * Evaluates content. MUST NOT throw for ordinary input: callers treat an
   * evaluation as best-effort background work, and a provider that throws on
   * unusual text would turn a publish into a failed job.
   */
  evaluate(request: ContentEvaluationRequest): Promise<ContentEvaluationResult>;
}
