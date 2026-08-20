-- Moderation & Administration: the database objects Prisma's schema language
-- cannot express.
--
-- `prisma db push` silently ignores everything in this directory, so every
-- environment must run `npm run db:indexes` — or production enforces different
-- invariants than dev, which is exactly the drift that turns an integrity rule
-- into a bug report. Every statement is idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- Duplicate report suppression
-- ---------------------------------------------------------------------------
-- One OPEN report per (reporter, target). A plain unique constraint over those
-- three columns would be wrong in a way that only shows up months later: it
-- would forbid re-reporting a user who resumed the same behaviour after an
-- earlier report was resolved or dismissed, permanently.
--
-- Partial on the open statuses instead, so:
--   * a second submission while the first is still open is refused (23505,
--     surfaced as 409 DUPLICATE_REPORT),
--   * a fresh report after the first is closed is allowed.
--
-- This is the AUTHORITATIVE duplicate guard. The Redis check in the service is
-- a cheap first line that spares the database a round trip under spam; it is
-- allowed to be wrong in both directions, and Postgres settles it.
--
-- AUTOMATED reports carry no reporter, so `reporterId IS NULL` rows are
-- excluded from the index and never collide — provider re-runs are deduplicated
-- by their own guard in the service, which is scoped per target rather than per
-- reporter.
CREATE UNIQUE INDEX IF NOT EXISTS report_open_unique_idx
  ON "Report" ("reporterId", "targetType", "targetId")
  WHERE "status" IN ('PENDING', 'REVIEWING') AND "reporterId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Moderation queue — the hot path
-- ---------------------------------------------------------------------------
-- The default queue view is "open reports, oldest first" (a work queue drains
-- FIFO). The composite Prisma index ("status", "createdAt", "id") serves it,
-- but it also carries every RESOLVED and DISMISSED row ever written — which is
-- the overwhelming majority of the table after a few months, and none of it is
-- ever read by the queue.
--
-- This partial index is the open subset only: a few hundred rows against a
-- table that grows without bound, so the queue's cost stays flat as history
-- accumulates.
CREATE INDEX IF NOT EXISTS report_open_queue_idx
  ON "Report" ("createdAt", "id")
  WHERE "status" IN ('PENDING', 'REVIEWING');

-- ---------------------------------------------------------------------------
-- Audit log integrity: append-only, enforced by the database
-- ---------------------------------------------------------------------------
-- "Audit records cannot be modified through normal APIs" is easy to satisfy by
-- writing no update method. That is a convention, and conventions are one
-- careless `prisma.moderationAction.update(...)` away from being untrue — with
-- no error, no log line, and a tampered audit trail that still looks pristine.
--
-- The trigger makes it a property of the table. Any UPDATE or DELETE raises,
-- from any client, including a psql session and including a future service that
-- forgot the rule. TRUNCATE deliberately still works: it does not fire row
-- triggers, and the test suite's `resetDb()` depends on it.
--
-- Retention (dropping rows older than N years) is a deliberate, privileged
-- operation: disable the trigger, delete, re-enable. That it takes a conscious
-- act is the point.
CREATE OR REPLACE FUNCTION moderation_action_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ModerationAction is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS moderation_action_no_update ON "ModerationAction";
CREATE TRIGGER moderation_action_no_update
  BEFORE UPDATE ON "ModerationAction"
  FOR EACH ROW EXECUTE FUNCTION moderation_action_append_only();

DROP TRIGGER IF EXISTS moderation_action_no_delete ON "ModerationAction";
CREATE TRIGGER moderation_action_no_delete
  BEFORE DELETE ON "ModerationAction"
  FOR EACH ROW EXECUTE FUNCTION moderation_action_append_only();
