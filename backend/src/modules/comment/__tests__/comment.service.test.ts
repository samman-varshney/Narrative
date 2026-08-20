import { commentService, buildCommentTree, toCommentDTO } from '../comment.service';
import { commentRepository } from '../comment.repository';
import { blogRepository } from '../../blog/blog.repository';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { MAX_COMMENT_DEPTH } from '../comment.validator';

jest.mock('../comment.repository');
jest.mock('../../blog/blog.repository');
jest.mock('../../../core/events/eventBus');

const repo = commentRepository as jest.Mocked<typeof commentRepository>;
const blogs = blogRepository as jest.Mocked<typeof blogRepository>;
const bus = eventBus as jest.Mocked<typeof eventBus>;

const AUTHOR = 'author-1';
const ADMIN_ROLE = 'ADMIN';
const USER_ROLE = 'USER';

function makeRow(overrides: Partial<any> = {}): any {
  return {
    id: 'c1',
    content: 'hello',
    blogId: 'blog-1',
    authorId: AUTHOR,
    parentId: null,
    depth: 0,
    path: 'c1',
    isEdited: false,
    editedAt: null,
    deletedAt: null,
    isHidden: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    author: {
      id: AUTHOR,
      username: 'alice',
      name: 'Alice',
      avatar: null,
      bio: null,
      isVerified: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  blogs.findById.mockResolvedValue({ id: 'blog-1', status: 'PUBLISHED' } as any);
  repo.countReplies.mockResolvedValue(0);
  // create echoes back a row with the parentId/depth it was asked to persist
  repo.create.mockImplementation((data: any) =>
    Promise.resolve(
      makeRow({
        id: 'new',
        parentId: data.parentId,
        depth: data.depth,
        path: data.parentPath ? `${data.parentPath}/new` : 'new',
        content: data.content,
      })
    )
  );
});

describe('createComment', () => {
  it('creates a top-level comment and emits COMMENT_CREATED (no COMMENT_REPLIED)', async () => {
    await commentService.createComment(AUTHOR, 'blog-1', { content: 'hi' });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: null, depth: 0, parentPath: '' })
    );
    expect(bus.emit).toHaveBeenCalledWith(
      EVENTS.COMMENT_CREATED,
      expect.objectContaining({ blogId: 'blog-1', authorId: AUTHOR, parentId: null })
    );
    expect(bus.emit).not.toHaveBeenCalledWith(EVENTS.COMMENT_REPLIED, expect.anything());
  });

  it('rejects when the blog does not exist', async () => {
    blogs.findById.mockResolvedValue(null);
    await expect(
      commentService.createComment(AUTHOR, 'ghost', { content: 'hi' })
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'BLOG_NOT_FOUND' });
  });

  it('rejects when the blog is deleted', async () => {
    blogs.findById.mockResolvedValue({ id: 'blog-1', status: 'DELETED' } as any);
    await expect(
      commentService.createComment(AUTHOR, 'blog-1', { content: 'hi' })
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'BLOG_NOT_FOUND' });
  });

  it('strips HTML/script from content before persisting', async () => {
    await commentService.createComment(AUTHOR, 'blog-1', {
      content: '<b>hi</b><script>alert(1)</script>',
    });
    const persisted = repo.create.mock.calls[0][0].content;
    expect(persisted).toBe('hi');
    expect(persisted).not.toContain('<');
  });

  it('rejects content that sanitizes to empty', async () => {
    await expect(
      commentService.createComment(AUTHOR, 'blog-1', { content: '<script>x</script>' })
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_COMMENT' });
  });

  it('creates a reply via body parentId and emits COMMENT_REPLIED targeting the parent', async () => {
    repo.findById.mockResolvedValue(
      makeRow({ id: 'p1', authorId: 'bob', depth: 0, path: 'p1' })
    );
    await commentService.createComment(AUTHOR, 'blog-1', { content: 'hi', parentId: 'p1' });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'p1', depth: 1, parentPath: 'p1' })
    );
    expect(bus.emit).toHaveBeenCalledWith(
      EVENTS.COMMENT_REPLIED,
      expect.objectContaining({ parentId: 'p1', parentAuthorId: 'bob' })
    );
  });

  it('rejects a reply whose parent belongs to a different blog', async () => {
    repo.findById.mockResolvedValue(makeRow({ id: 'p1', blogId: 'other-blog' }));
    await expect(
      commentService.createComment(AUTHOR, 'blog-1', { content: 'hi', parentId: 'p1' })
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'PARENT_BLOG_MISMATCH' });
  });
});

