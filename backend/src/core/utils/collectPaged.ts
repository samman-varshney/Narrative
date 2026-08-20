/**
 * Drains a cursor-paged query into one array, with a hard row ceiling.
 *
 * Written once here because the data-export collectors in Blog, Comment,
 * Bookmark, Follow, Notification, Media and Analytics all need the identical
 * loop, and seven hand-rolled copies is seven chances to get the termination
 * condition subtly wrong — the failure mode being an infinite loop that pins a
 * database connection rather than a wrong answer somebody would notice.
 *
 * ── Why a ceiling at all ────────────────────────────────────────────────────
 * The caller accumulates every row in memory. Without a cap, one account with a
 * pathological history decides how much heap the process uses, and it decides it
 * inside a background worker where nothing is watching. `limit` makes that
 * bounded, and `truncated` makes reaching it VISIBLE — a partial export that
 * says so is recoverable; one that looks complete is not.
 *
 * `fetchPage` receives the last item of the previous page (undefined on the
 * first call) and returns the next page. Termination is a short page or an empty
 * one, so a page-sized result at the exact end of a collection costs one extra
 * query rather than looping forever.
 */
export interface CollectedPage<T> {
  items: T[];
  /** True when `limit` stopped the walk before the collection was exhausted. */
  truncated: boolean;
}

export async function collectPaged<T>(
  fetchPage: (previous: T | undefined) => Promise<T[]>,
  pageSize: number,
  limit: number
): Promise<CollectedPage<T>> {
  const items: T[] = [];
  let previous: T | undefined;

  for (;;) {
    const page = await fetchPage(previous);
    if (page.length === 0) return { items, truncated: false };

    items.push(...page);

    if (items.length >= limit) {
      // Trim rather than return an over-long array: a caller that asked for at
      // most `limit` rows should never have to defend against getting more.
      return { items: items.slice(0, limit), truncated: true };
    }

    // A short page means the source is exhausted. Checked AFTER the limit so a
    // final page that also crosses the ceiling reports truncation.
    if (page.length < pageSize) return { items, truncated: false };

    previous = page[page.length - 1];
  }
}
