import type { AnalyticsEvent, IngestionResult } from '../analytics.types';

/**
 * The boundary between "something happened" and "analytics stored it".
 *
 * This interface is the module's most important seam. Everything upstream of it
 * — the domain-event subscribers, the reading-telemetry endpoint — knows only
 * that it can hand over an `AnalyticsEvent`. Everything downstream of it — Redis
 * buffers, HyperLogLogs, the BullMQ flush, the daily tables — is an
 * implementation detail of one class.
 *
 * That is what makes the migration path in ANALYTICS_MODULE.md a replacement
 * rather than a rewrite: pointing ingestion at Kafka, ClickHouse or a managed
 * analytics pipeline means writing a new implementation of these two methods.
 * No domain module changes, because no domain module has ever known what happens
 * after `recordEvent` returns.
 *
 * ── Contract ────────────────────────────────────────────────────────────────
 * Implementations MUST:
 *   - be idempotent per `eventId` — the same event may be delivered many times
 *   - never throw for a rejected event; report it in the `IngestionResult`
 *   - never perform work whose latency the user's request can observe
 *
 * Implementations MAY throw for genuine infrastructure failure, so the caller's
 * job can retry with the queue's backoff.
 */
export interface IAnalyticsIngestionService {
  /** Records one event. Returns why it was rejected, if it was. */
  recordEvent(event: AnalyticsEvent): Promise<IngestionResult>;

  /**
   * Records many events.
   *
   * Present so a future high-throughput producer (a batching client SDK, a
   * replay from a log) is not forced through N single-event round trips. The
   * per-event contract above still holds for each element.
   */
  recordBatch(events: AnalyticsEvent[]): Promise<IngestionResult[]>;
}
