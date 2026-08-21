import {
  isAuthorIndexable,
  isAuthorPubliclyVisible,
  isBlogIndexable,
  isBlogPubliclyVisible,
  isTermIndexable,
  robotsDirective,
} from '../seo.indexability';
import { authorSource, blogSource, termSource, withIndexing } from './helpers';

/**
 * The module's most security-relevant rules, tested without a database.
 *
 * Two questions are under test and they are deliberately different: whether a
 * page EXISTS for a stranger, and whether it may be INDEXED. Every case below
 * that distinguishes them is a case where collapsing the two would either hide
 * a page the platform serves or invite a crawler to index something an author
 * did not advertise.
 */

describe('blog visibility', () => {
  it('admits a published, public post', () => {
    expect(isBlogPubliclyVisible(blogSource())).toBe(true);
  });

  it.each([
    ['a draft', { status: 'DRAFT' as const }],
    ['an archived post', { status: 'ARCHIVED' as const }],
    ['a soft-deleted post', { status: 'DELETED' as const }],
    ['a private post', { visibility: 'PRIVATE' as const }],
    ['a members-only post', { visibility: 'MEMBERS_ONLY' as const }],
    ['a moderator-hidden post', { isHidden: true }],
  ])('refuses %s', (_label, overrides) => {
    expect(isBlogPubliclyVisible(blogSource(overrides))).toBe(false);
  });

  it('admits an unlisted post — it is reachable by anyone holding the link', () => {
    expect(isBlogPubliclyVisible(blogSource({ visibility: 'UNLISTED' }))).toBe(true);
  });

  it("admits a post whose author is suspended — the Blog module's rule, not overturned here", () => {
    const blog = blogSource({ author: { ...blogSource().author, status: 'SUSPENDED' } });
    expect(isBlogPubliclyVisible(blog)).toBe(true);
  });
});

describe('blog indexability', () => {
  it('admits a published, public post by an active author', () => {
    expect(isBlogIndexable(blogSource())).toBe(true);
  });

  it.each([
    ['a draft', { status: 'DRAFT' as const }],
    ['an archived post', { status: 'ARCHIVED' as const }],
    ['a soft-deleted post', { status: 'DELETED' as const }],
    ['a private post', { visibility: 'PRIVATE' as const }],
    ['a members-only post', { visibility: 'MEMBERS_ONLY' as const }],
    ['a moderator-hidden post', { isHidden: true }],
    ['a published post with no publication instant', { publishedAt: null }],
  ])('refuses %s', (_label, overrides) => {
    expect(isBlogIndexable(blogSource(overrides))).toBe(false);
  });

  // The case that proves the two questions are different.
  it('refuses an unlisted post it would happily serve', () => {
    const unlisted = blogSource({ visibility: 'UNLISTED' });
    expect(isBlogPubliclyVisible(unlisted)).toBe(true);
    expect(isBlogIndexable(unlisted)).toBe(false);
  });

  it.each([['SUSPENDED'], ['DEACTIVATED'], ['DELETED']])(
    'refuses a post whose author is %s',
    (status) => {
      const blog = blogSource({ author: { ...blogSource().author, status } });
      expect(isBlogIndexable(blog)).toBe(false);
    }
  );
});

describe('author visibility and indexability', () => {
  it('admits an active author with published work', () => {
    expect(isAuthorPubliclyVisible(authorSource())).toBe(true);
    expect(isAuthorIndexable(authorSource())).toBe(true);
  });

  it.each([['SUSPENDED'], ['DEACTIVATED'], ['DELETED']])('refuses a %s account', (status) => {
    expect(isAuthorPubliclyVisible(authorSource({ status }))).toBe(false);
    expect(isAuthorIndexable(authorSource({ status }))).toBe(false);
  });

  it('serves a private profile but never indexes it', () => {
    const priv = authorSource({ isPrivate: true });
    expect(isAuthorPubliclyVisible(priv)).toBe(true);
    expect(isAuthorIndexable(priv)).toBe(false);
  });

  it('serves a profile with nothing published but never indexes it', () => {
    const empty = authorSource({ publicPostCount: 0 });
    expect(isAuthorPubliclyVisible(empty)).toBe(true);
    expect(isAuthorIndexable(empty)).toBe(false);
  });
});

describe('term indexability', () => {
  it('admits a term with eligible posts', () => {
    expect(isTermIndexable(termSource())).toBe(true);
  });

  it('refuses a term with none — an empty list is a page with nothing on it', () => {
    expect(isTermIndexable(termSource({ publicPostCount: 0 }))).toBe(false);
  });
});

describe('robots directives', () => {
  it('renders both axes', async () => {
    await withIndexing(true, () => {
      expect(robotsDirective(true)).toMatchObject({
        index: true,
        follow: true,
        directive: 'index, follow',
      });
      expect(robotsDirective(false)).toMatchObject({
        index: false,
        follow: true,
        directive: 'noindex, follow',
      });
    });
  });

  it('forces noindex, nofollow when the deployment disables indexing', async () => {
    await withIndexing(false, () => {
      expect(robotsDirective(true)).toMatchObject({
        index: false,
        follow: false,
        directive: 'noindex, nofollow',
      });
    });
  });

  it('cannot be talked into indexing by a resource that would otherwise qualify', async () => {
    await withIndexing(false, () => {
      expect(robotsDirective(true, true).index).toBe(false);
    });
  });
});
