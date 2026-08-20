import type {
  ContentEvaluationRequest,
  ContentEvaluationResult,
  IContentModerationProvider,
} from './IContentModerationProvider';

/**
 * A deterministic, local, dependency-free content evaluator.
 *
 * It is deliberately modest. This is not a spam classifier and does not pretend
 * to be one: it recognises the handful of shapes that are cheap to detect and
 * expensive to ignore — link farms, shouting, repeated characters, the standard
 * scam vocabulary — and says nothing about anything subtler. Judging whether a
 * post is harassment is a job for a human or for a real model, and a rule engine
 * that tried would produce confident nonsense.
 *
 * What it buys, today, is a queue that is not empty until someone reports
 * something, and a working integration point: when a real provider is
 * configured, everything downstream of `IContentModerationProvider` already
 * exists and the change is one line in `providers/index.ts`.
 *
 * ── Deterministic on purpose ────────────────────────────────────────────────
 * Same text in, same verdict out — no randomness, no clock, no network. A
 * moderator can reproduce exactly why something was flagged, and the tests can
 * assert on scores rather than on "roughly".
 */

/** Weight each signal contributes to the score. Summed, then clamped to 1. */
const WEIGHTS = {
  MANY_LINKS: 0.45,
  LINK_DENSITY: 0.3,
  SHOUTING: 0.2,
  REPEATED_CHARACTERS: 0.15,
  SCAM_VOCABULARY: 0.4,
  /**
   * Escalation for TWO OR MORE distinct scam phrases.
   *
   * One diagnostic phrase is genuinely ambiguous: an article explaining "never
   * share your seed phrase" contains one, and so does the scam it warns about.
   * A post containing several is not ambiguous. Weighting the second match
   * separately is what lets the single-phrase case stay below the reporting
   * threshold while the pile-up clears it comfortably.
   */
  MULTIPLE_SCAM_PHRASES: 0.2,
  REPEATED_PHRASE: 0.25,
} as const;

/** Above this many links, a short post is a link farm rather than a post. */
const LINK_COUNT_THRESHOLD = 4;

/** Links per 100 words that reads as promotional rather than referential. */
const LINK_DENSITY_THRESHOLD = 2;

/** Fraction of letters in upper case that reads as shouting (long text only). */
const SHOUTING_RATIO = 0.6;
const SHOUTING_MIN_LETTERS = 40;

/**
 * Phrases that are close to purely diagnostic of scam content in a blogging
 * context. Kept short and specific: every entry is a false-positive risk, and a
 * long list of vaguely spammy words would flag ordinary marketing writing.
 *
 * "work from home" was in an earlier draft and was removed for exactly that
 * reason — it is ordinary vocabulary in half the posts about remote work ever
 * written. If an entry could plausibly appear in a post ABOUT the scam rather
 * than IN one, it does not belong here.
 */
const SCAM_PHRASES = [
  'make money fast',
  'crypto giveaway',
  'double your bitcoin',
  'free gift card',
  'click here to claim',
  'limited time offer act now',
  'verify your wallet',
  'seed phrase',
  'telegram investment',
];

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;
const REPEATED_CHAR_PATTERN = /(.)\1{7,}/;

export class RuleBasedModerationProvider implements IContentModerationProvider {
  readonly name = 'rule-based';

  async evaluate(request: ContentEvaluationRequest): Promise<ContentEvaluationResult> {
    const text = `${request.title ?? ''}\n${request.text ?? ''}`.trim();

    // Empty content is not suspicious, it is empty. Returning early also keeps
    // every ratio below from dividing by zero.
    if (text.length === 0) {
      return this.verdict(0, [], 'SPAM');
    }

    const signals: string[] = [];
    let score = 0;

    const links = text.match(URL_PATTERN) ?? [];
    const words = text.split(/\s+/).filter(Boolean);

    if (links.length >= LINK_COUNT_THRESHOLD) {
      score += WEIGHTS.MANY_LINKS;
      signals.push('many-links');
    }

    // Density catches the case count alone misses: three links in a
    // twelve-word comment is a far stronger signal than three in an essay.
    const density = words.length > 0 ? (links.length / words.length) * 100 : 0;
    if (links.length > 0 && density >= LINK_DENSITY_THRESHOLD) {
      score += WEIGHTS.LINK_DENSITY;
      signals.push('link-density');
    }

    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length >= SHOUTING_MIN_LETTERS) {
      const upper = letters.replace(/[^A-Z]/g, '').length;
      if (upper / letters.length >= SHOUTING_RATIO) {
        score += WEIGHTS.SHOUTING;
        signals.push('shouting');
      }
    }

    if (REPEATED_CHAR_PATTERN.test(text)) {
      score += WEIGHTS.REPEATED_CHARACTERS;
      signals.push('repeated-characters');
    }

    const lowered = text.toLowerCase();
    const matchedPhrases = SCAM_PHRASES.filter((phrase) => lowered.includes(phrase));
    if (matchedPhrases.length > 0) {
      score += WEIGHTS.SCAM_VOCABULARY;
      signals.push('scam-vocabulary');
    }
    if (matchedPhrases.length > 1) {
      score += WEIGHTS.MULTIPLE_SCAM_PHRASES;
      signals.push('multiple-scam-phrases');
    }

    if (this.hasRepeatedPhrase(words)) {
      score += WEIGHTS.REPEATED_PHRASE;
      signals.push('repeated-phrase');
    }

    return this.verdict(Math.min(1, Number(score.toFixed(4))), signals, 'SPAM');
  }

  /**
   * Detects the same 4-word window repeated three or more times — the shape of
   * copy-pasted promotional blocks. A window rather than whole-text equality,
   * because the padding around each repetition is what makes naive duplicate
   * detection miss it.
   */
  private hasRepeatedPhrase(words: string[]): boolean {
    const WINDOW = 4;
    const MIN_REPEATS = 3;
    if (words.length < WINDOW * MIN_REPEATS) return false;

    const seen = new Map<string, number>();
    for (let i = 0; i + WINDOW <= words.length; i++) {
      const phrase = words
        .slice(i, i + WINDOW)
        .join(' ')
        .toLowerCase();
      const count = (seen.get(phrase) ?? 0) + 1;
      if (count >= MIN_REPEATS) return true;
      seen.set(phrase, count);
    }
    return false;
  }

  /**
   * `flagged` is set from the provider's OWN opinion of the score, but the
   * service applies its own threshold before filing anything. Two gates on
   * purpose: swapping in a provider whose calibration differs must not change
   * how eagerly the platform files reports.
   */
  private verdict(
    score: number,
    signals: string[],
    reason: ContentEvaluationResult['reason']
  ): ContentEvaluationResult {
    return { flagged: score >= 0.5, score, reason, signals, provider: this.name };
  }
}

export const ruleBasedModerationProvider = new RuleBasedModerationProvider();
