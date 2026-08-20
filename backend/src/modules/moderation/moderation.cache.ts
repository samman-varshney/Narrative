import type { ReportTargetType } from '@prisma/client';
import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import {
  AUTOMATED_GUARD_TTL_SECONDS,
  DUPLICATE_GUARD_TTL_SECONDS,
} from './moderation.config';

/**
 * Redis for moderation — and only for the things Redis is allowed to be wrong
 * about.
 *
 * Nothing in this file is a source of truth. Reports, audit records, suspension
 * and every moderation decision live in PostgreSQL; what lives here is a
 * short-lived memo that lets the common case skip a database round trip. The
 * test for whether something belongs in this file is simple: if Redis were
 * flushed right now, would the platform lose a moderation fact? If yes, it does
 * not go here.
 *
 * Both guards therefore FAIL OPEN. A Redis outage means duplicate submissions
 * reach PostgreSQL, where the partial unique index refuses them properly — a
 * little more load, identical outcome. Failing closed would mean a Redis blip
 * silently stopping people from reporting abuse, which is the worse failure by
 * a wide margin.
 */

const CACHE_VERSION = 'v1';
const PREFIX = `moderation:${CACHE_VERSION}`;

const duplicateKey = (
  reporterId: string,
  targetType: ReportTargetType,
  targetId: string
): string => `${PREFIX}:dup:${reporterId}:${targetType}:${targetId}`;

const automatedKey = (targetType: ReportTargetType, targetId: string): string =>
  `${PREFIX}:auto:${targetType}:${targetId}`;

/**
 * Claims the right to file a report, atomically.
 *
 * `SET NX` rather than a GET followed by a SET: two submissions racing on the
 * same key would both read "absent" and both proceed, which is precisely the
 * burst this guard exists to absorb. Returns false when someone (or the same
 * someone, twice) already holds the slot.
 */
export async function claimReportSlot(
  reporterId: string,
  targetType: ReportTargetType,
  targetId: string
): Promise<boolean> {
  try {
    const result = await redis.set(
      duplicateKey(reporterId, targetType, targetId),
      '1',
      'EX',
      DUPLICATE_GUARD_TTL_SECONDS,
      'NX'
    );
    return result === 'OK';
  } catch (err) {
    logger.warn({ err, reporterId }, 'moderation: duplicate guard unavailable — allowing');
    return true;
  }
}

/**
 * Releases a claimed slot.
 *
 * Called when the report was NOT ultimately stored — a validation failure, an
 * unavailable target, a failed insert. Without it a rejected submission would
 * lock the reporter out of reporting that target for hours over a report that
 * does not exist.
 */
export async function releaseReportSlot(
  reporterId: string,
  targetType: ReportTargetType,
  targetId: string
): Promise<void> {
  try {
    await redis.del(duplicateKey(reporterId, targetType, targetId));
  } catch (err) {
    logger.warn({ err, reporterId }, 'moderation: failed to release duplicate guard');
  }
}

/**
 * Claims the right to run an AUTOMATED evaluation for a target.
 *
 * Automated reports have no reporter, so the partial unique index cannot cover
 * them. This keeps an edit-and-republish loop from filing a report per
 * republish; the open-automated-report check in the repository is the backstop
 * when this is cold.
 */
export async function claimAutomatedSlot(
  targetType: ReportTargetType,
  targetId: string
): Promise<boolean> {
  try {
    const result = await redis.set(
      automatedKey(targetType, targetId),
      '1',
      'EX',
      AUTOMATED_GUARD_TTL_SECONDS,
      'NX'
    );
    return result === 'OK';
  } catch (err) {
    logger.warn({ err, targetType, targetId }, 'moderation: automated guard unavailable — allowing');
    return true;
  }
}
