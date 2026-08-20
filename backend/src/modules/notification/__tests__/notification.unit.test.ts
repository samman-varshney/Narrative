import {
  resolvePreferences,
  DEFAULT_PREFERENCES,
  notificationPreferencesSchema,
} from '../notification.preferences';
import { renderNotificationEmail } from '../templates';
import { notificationListQuerySchema } from '../notification.validator';
import { LogEmailProvider } from '../../../core/providers/email/LogEmailProvider';
import { MAX_PAGE_LIMIT } from '../../../core/utils/pagination';

describe('resolvePreferences', () => {
  it('returns defaults when nothing is stored', () => {
    expect(resolvePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(resolvePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });

  it('overlays a partial override onto the defaults', () => {
    const prefs = resolvePreferences({ FOLLOW: { email: false } });

    expect(prefs.FOLLOW).toEqual({ inApp: true, email: false });
    expect(prefs.COMMENT).toEqual(DEFAULT_PREFERENCES.COMMENT); // untouched
  });

  it('falls back to defaults on malformed stored data rather than throwing', () => {
    // A parse error must not silence a user's notifications.
    expect(resolvePreferences({ FOLLOW: 'yes-please' })).toEqual(DEFAULT_PREFERENCES);
    expect(resolvePreferences('garbage')).toEqual(DEFAULT_PREFERENCES);
    expect(resolvePreferences(42)).toEqual(DEFAULT_PREFERENCES);
  });

  it('ignores unknown notification types in stored data', () => {
    expect(() => resolvePreferences({ NOT_A_TYPE: { email: true } })).not.toThrow();
  });

  it('does not mutate DEFAULT_PREFERENCES across calls', () => {
    const first = resolvePreferences({ FOLLOW: { email: false } });
    const second = resolvePreferences(null);

    expect(first.FOLLOW.email).toBe(false);
    // Would fail if the defaults object were shared by reference.
    expect(second.FOLLOW.email).toBe(true);
    expect(DEFAULT_PREFERENCES.FOLLOW.email).toBe(true);
  });

  it('defaults COMMENT email to off, since a popular post is high-volume', () => {
    expect(DEFAULT_PREFERENCES.COMMENT.email).toBe(false);
  });

  it('keeps every type reachable in-app by default', () => {
    for (const toggles of Object.values(DEFAULT_PREFERENCES)) {
      expect(toggles.inApp).toBe(true);
    }
  });
});

describe('notificationPreferencesSchema', () => {
  it('accepts a partial patch on both axes', () => {
    expect(notificationPreferencesSchema.parse({ FOLLOW: { email: false } })).toEqual({
      FOLLOW: { email: false },
    });
  });

  it('rejects a non-boolean toggle', () => {
    expect(
      notificationPreferencesSchema.safeParse({ FOLLOW: { email: 'nope' } }).success
    ).toBe(false);
  });

  it('rejects an unknown notification type', () => {
    expect(
      notificationPreferencesSchema.safeParse({ NOPE: { email: true } }).success
    ).toBe(false);
  });
});

describe('notificationListQuerySchema', () => {
  it('defaults sort to recent', () => {
    expect(notificationListQuerySchema.parse({}).sort).toBe('recent');
  });

  it('coerces isRead from its query-string form', () => {
    expect(notificationListQuerySchema.parse({ isRead: 'false' }).isRead).toBe(false);
    expect(notificationListQuerySchema.parse({ isRead: 'true' }).isRead).toBe(true);
    expect(notificationListQuerySchema.parse({}).isRead).toBeUndefined();
  });

  it('rejects a limit above the shared cap', () => {
    expect(
      notificationListQuerySchema.safeParse({ limit: String(MAX_PAGE_LIMIT + 1) }).success
    ).toBe(false);
  });

  it('rejects an unknown type filter', () => {
    expect(notificationListQuerySchema.safeParse({ type: 'GOSSIP' }).success).toBe(false);
  });
});

describe('email templates', () => {
  const ctx = {
    recipientName: 'Ada',
    actorName: 'Grace',
    metadata: { blogTitle: 'On Compilers', slug: 'on-compilers', username: 'grace' },
    entityId: 'e1',
  };

  it.each(['FOLLOW', 'COMMENT', 'REPLY', 'BLOG', 'SYSTEM'] as const)(
    'renders a complete email for %s',
    (type) => {
      const email = renderNotificationEmail(type, ctx);

      expect(email.subject).toBeTruthy();
      expect(email.html).toContain('Ada');
      expect(email.text).toContain('Ada');
    }
  );

  it('names the actor in the subject', () => {
    expect(renderNotificationEmail('FOLLOW', ctx).subject).toContain('Grace');
  });

  it('falls back gracefully when the actor is unknown', () => {
    const email = renderNotificationEmail('FOLLOW', { ...ctx, actorName: null });

    expect(email.subject).toContain('Someone');
    expect(email.subject).not.toContain('null');
  });

  it('survives missing metadata without emitting "undefined"', () => {
    const email = renderNotificationEmail('BLOG', { ...ctx, metadata: {} });

    expect(email.subject).not.toContain('undefined');
    expect(email.html).not.toContain('undefined');
  });

  it('always includes an opt-out link — required for non-transactional mail', () => {
    for (const type of ['FOLLOW', 'COMMENT', 'REPLY', 'BLOG', 'SYSTEM'] as const) {
      const email = renderNotificationEmail(type, ctx);
      expect(email.html).toContain('/settings/notifications');
      expect(email.text).toContain('/settings/notifications');
    }
  });

  describe('HTML escaping', () => {
    // Display names are user-controlled and only length-validated upstream, so a
    // template that interpolates them raw ships attacker markup in mail the
    // platform vouches for. FOLLOW email is on by default — one follow is enough.
    const attacker = {
      ...ctx,
      actorName: '<a href="https://evil.example/reset">Reset your password</a>',
      recipientName: '<script>alert(1)</script>',
      metadata: { ...ctx.metadata, blogTitle: '<img src=x onerror=alert(1)>' },
    };

    it('escapes an actor name carrying an anchor tag', () => {
      const email = renderNotificationEmail('FOLLOW', attacker);

      expect(email.html).not.toContain('<a href="https://evil.example/reset">');
      expect(email.html).toContain('&lt;a href=');
    });

    it('escapes a recipient name carrying a script tag', () => {
      const email = renderNotificationEmail('FOLLOW', attacker);

      expect(email.html).not.toContain('<script>');
      expect(email.html).toContain('&lt;script&gt;');
    });

    it('escapes a blog title carrying an inline event handler', () => {
      const email = renderNotificationEmail('BLOG', attacker);

      expect(email.html).not.toContain('<img src=x onerror=');
      expect(email.html).toContain('&lt;img');
    });

    it('url-encodes slugs so they cannot break out of the href', () => {
      const email = renderNotificationEmail('BLOG', {
        ...ctx,
        metadata: { ...ctx.metadata, slug: '"><script>alert(1)</script>' },
      });

      expect(email.html).not.toContain('<script>');
      expect(email.html).not.toContain('"><');
    });

    it('leaves the plain-text part unescaped — it is not markup', () => {
      const email = renderNotificationEmail('FOLLOW', attacker);
      expect(email.text).toContain('<a href=');
    });
  });

  it('provides a text part alongside the html one', () => {
    const email = renderNotificationEmail('COMMENT', ctx);
    expect(email.text).not.toContain('<');
  });
});

describe('LogEmailProvider', () => {
  it('reports a provider message id without sending anything', async () => {
    const provider = new LogEmailProvider();

    const result = await provider.send({
      to: 'ada@test.local',
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
    });

    expect(provider.name).toBe('log');
    expect(result.providerMessageId).toMatch(/^log-/);
  });

  it('returns a distinct id per send, so deliveries stay distinguishable', async () => {
    const provider = new LogEmailProvider();
    const a = await provider.send({ to: 'a@t.local', subject: 's', html: '', text: '' });
    const b = await provider.send({ to: 'b@t.local', subject: 's', html: '', text: '' });

    expect(a.providerMessageId).not.toBe(b.providerMessageId);
  });
});
