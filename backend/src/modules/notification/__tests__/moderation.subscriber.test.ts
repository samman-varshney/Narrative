import {
  onContentModerated,
  onContentRestored,
  onUserSuspended,
  onUserUnsuspended,
  registerModerationNotificationSubscriber,
} from '../subscribers/moderation.subscriber';
import { notificationOrchestrator } from '../notification.orchestrator';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { renderNotificationEmail } from '../templates';

jest.mock('../notification.orchestrator');

/**
 * Moderation outcomes → notifications.
 *
 * Three properties, each with a real failure behind it:
 *
 *   the author is TOLD             content that silently stops appearing, with
 *                                  the dashboard still calling it published, is
 *                                  indistinguishable from a platform bug
 *   the moderator is NOT NAMED     moderation staff are the most
 *                                  harassment-exposed people on any platform
 *   one event, one notification    the bus is at-least-once, so a redelivered
 *                                  job must not notify twice
 */

const orchestrator = notificationOrchestrator as jest.Mocked<typeof notificationOrchestrator>;

const meta = (eventId = 'event-1') => ({
  eventId,
  event: 'CONTENT_MODERATED',
  emittedAt: new Date().toISOString(),
});

beforeEach(() => {
  jest.clearAllMocks();
  orchestrator.dispatch.mockResolvedValue({ created: true });
});

describe('content moderation', () => {
  it('tells the author their post was hidden, and why', async () => {
    await onContentModerated(
      {
        targetType: 'BLOG',
        targetId: 'blog-1',
        ownerId: 'author-1',
        action: 'HIDDEN',
        reason: 'Affiliate spam',
      },
      meta()
    );

    expect(orchestrator.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 'author-1',
        type: 'SYSTEM',
        entityType: 'BLOG',
        entityId: 'blog-1',
      })
    );

    const request = orchestrator.dispatch.mock.calls[0]![0];
    expect(request.metadata!.subject).toContain('hidden');
    expect(request.metadata!.body).toContain('Affiliate spam');
  });

  it('never names the moderator, even though the event carries them', async () => {
    await onContentModerated(
      {
        targetType: 'BLOG',
        targetId: 'blog-1',
        ownerId: 'author-1',
        action: 'HIDDEN',
        // The event DOES carry the actor — subscribers that need it (the audit
        // trail) can have it. This one deliberately drops it.
        actorId: 'moderator-42',
      } as never,
      meta()
    );

    const request = orchestrator.dispatch.mock.calls[0]![0];
    // The moderator IS recorded — in the audit log, which the affected user
    // cannot read.
    expect(request.actorId).toBeNull();
    expect(JSON.stringify(request)).not.toContain('moderator-42');
  });

  it('distinguishes a removal from a hide', async () => {
    await onContentModerated(
      { targetType: 'COMMENT', targetId: 'c-1', ownerId: 'author-1', action: 'DELETED' },
      meta()
    );

    const request = orchestrator.dispatch.mock.calls[0]![0];
    expect(request.metadata!.subject).toContain('removed');
    expect(request.metadata!.moderationAction).toBe('DELETED');
  });

  it('says "post" for a blog and "comment" for a comment', async () => {
    await onContentModerated(
      { targetType: 'BLOG', targetId: 'b', ownerId: 'a', action: 'HIDDEN' },
      meta()
    );
    await onContentModerated(
      { targetType: 'COMMENT', targetId: 'c', ownerId: 'a', action: 'HIDDEN' },
      meta('event-2')
    );

    expect(orchestrator.dispatch.mock.calls[0]![0].metadata!.subject).toContain('post');
    expect(orchestrator.dispatch.mock.calls[1]![0].metadata!.subject).toContain('comment');
  });

  it('tells the author when their content comes back', async () => {
    await onContentRestored(
      { targetType: 'BLOG', targetId: 'blog-1', ownerId: 'author-1' },
      meta()
    );

    const request = orchestrator.dispatch.mock.calls[0]![0];
    expect(request.metadata!.moderationAction).toBe('RESTORED');
    expect(request.recipientId).toBe('author-1');
  });

  it('says "as a draft" when the restore revived a removed post', async () => {
    // A revived blog comes back as a DRAFT. Telling its author it is publicly
    // visible would send them looking for a post that is not there.
    await onContentRestored(
      { targetType: 'BLOG', targetId: 'blog-1', ownerId: 'author-1', revived: true },
      meta()
    );

    const request = orchestrator.dispatch.mock.calls[0]![0];
    expect(request.metadata!.body).toContain('draft');
    expect(request.metadata!.body).not.toContain('publicly visible');
  });

  it('still says "publicly visible" for a lifted hide, and for any comment', async () => {
    await onContentRestored(
      { targetType: 'BLOG', targetId: 'blog-1', ownerId: 'author-1', revived: false },
      meta()
    );
    // A comment has no draft state to come back to: revived or not, it is back.
    await onContentRestored(
      { targetType: 'COMMENT', targetId: 'c-1', ownerId: 'author-1', revived: true },
      meta()
    );

    expect(orchestrator.dispatch.mock.calls[0]![0].metadata!.body).toContain('publicly visible');
    expect(orchestrator.dispatch.mock.calls[1]![0].metadata!.body).toContain('publicly visible');
  });

  it('ignores a payload missing the owner — there is nobody to tell', async () => {
    await onContentModerated({ targetType: 'BLOG', targetId: 'blog-1' }, meta());
    expect(orchestrator.dispatch).not.toHaveBeenCalled();
  });
});