describe('reply depth cap', () => {
  it('nests one level below the parent when under the cap', async () => {
    repo.findById.mockResolvedValue(makeRow({ id: 'p1', depth: 2, path: 'r/a/p1' }));
    await commentService.reply(AUTHOR, 'p1', { content: 'hi' });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'p1', depth: 3, parentPath: 'r/a/p1' })
    );
  });

  it('clamps: replying to a max-depth comment attaches to its parent at the same depth', async () => {
    const parentPath = Array.from({ length: MAX_COMMENT_DEPTH + 1 }, (_, i) => `n${i}`).join('/');
    repo.findById.mockResolvedValue(
      makeRow({ id: 'deep', parentId: 'gp', depth: MAX_COMMENT_DEPTH, path: parentPath })
    );

    await commentService.reply(AUTHOR, 'deep', { content: 'hi' });

    const arg = repo.create.mock.calls[0][0];
    expect(arg.parentId).toBe('gp'); // re-parented to the grandparent
    expect(arg.depth).toBe(MAX_COMMENT_DEPTH); // never exceeds the cap
    expect(arg.parentPath).toBe(parentPath.slice(0, parentPath.lastIndexOf('/')));
  });
});

describe('edit', () => {
  it('lets the author edit and emits COMMENT_UPDATED', async () => {
    repo.findById.mockResolvedValue(makeRow());
    repo.update.mockResolvedValue(makeRow({ isEdited: true }));
    const dto = await commentService.edit('c1', AUTHOR, USER_ROLE, { content: 'edited' });
    expect(dto.isEdited).toBe(true);
    expect(bus.emit).toHaveBeenCalledWith(EVENTS.COMMENT_UPDATED, expect.any(Object));
  });

  it.each([
    ['a stranger', 'stranger', USER_ROLE, true],
    ['the author', AUTHOR, USER_ROLE, false],
    ['an admin', 'stranger', ADMIN_ROLE, false],
  ])('edit by %s -> forbidden=%s', async (_who, userId, role, forbidden) => {
    repo.findById.mockResolvedValue(makeRow());
    repo.update.mockResolvedValue(makeRow());
    const promise = commentService.edit('c1', userId, role, { content: 'x' });
    if (forbidden) {
      await expect(promise).rejects.toMatchObject({ statusCode: 403, errorCode: 'FORBIDDEN' });
    } else {
      await expect(promise).resolves.toBeDefined();
    }
  });

  it('refuses to edit a deleted comment', async () => {
    repo.findById.mockResolvedValue(makeRow({ deletedAt: new Date() }));
    await expect(
      commentService.edit('c1', AUTHOR, USER_ROLE, { content: 'x' })
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'COMMENT_DELETED' });
  });
});

