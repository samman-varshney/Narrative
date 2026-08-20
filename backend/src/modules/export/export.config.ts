/**
 * Export module tuning. Every number that governs cost or policy lives here, so
 * "how often may someone export" is one edit rather than a hunt through the
 * service, the worker and the sweep.
 */

/** Minimum gap between two export requests from the same account. */
export const EXPORT_COOLDOWN_HOURS = 24;

/**
 * How long a finished artifact stays downloadable.
 *
 * Short on purpose. The artifact is the most concentrated copy of a person's
 * data the platform ever produces, and its risk is entirely a function of how
 * long it sits around. Seven days is long enough to survive a weekend and a
 * missed email; a request that lapses can simply be made again.
 */
export const EXPORT_TTL_DAYS = 7;

/**
 * Hard ceiling on a single COMPRESSED artifact.
 *
 * A build that would exceed this FAILS rather than truncating. A silently
 * partial export of your own data is worse than no export: you cannot tell which
 * half is missing, and the failure is invisible precisely when the export
 * matters most. 25 MB of gzipped JSON is an enormous amount of text — reaching
 * it means something is wrong (or the account is extraordinary), and either way
 * a human should see it rather than a truncation nobody notices.
 */
export const EXPORT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Page size for the cursor walks the builder uses to read large collections.
 *
 * The builder assembles the whole document in memory, so the ceiling that
 * matters is EXPORT_MAX_BYTES, not this. This exists to keep any SINGLE query
 * bounded — one `findMany` over an account with 50,000 comments would hold the
 * entire result set and its Prisma hydration in memory at once, on a shared
 * connection, while every other request waits behind it.
 */
export const EXPORT_PAGE_SIZE = 500;

/**
 * Upper bound on rows per collection, as a backstop against an account whose
 * volume would blow the memory budget before the byte cap could be checked.
 *
 * Reaching it is reported in the document's `truncated` list rather than
 * hidden — the one place a partial answer is allowed, because the alternative
 * is failing an export over a notification history nobody needs complete.
 */
export const EXPORT_MAX_ROWS_PER_COLLECTION = 50_000;

/** Schema version of the export document itself, for future readers. */
export const EXPORT_FORMAT_VERSION = 1;
