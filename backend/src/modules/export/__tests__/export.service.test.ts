import { exportService } from '../export.service';
import { exportRepository } from '../export.repository';
import { exportBuilder } from '../export.builder';
import { exportQueue } from '../../../core/providers/queue';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { EXPORT_COOLDOWN_HOURS, EXPORT_MAX_BYTES } from '../export.config';

jest.mock('../export.repository');
jest.mock('../export.builder');
jest.mock('../../../core/providers/queue', () => ({
  exportQueue: { add: jest.fn() },
  QUEUES: { DATA_EXPORT: 'data_export' },
  createWorker: jest.fn(),
}));
jest.mock('../../../core/events/eventBus');

const HOUR = 60 * 60 * 1000;

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'exp-1',
  userId: 'u1',
  status: 'PENDING',
  sizeBytes: null,
  checksum: null,
  error: null,
  requestedAt: new Date(),
  startedAt: null,
  completedAt: null,
  expiresAt: null,
  downloadCount: 0,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  (exportRepository.countInFlight as jest.Mock).mockResolvedValue(0);
  (exportRepository.findLatestForUser as jest.Mock).mockResolvedValue(null);
  (exportRepository.create as jest.Mock).mockResolvedValue(row());
  (exportQueue.add as jest.Mock).mockResolvedValue({ id: 'job-1' });
  // The automock returns undefined; the service treats this as a promise it can
  // attach a `.catch` to, which is what it is in production.
  (exportRepository.incrementDownloadCount as jest.Mock).mockResolvedValue(undefined);
});