describe('softDelete / restore / hide', () => {
  it('author soft-deletes and emits COMMENT_DELETED', async () => {
    repo.findById.mockResolvedValue(makeRow());
    repo.softDelete.mockResolvedValue(makeRow({ deletedAt: new Date() }));
    const dto = await commentService.softDelete('c1', AUTHOR, USER_ROLE);
    expect(dto.isDeleted).toBe(true);
    expect(dto.content).toBe('This comment has been deleted.');
    expect(bus.emit).toHaveBeenCalledWith(EVENTS.COMMENT_DELETED, expect.any(Object));
  });

  it('non-author non-admin cannot delete', async () => {
    repo.findById.mockResolvedValue(makeRow());
    await expect(
      commentService.softDelete('c1', 'stranger', USER_ROLE)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('restore requires content:restore', async () => {
    repo.findById.mockResolvedValue(makeRow({ deletedAt: new Date() }));
    repo.restore.mockResolvedValue(makeRow());
    await expect(
      commentService.restore('c1', { userId: 'u9', role: USER_ROLE })
    ).rejects.toMatchObject({ statusCode: 403 });

    await commentService.restore('c1', { userId: 'admin', role: ADMIN_ROLE });
    expect(repo.restore).toHaveBeenCalledWith('c1');
    expect(bus.emit).toHaveBeenCalledWith(EVENTS.COMMENT_RESTORED, expect.any(Object));
  });

  it('hideForModeration requires content:hide and emits CONTENT_MODERATED', async () => {
    repo.findById.mockResolvedValue(makeRow());
    repo.setModerationHidden.mockResolvedValue(true);

    await expect(
      commentService.hideForModeration('c1', { userId: 'u9', role: USER_ROLE })
    ).rejects.toMatchObject({ statusCode: 403 });

    const snapshot = await commentService.hideForModeration('c1', {
      userId: 'mod',
      role: 'MODERATOR',
    });

    // The moderator sees the RAW text, not the reader's tombstone placeholder.
    expect(snapshot?.content).toBe('hello');
    expect(bus.emit).toHaveBeenCalledWith(
      EVENTS.CONTENT_MODERATED,
      expect.objectContaining({
        targetType: 'COMMENT',
        targetId: 'c1',
        actorId: 'mod',
        action: 'HIDDEN',
      })
    );
  });

  it('hideForModeration reports a conflict when another moderator got there first', async () => {
    repo.findById.mockResolvedValue(makeRow());
    repo.setModerationHidden.mockResolvedValue(false);

    await expect(
      commentService.hideForModeration('c1', { userId: 'mod', role: 'MODERATOR' })
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'ALREADY_HIDDEN' });
    expect(bus.emit).not.toHaveBeenCalledWith(EVENTS.CONTENT_MODERATED, expect.anything());
  });

  it('deleteForModeration is administrator-only', async () => {
    repo.findById.mockResolvedValue(makeRow());
    repo.moderationDelete.mockResolvedValue(true);

    await expect(
      commentService.deleteForModeration('c1', { userId: 'mod', role: 'MODERATOR' })
    ).rejects.toMatchObject({ statusCode: 403 });

    await commentService.deleteForModeration('c1', { userId: 'admin', role: 'ADMIN' });
    expect(repo.moderationDelete).toHaveBeenCalledWith('c1');
  });

  it('a hidden comment cannot be deleted by its author either', async () => {
    repo.findById.mockResolvedValue(makeRow({ isHidden: true }));

    // Same reason edits are refused: the state a moderator acted on must not
    // move underneath the decision. It is also what keeps "tombstoned AND
    // hidden" meaning exactly one thing \u2014 moderation removed this.
    await expect(
      commentService.softDelete('c1', AUTHOR, USER_ROLE)
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONTENT_MODERATED' });
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it('the cheap restore cannot be used to undo a removal', async () => {
    repo.findById.mockResolvedValue(makeRow({ deletedAt: new Date(), isHidden: true }));

    // `restore` costs content:restore; reviving a removal costs content:delete.
    // Without this guard an administrator-only action would be undoable through
    // the endpoint next door, and with no audit record.
    await expect(
      commentService.restore('c1', { userId: 'mod', role: 'MODERATOR' })
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONTENT_MODERATED' });
    expect(repo.restore).not.toHaveBeenCalled();
  });

  it('restoreFromModeration lifts a plain hide for a moderator', async () => {
    repo.findById.mockResolvedValue(makeRow({ isHidden: true }));
    repo.moderationRestore.mockResolvedValue(true);

    await commentService.restoreFromModeration('c1', { userId: 'mod', role: 'MODERATOR' });

    expect(repo.moderationRestore).toHaveBeenCalledWith('c1', { revive: false });
    expect(bus.emit).toHaveBeenCalledWith(
      EVENTS.CONTENT_RESTORED,
      expect.objectContaining({ targetType: 'COMMENT', targetId: 'c1', actorId: 'mod' })
    );
  });

  it('refuses a moderator the revival of a removal, and allows an administrator', async () => {
    repo.findById.mockResolvedValue(makeRow({ deletedAt: new Date(), isHidden: true }));
    repo.moderationRestore.mockResolvedValue(true);

    await expect(
      commentService.restoreFromModeration('c1', { userId: 'mod', role: 'MODERATOR' })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repo.moderationRestore).not.toHaveBeenCalled();

    await commentService.restoreFromModeration('c1', { userId: 'admin', role: ADMIN_ROLE });
    expect(repo.moderationRestore).toHaveBeenCalledWith('c1', { revive: true });
  });

  it('will not resurrect a comment its author deleted', async () => {
    repo.findById.mockResolvedValue(makeRow({ deletedAt: new Date(), isHidden: false }));

    await expect(
      commentService.restoreFromModeration('c1', { userId: 'admin', role: ADMIN_ROLE })
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'NOT_HIDDEN' });
    expect(repo.moderationRestore).not.toHaveBeenCalled();
  });

  it('a hidden comment cannot be edited, by its author or by an admin', async () => {
    repo.findById.mockResolvedValue(makeRow({ isHidden: true }));

    await expect(
      commentService.edit('c1', AUTHOR, USER_ROLE, { content: 'rewritten' })
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONTENT_MODERATED' });

    await expect(
      commentService.edit('c1', 'admin', ADMIN_ROLE, { content: 'rewritten' })
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'CONTENT_MODERATED' });
  });
});

describe('getBlogComments', () => {
  it('builds a nested tree in tree mode via bounded BFS', async () => {
    const root = makeRow({ id: 'r1', parentId: null });
    const child = makeRow({ id: 'ch1', parentId: 'r1', depth: 1 });
    repo.findTopLevel.mockResolvedValue([root]);
    repo.countBlogComments.mockResolvedValue(2);
    // level 0: children of [r1] -> [ch1]; level 1: children of [ch1] -> []
    repo.findChildrenByParentIds
      .mockResolvedValueOnce([child])
      .mockResolvedValue([]);

    const result = await commentService.getBlogComments('blog-1', {
      limit: 20,
      cursor: undefined,
      tree: true,
    } as any);

    expect(result.totalCount).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].replies).toHaveLength(1);
    expect(result.items[0].replies![0].id).toBe('ch1');
    expect(result.items[0].replyCount).toBe(1);
  });

  it('lazy mode returns roots with reply counts and no BFS', async () => {
    repo.findTopLevel.mockResolvedValue([makeRow({ id: 'r1' })]);
    repo.countBlogComments.mockResolvedValue(1);
    repo.countRepliesFor.mockResolvedValue(new Map([['r1', 4]]));

    const result = await commentService.getBlogComments('blog-1', {
      limit: 20,
      cursor: undefined,
      tree: false,
    } as any);

    expect(result.items[0].replyCount).toBe(4);
    expect(result.items[0].replies).toBeUndefined();
    expect(repo.findChildrenByParentIds).not.toHaveBeenCalled();
  });
});

describe('buildCommentTree (pure)', () => {
  it('nests children under parents and keeps tombstones with their children', () => {
    const rows = [
      makeRow({ id: 'r', parentId: null, deletedAt: new Date() }),
      makeRow({ id: 'a', parentId: 'r', depth: 1 }),
      makeRow({ id: 'b', parentId: 'a', depth: 2 }),
    ];
    const [tree] = buildCommentTree(rows, ['r']);

    expect(tree.isDeleted).toBe(true);
    expect(tree.content).toBe('This comment has been deleted.');
    expect(tree.replies).toHaveLength(1); // child survives the deleted parent
    expect(tree.replies![0].replies![0].id).toBe('b');
  });

  it('ignores rows not reachable from the given roots', () => {
    const rows = [makeRow({ id: 'r', parentId: null }), makeRow({ id: 'x', parentId: 'other' })];
    const trees = buildCommentTree(rows, ['r']);
    expect(trees).toHaveLength(1);
    expect(trees[0].replies).toHaveLength(0);
  });
});

describe('toCommentDTO', () => {
  it('exposes real content for a normal comment', () => {
    const dto = toCommentDTO(makeRow({ content: 'visible' }));
    expect(dto.content).toBe('visible');
    expect(dto.isDeleted).toBe(false);
  });
});