describe('account status', () => {
  it('tells a suspended user, with the reason given', async () => {
    await onUserSuspended({ userId: 'user-1', reason: 'Spam' }, meta());

    const request = orchestrator.dispatch.mock.calls[0]![0];
    expect(request).toMatchObject({
      recipientId: 'user-1',
      actorId: null,
      type: 'SYSTEM',
      entityType: 'USER',
    });
    expect(request.metadata!.body).toContain('Spam');
  });

  it('tells a reinstated user', async () => {
    await onUserUnsuspended({ userId: 'user-1' }, meta());
    expect(orchestrator.dispatch.mock.calls[0]![0].metadata!.moderationAction).toBe(
      'UNSUSPENDED'
    );
  });
});

describe('deduplication', () => {
  it('produces ONE notification when a job is redelivered', async () => {
    // The bus is at-least-once, and `eventId` is stable across retries.
    const payload = {
      targetType: 'BLOG' as const,
      targetId: 'blog-1',
      ownerId: 'author-1',
      action: 'HIDDEN' as const,
    };

    await onContentModerated(payload, meta('same-event'));
    await onContentModerated(payload, meta('same-event'));

    const keys = orchestrator.dispatch.mock.calls.map((c) => c[0].dedupeKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('produces TWO when the same content is hidden, restored and hidden again', async () => {
    const payload = {
      targetType: 'BLOG' as const,
      targetId: 'blog-1',
      ownerId: 'author-1',
      action: 'HIDDEN' as const,
    };

    await onContentModerated(payload, meta('first-hide'));
    await onContentModerated(payload, meta('second-hide'));

    const keys = orchestrator.dispatch.mock.calls.map((c) => c[0].dedupeKey);
    // A key built from the target id alone would swallow the second hide.
    expect(new Set(keys).size).toBe(2);
  });
});

describe('registration', () => {
  it('subscribes to each moderation outcome exactly once', () => {
    eventBus.clearHandlers();
    registerModerationNotificationSubscriber();

    for (const event of [
      EVENTS.CONTENT_MODERATED,
      EVENTS.CONTENT_RESTORED,
      EVENTS.USER_SUSPENDED,
      EVENTS.USER_UNSUSPENDED,
    ]) {
      expect(eventBus.handlerCount(event)).toBe(1);
    }

    eventBus.clearHandlers();
  });
});

describe('the email these produce', () => {
  it('renders through the existing SYSTEM template', async () => {
    await onUserSuspended({ userId: 'user-1', reason: 'Spam' }, meta());
    const request = orchestrator.dispatch.mock.calls[0]![0];

    const email = renderNotificationEmail('SYSTEM', {
      recipientName: 'Alice',
      actorName: null,
      metadata: request.metadata as Record<string, unknown>,
      entityId: request.entityId ?? null,
    });

    expect(email.subject).toBe('Your account has been suspended');
    expect(email.text).toContain('Spam');
  });

  it('escapes a moderator-written reason before it reaches an HTML email', async () => {
    await onUserSuspended(
      { userId: 'user-1', reason: '<script>alert(1)</script>' },
      meta()
    );
    const request = orchestrator.dispatch.mock.calls[0]![0];

    const email = renderNotificationEmail('SYSTEM', {
      recipientName: 'Alice',
      actorName: null,
      metadata: request.metadata as Record<string, unknown>,
      entityId: null,
    });

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});
