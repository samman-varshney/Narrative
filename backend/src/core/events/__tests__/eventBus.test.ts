import { eventBus, EVENTS } from '../eventBus';

describe('eventBus (durable dispatch)', () => {
  beforeEach(() => eventBus.clearHandlers());
  afterAll(() => eventBus.clearHandlers());

  it('runs a registered handler for its event', async () => {
    const handler = jest.fn();
    eventBus.on(EVENTS.USER_FOLLOWED, handler);

    await eventBus.dispatch(EVENTS.USER_FOLLOWED, { followerId: 'a', followingId: 'b' });

    // Handlers receive (payload, meta). The payload is asserted exactly; the
    // meta only has to carry an event id, since its value is a fresh uuid.
    expect(handler).toHaveBeenCalledWith(
      { followerId: 'a', followingId: 'b' },
      expect.objectContaining({ event: EVENTS.USER_FOLLOWED, eventId: expect.any(String) })
    );
  });

  it('runs every handler registered for the same event', async () => {
    const first = jest.fn();
    const second = jest.fn();
    eventBus.on(EVENTS.USER_FOLLOWED, first);
    eventBus.on(EVENTS.USER_FOLLOWED, second);

    await eventBus.dispatch(EVENTS.USER_FOLLOWED, {});

    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it('does not run handlers registered for a different event', async () => {
    const handler = jest.fn();
    eventBus.on(EVENTS.USER_FOLLOWED, handler);

    await eventBus.dispatch(EVENTS.BLOG_PUBLISHED, {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('is a no-op for an event with no subscribers', async () => {
    await expect(eventBus.dispatch('NOBODY_LISTENS', {})).resolves.toBeUndefined();
  });

  describe('handler isolation', () => {
    it('a throwing handler does not prevent its siblings from running', async () => {
      const exploding = jest.fn(() => {
        throw new Error('subscriber bug');
      });
      const healthy = jest.fn();
      eventBus.on(EVENTS.USER_FOLLOWED, exploding);
      eventBus.on(EVENTS.USER_FOLLOWED, healthy);

      await eventBus.dispatch(EVENTS.USER_FOLLOWED, {});

      expect(healthy).toHaveBeenCalled();
    });

    it('a rejecting async handler does not reject the dispatch', async () => {
      eventBus.on(EVENTS.USER_FOLLOWED, async () => {
        throw new Error('async subscriber bug');
      });

      // This is what keeps a notification bug from crashing blogService.publish().
      await expect(eventBus.dispatch(EVENTS.USER_FOLLOWED, {})).resolves.toBeUndefined();
    });
  });

  describe('emit', () => {
    it('dispatches inline under NODE_ENV=test so assertions stay synchronous', async () => {
      const handler = jest.fn();
      eventBus.on(EVENTS.BLOG_BOOKMARKED, handler);

      eventBus.emit(EVENTS.BLOG_BOOKMARKED, { blogId: 'b1', userId: 'u1' });
      await Promise.resolve(); // let the inline dispatch settle

      expect(handler).toHaveBeenCalledWith(
        { blogId: 'b1', userId: 'u1' },
        expect.objectContaining({ event: EVENTS.BLOG_BOOKMARKED, eventId: expect.any(String) })
      );
    });

    it('never throws, so a bus failure cannot fail the caller request', () => {
      eventBus.on(EVENTS.BLOG_BOOKMARKED, () => {
        throw new Error('boom');
      });

      expect(() => eventBus.emit(EVENTS.BLOG_BOOKMARKED, {})).not.toThrow();
    });
  });
});
