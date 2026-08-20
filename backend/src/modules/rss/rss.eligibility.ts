import type { Prisma } from '@prisma/client';
import { FEED_ELIGIBILITY, FEED_VISIBILITY, isFeedEligible } from '../feed/feed.eligibility';

/**
 * Content eligibility for syndication.
 *
 * ── There is no second visibility system here, and that is the whole point ──
 * This file DELEGATES. `FEED_ELIGIBILITY` is the platform's definition of what
 * may be surfaced to someone who did not ask for a specific post, and RSS is
 * exactly that kind of surface — so RSS adopts it whole rather than restating
 * it. The alternative was a private copy of the same five predicates, which is
 * the single most dangerous thing this module could contain: two definitions of
 * "public" drift, and the one that drifts is discovered by a reader finding a
 * withdrawn post in their feed reader.
 *
 * The rules it inherits, and the class each excludes:
 *
 *   status = PUBLISHED       drafts, archived posts, soft-deleted posts
 *   visibility = PUBLIC      private, UNLISTED and MEMBERS_ONLY posts
 *   isHidden = false         posts a moderator has withheld
 *   publishedAt IS NOT NULL  published rows with no publication instant
 *   author status = ACTIVE   posts by suspended, deactivated or deleted accounts
 *
 * ── Why syndication cannot be one rule looser ───────────────────────────────
 * UNLISTED is the case worth spelling out. `blogService.canView` ALLOWS an
 * unlisted post — that is what unlisted means, reachable by anyone holding the
 * link — and a naive reading would let RSS carry it. It must not. A feed
 * document is copied by every reader that subscribes, indexed by aggregators,
 * and re-published by services the platform has no relationship with; putting an
 * unlisted post in one converts "reachable by link" into "broadcast", which is
 * the exact distinction the visibility exists to draw. MEMBERS_ONLY is worse
 * still: its check is a documented V1 placeholder (any authenticated viewer),
 * and RSS has no viewer at all.
 *
 * So: syndication is PUBLIC only, and it is PUBLIC because discovery is PUBLIC,
 * from one definition.
 *
 * ── The dependency direction ────────────────────────────────────────────────
 * RSS imports from Feed. Feed does not import from RSS, and nothing else
 * imports RSS, so both remain leaves and no cycle can form. If discovery
 * eligibility is ever promoted out of the Feed module into `core`, this file is
 * the only line in RSS that has to move.
 */

/**
 * The eligibility predicate for a blog aliased `b` and its author aliased `u`.
 *
 * Emitted as SQL LITERALS, not bind parameters — the partial indexes that serve
 * every feed in this module are defined ON this predicate, and Postgres can only
 * prove a partial index applies against constants. Nothing user-supplied is
 * interpolated: see `rss.repository.ts`, where every value from a request is
 * bound.
 */
export const RSS_ELIGIBILITY: Prisma.Sql = FEED_ELIGIBILITY;

/** The visibilities syndication may carry — PUBLIC, and only PUBLIC. */
export const RSS_VISIBILITY = FEED_VISIBILITY;

/**
 * The same rules in TypeScript, for callers that already hold a row.
 *
 * Not the enforcement point — the SQL above is — but it keeps the definition
 * assertable from a unit test, and gives the module a way to answer "would this
 * be syndicated?" without a round trip.
 */
export const isRssEligible = isFeedEligible;

/**
 * Structural guard: nothing but PUBLIC may be syndicated.
 *
 * `feed.eligibility.ts` carries the same assertion, and this is not redundant
 * with it. That one protects the Feed module's own invariant; this one states
 * RSS's, so a future change that widened discovery on purpose — a deliberate,
 * defensible decision for feeds — cannot silently widen SYNDICATION along with
 * it. Whoever makes that change has to come here and decide again, with this
 * file's reasoning in front of them.
 */
for (const visibility of RSS_VISIBILITY) {
  if (visibility !== 'PUBLIC') {
    throw new Error(
      `RSS syndicates PUBLIC content only — ${visibility} must never be broadcast. ` +
        'See rss.eligibility.ts for why UNLISTED and MEMBERS_ONLY are excluded.'
    );
  }
}