describe('request', () => {
  it('creates a row and queues the build', async () => {
    const result = await exportService.request('u1');

    expect(exportRepository.create).toHaveBeenCalledWith('u1');
    expect(exportQueue.add).toHaveBeenCalledWith('build-export', {
      exportId: 'exp-1',
      userId: 'u1',
    });
    expect(result.status).toBe('PENDING');
    expect(result.downloadable).toBe(false);
  });

  it('refuses while another build is in flight, before touching the cooldown', async () => {
    (exportRepository.countInFlight as jest.Mock).mockResolvedValue(1);

    await expect(exportService.request('u1')).rejects.toThrow(
      'An export is already being prepared'
    );
    expect(exportRepository.create).not.toHaveBeenCalled();
  });

  it('refuses inside the cooldown window', async () => {
    (exportRepository.findLatestForUser as jest.Mock).mockResolvedValue(
      row({ status: 'READY', requestedAt: new Date(Date.now() - 1 * HOUR) })
    );

    await expect(exportService.request('u1')).rejects.toThrow(
      'You can request another export after'
    );
    expect(exportQueue.add).not.toHaveBeenCalled();
  });

  it('allows a new request once the cooldown has elapsed', async () => {
    (exportRepository.findLatestForUser as jest.Mock).mockResolvedValue(
      row({
        status: 'READY',
        requestedAt: new Date(Date.now() - (EXPORT_COOLDOWN_HOURS + 1) * HOUR),
      })
    );

    await expect(exportService.request('u1')).resolves.toMatchObject({ id: 'exp-1' });
  });

  /**
   * The cooldown anchors on the last request of ANY status. A failing export is
   * the expensive case — it fails at the END of a full build — so letting a user
   * retry it in a loop is worse than making them wait.
   */
  it('counts a FAILED request against the cooldown', async () => {
    (exportRepository.findLatestForUser as jest.Mock).mockResolvedValue(
      row({ status: 'FAILED', requestedAt: new Date(Date.now() - 1 * HOUR) })
    );

    await expect(exportService.request('u1')).rejects.toMatchObject({
      errorCode: 'EXPORT_COOLDOWN',
    });
  });

  /**
   * A failed enqueue must not leave a PENDING row: it would block every future
   * request via the in-flight check while nothing was ever going to build it.
   */
  it('marks the row FAILED when the queue rejects the job', async () => {
    (exportQueue.add as jest.Mock).mockRejectedValue(new Error('redis down'));

    await expect(exportService.request('u1')).rejects.toThrow('Could not queue the export');
    expect(exportRepository.transition).toHaveBeenCalledWith(
      'exp-1',
      ['PENDING'],
      'FAILED',
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe('getById', () => {
  it("reports 404 for another user's export rather than 403", async () => {
    (exportRepository.findById as jest.Mock).mockResolvedValue(row({ userId: 'someone-else' }));

    // A distinguishable 403 would confirm the id exists — an enumeration oracle
    // over other people's requests.
    await expect(exportService.getById('exp-1', 'u1')).rejects.toThrow('Export not found');
  });
});

describe('download', () => {
  const ready = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'exp-1',
    userId: 'u1',
    status: 'READY',
    expiresAt: new Date(Date.now() + HOUR),
    checksum: 'abc',
    sizeBytes: 10,
    artifact: Buffer.from('gzipped'),
    ...over,
  });

  it('returns the artifact for its owner', async () => {
    (exportRepository.findArtifact as jest.Mock).mockResolvedValue(ready());

    const result = await exportService.download('exp-1', 'u1');

    expect(result.artifact.toString()).toBe('gzipped');
    expect(result.filename).toBe('narrative-export-exp-1.json.gz');
    expect(exportRepository.incrementDownloadCount).toHaveBeenCalledWith('exp-1');
  });

  it('refuses a stranger', async () => {
    (exportRepository.findArtifact as jest.Mock).mockResolvedValue(
      ready({ userId: 'someone-else' })
    );

    await expect(exportService.download('exp-1', 'u1')).rejects.toThrow('Export not found');
  });

  /**
   * The sweep runs hourly, so there is a window in which a lapsed artifact still
   * has status READY. Trusting the status alone would serve it for that whole
   * window — the expiry has to be checked against the clock.
   */
  it('refuses an artifact past its expiry even while the row still says READY', async () => {
    (exportRepository.findArtifact as jest.Mock).mockResolvedValue(
      ready({ expiresAt: new Date(Date.now() - 1000) })
    );

    await expect(exportService.download('exp-1', 'u1')).rejects.toThrow('has expired');
  });

  it('refuses a build that is not finished', async () => {
    (exportRepository.findArtifact as jest.Mock).mockResolvedValue(
      ready({ status: 'PROCESSING', artifact: null })
    );

    await expect(exportService.download('exp-1', 'u1')).rejects.toThrow('not ready');
  });
});

describe('process', () => {
  const doc = { meta: { formatVersion: 1 }, blogs: [] };

  beforeEach(() => {
    (exportRepository.transition as jest.Mock).mockResolvedValue(true);
    (exportRepository.markReady as jest.Mock).mockResolvedValue(true);
    (exportBuilder.build as jest.Mock).mockResolvedValue(doc);
  });

  it('claims, builds, stores and announces', async () => {
    await exportService.process('exp-1', 'u1');

    expect(exportRepository.transition).toHaveBeenCalledWith(
      'exp-1',
      ['PENDING'],
      'PROCESSING',
      expect.objectContaining({ startedAt: expect.any(Date) })
    );
    expect(exportRepository.markReady).toHaveBeenCalledWith(
      'exp-1',
      expect.any(Buffer),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.any(Date)
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      EVENTS.DATA_EXPORT_READY,
      expect.objectContaining({ userId: 'u1', exportId: 'exp-1' })
    );
  });

  /**
   * BullMQ is at-least-once. A retry after a worker died must not run a second
   * build concurrently with the first and race it to the same row.
   */
  it('does nothing when the claim is lost to another worker', async () => {
    (exportRepository.transition as jest.Mock).mockResolvedValue(false);

    await exportService.process('exp-1', 'u1');

    expect(exportBuilder.build).not.toHaveBeenCalled();
    expect(exportRepository.markReady).not.toHaveBeenCalled();
  });

  /**
   * Over the cap it FAILS rather than truncating: a silently partial export of
   * your own data is worse than none, because you cannot tell what is missing.
   */
  it('fails rather than truncating an artifact over the cap', async () => {
    // Incompressible content, so the gzipped size genuinely exceeds the cap.
    const huge = { blob: require('crypto').randomBytes(EXPORT_MAX_BYTES).toString('base64') };
    (exportBuilder.build as jest.Mock).mockResolvedValue(huge);

    await exportService.process('exp-1', 'u1');

    expect(exportRepository.markReady).not.toHaveBeenCalled();
    expect(exportRepository.transition).toHaveBeenCalledWith(
      'exp-1',
      ['PROCESSING'],
      'FAILED',
      expect.objectContaining({ error: expect.stringContaining('too large') })
    );
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('records a user-facing failure and rethrows so BullMQ can retry', async () => {
    (exportBuilder.build as jest.Mock).mockRejectedValue(new Error('blog service down'));

    await expect(exportService.process('exp-1', 'u1')).rejects.toThrow('blog service down');

    expect(exportRepository.transition).toHaveBeenCalledWith(
      'exp-1',
      ['PROCESSING'],
      'FAILED',
      expect.objectContaining({ error: expect.not.stringContaining('blog service down') })
    );
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
