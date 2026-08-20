import { Prisma, type BlogStatus, type BlogVisibility } from '@prisma/client';
import type { FeedVisibilitySet } from './feed.types';

/**
 * Content eligibility — the single place that decides what a feed may surface.
 *
 * Every feed query in `feed.repository.ts` builds its WHERE clause from here, so
 * "what is discoverable" is one definition rather than four that drift. This is
 * the module's most security-relevant file and is deliberately the smallest.
 *
 * ── This does not REPLACE the Blog module's rules, it NARROWS them ───────────
 * `blogService.canView` remains the authority on whether a given viewer may READ
 * a given blog. Discovery is a strictly smaller question, and two of Blog's four
 * visibilities are the difference:
 *
 *   UNLISTED      `canView` allows it — that is the point, an unlisted post is
 *                 reachable by anyone holding the link. A feed must never
 *                 surface it, because "reachable by link" and "advertised to
 *                 strangers" are the two halves of what unlisted means.
 *
 *   MEMBERS_ONLY  `canView` currently grants it to ANY authenticated viewer, a
 *                 documented placeholder awaiting a real membership check (see
 *                 BLOG_MODULE.md § Future work). Discovery does not lean on a
 *                 placeholder: a feed that advertised members-only posts to
 *                 every signed-in reader would leak gated content the moment
 *                 that check becomes real, and it would silently disagree with
 *                 Search, which already keeps its results to PUBLIC. When
 *                 membership exists, admitting it here is a deliberate decision
 *                 for that change to make — not something a feed inherited.
 *
 * So discovery is PUBLIC only, everywhere, and the assertion at the bottom of
 * this file makes that structural rather than a comment someone can edit away.
 *
 * ── Why literals and not bind parameters ────────────────────────────────────
 * The status/visibility predicate is emitted as SQL LITERALS. The feed indexes
 * are PARTIAL on exactly this predicate, and Postgres can only prove a partial
 * index applies against constants — parameterising it would silently disqualify
 * every one of them and turn each feed into a sequential scan with nothing in
 * the logs to notice. Same reasoning, same technique, as the Search engine.
 * Nothing user-supplied is interpolated anywhere in this file.
 */

/** Only PUBLISHED content is ever discoverable. */
const DISCOVERABLE_STATUS: BlogStatus = 'PUBLISHED';

/**
 * The visibilities a feed may surface — PUBLIC, and only PUBLIC.
 *
 * One set for all four feeds. The public feeds are cached ACROSS viewers, so
 * anything viewer-conditional in them would be a cache leak waiting to happen;
 * the Following feed could in principle be wider, since it is authenticated and
 * never shares a cache entry, but a discovery surface whose rules depend on
 * which feed you are reading is a rule nobody can hold in their head. It is also
 * the same set Search resolves to, so the platform's two discovery surfaces
 * cannot disagree about what is discoverable.
 */
export const FEED_VISIBILITY: FeedVisibilitySet = ['PUBLIC'];

/**
 * The eligibility predicate for a blog aliased `b` and its author aliased `u`.
 *
 * A constant rather than a builder: there is exactly one visibility set, so a
 * parameter would be a knob with one possible position.
 *
 * Four rules, each excluding a class the brief names:
 *
 *   status = PUBLISHED       drafts, archived and soft-deleted posts
 *   visibility = PUBLIC      private, unlisted and members-only posts
 *   publishedAt IS NOT NULL  a published row with no publication instant cannot
 *                            be ordered deterministically, so it cannot be paged
 *                            without risking duplicates — excluded rather than
 *                            sorted arbitrarily
 *   author status ACTIVE     posts by suspended or deleted accounts
 */
export const FEED_ELIGIBILITY: Prisma.Sql = Prisma.raw(
  `b."status" = '${DISCOVERABLE_STATUS}'
     AND b."visibility" IN (${FEED_VISIBILITY.map((v) => `'${v}'`).join(', ')})
     AND b."publishedAt" IS NOT NULL
     AND u."status" = 'ACTIVE'`
);

/**
 * The same rules in TypeScript, for callers that already hold a row.
 *
 * Not used by the query path — the SQL above is the enforcement point — but it
 * keeps the definition assertable from a unit test and gives sibling code a way
 * to answer "would this appear in a feed?" without a round trip.
 */
export function isFeedEligible(blog: {
  status: BlogStatus;
  visibility: BlogVisibility;
  publishedAt: Date | null;
  author: { status: string };
}): boolean {
  return (
    blog.status === DISCOVERABLE_STATUS &&
    FEED_VISIBILITY.includes(blog.visibility) &&
    blog.publishedAt !== null &&
    blog.author.status === 'ACTIVE'
  );
}

/**
 * Structural guard: nothing but PUBLIC may enter the discoverable set.
 *
 * A comment explaining the rule can be edited away by someone adding a
 * visibility to the array above; this throws at import time instead, so the
 * decision to widen discovery has to be made deliberately and in the open.
 */
for (const visibility of FEED_VISIBILITY) {
  if (visibility !== 'PUBLIC') {
    throw new Error(
      `Feeds surface PUBLIC content only — ${visibility} must not be discoverable. ` +
        'See feed.eligibility.ts for why UNLISTED and MEMBERS_ONLY are excluded.'
    );
  }
}
