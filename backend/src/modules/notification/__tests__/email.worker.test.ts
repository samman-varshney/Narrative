import { prisma } from '../../../core/database/prisma';
import { notificationRepository } from '../notification.repository';
import { notificationDeliveryRepository } from '../notificationDelivery.repository';
import { resetDb, disconnectDb, makeUser } from '../../../test/db';
import { SEND_NOTIFICATION_EMAIL } from '../channels/email.channel';

/**
 * Worker tests. The BullMQ `createWorker` is mocked so the processor is captured
 * and invoked directly — that exercises the real processing logic (rendering,
 * provider call, delivery updates, rethrow-for-retry) without a live queue.
 */
let processor: (job: any) => Promise<any>;

jest.mock('../../../core/providers/queue', () => ({
  QUEUES: { EMAIL: 'email_queue', NOTIFICATION: 'notification_queue' },
  emailQueue: { add: jest.fn() },
  notificationQueue: { add: jest.fn() },
  createWorker: jest.fn((_name: string, fn: any) => {
    processor = fn;
    return { close: jest.fn() };
  }),
  createQueue: jest.fn(),
  closeWorkers: jest.fn(),
}));

const send = jest.fn();
jest.mock('../../../core/providers/email', () => ({
  emailProvider: {
    name: 'test-provider',
    send: (...args: any[]) => send(...args),
  },
}));

// Import AFTER the mocks so the worker registers against them.
import '../email.worker';

const job = (data: unknown) => ({ id: 'j1', name: SEND_NOTIFICATION_EMAIL, data });

describe('email worker', () => {
  let recipient: { id: string; email: string; name: string };
  let notificationId: string;
  let deliveryId: string;

  beforeEach(async () => {
    await resetDb();
    jest.clearAllMocks();
    send.mockResolvedValue({ providerMessageId: 'prov-1' });

    recipient = (await makeUser()) as any;
    const created = await notificationRepository.create({
      recipientId: recipient.id,
      type: 'FOLLOW',
      dedupeKey: 'k1',
    });
    notificationId = created.id!;
    deliveryId = (await notificationDeliveryRepository.create(notificationId, 'EMAIL')).id;
  });

  afterAll(disconnectDb);

  it('renders, sends, and marks the delivery SENT', async () => {
    await processor(job({ notificationId, deliveryId }));

    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0];
    expect(message.to).toBe(recipient.email);
    expect(message.subject).toBeTruthy();
    expect(message.html).toContain(recipient.name);

    const delivery = await notificationDeliveryRepository.findById(deliveryId);
    expect(delivery).toMatchObject({
      status: 'SENT',
      providerMessageId: 'prov-1',
      provider: 'test-provider',
      attempts: 1,
    });
    expect(delivery!.sentAt).not.toBeNull();
  });

  it('never re-sends after a successful send, however many times the job replays', async () => {
    await processor(job({ notificationId, deliveryId }));
    await processor(job({ notificationId, deliveryId }));
    await processor(job({ notificationId, deliveryId }));

    // The unique (notificationId, channel) index stops duplicate ENQUEUE, not
    // duplicate SEND. Without the SENT guard, a crash between send() and the
    // status write — or an expired job lock — would mail the user up to 5 times.
    expect(send).toHaveBeenCalledTimes(1);
    expect((await notificationDeliveryRepository.findById(deliveryId))!.attempts).toBe(1);
  });

  it('counts each genuine attempt, so retries stay visible', async () => {
    send.mockRejectedValueOnce(new Error('transient')).mockResolvedValue({
      providerMessageId: 'prov-2',
    });

    await expect(processor(job({ notificationId, deliveryId }))).rejects.toThrow();
    await processor(job({ notificationId, deliveryId }));

    expect((await notificationDeliveryRepository.findById(deliveryId))!.attempts).toBe(2);
  });

  describe('provider failure', () => {
    beforeEach(() => send.mockRejectedValue(new Error('provider exploded')));

    it('marks the delivery FAILED and records the reason', async () => {
      await expect(processor(job({ notificationId, deliveryId }))).rejects.toThrow(
        'provider exploded'
      );

      const delivery = await notificationDeliveryRepository.findById(deliveryId);
      expect(delivery).toMatchObject({ status: 'FAILED', error: 'provider exploded' });
      expect(delivery!.failedAt).not.toBeNull();
    });

    it('rethrows so BullMQ retries with backoff', async () => {
      // Swallowing here would silently drop the email — the rethrow IS the retry.
      await expect(processor(job({ notificationId, deliveryId }))).rejects.toThrow();
    });

    it('recovers to SENT on a later attempt, clearing the error', async () => {
      await expect(processor(job({ notificationId, deliveryId }))).rejects.toThrow();
      send.mockResolvedValue({ providerMessageId: 'prov-2' });

      await processor(job({ notificationId, deliveryId }));

      const delivery = await notificationDeliveryRepository.findById(deliveryId);
      expect(delivery).toMatchObject({ status: 'SENT', error: null, attempts: 2 });
    });
  });

  describe('non-retryable cases', () => {
    it('discards the job when the notification (and its delivery) were deleted', async () => {
      // Deleting the notification cascades the delivery away, leaving the queued
      // job pointing at nothing. It must resolve, not throw — throwing would burn
      // all five retries on work that can never succeed.
      await prisma.notification.delete({ where: { id: notificationId } });

      await expect(
        processor(job({ notificationId, deliveryId }))
      ).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    });

    it('skips a suspended recipient without sending', async () => {
      await prisma.user.update({
        where: { id: recipient.id },
        data: { status: 'SUSPENDED' },
      });

      await processor(job({ notificationId, deliveryId }));

      expect(send).not.toHaveBeenCalled();
      const delivery = await notificationDeliveryRepository.findById(deliveryId);
      expect(delivery).toMatchObject({ status: 'FAILED' });
      expect(delivery!.error).toContain('SUSPENDED');
    });
  });

  it('ignores jobs it does not own', async () => {
    await processor({ id: 'j2', name: 'some:other-job', data: {} });
    expect(send).not.toHaveBeenCalled();
  });
});
