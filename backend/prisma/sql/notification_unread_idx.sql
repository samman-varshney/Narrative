-- Partial index for the unread badge count.
--
-- `SELECT count(*) WHERE recipientId = $1 AND isRead = false` is one of the
-- hottest queries in the app (every page load). A plain composite index still
-- has to walk every row for that recipient, so an account with 100k read
-- notifications pays for all of them to count a handful of unread ones.
--
-- A partial index stores ONLY unread rows, so the count touches just those and
-- shrinks back down as the user reads. Prisma's schema language cannot express
-- a WHERE clause on an index, hence raw SQL.
--
-- Idempotent: safe to re-run. Applied by `npm run db:indexes`.
CREATE INDEX IF NOT EXISTS notification_unread_idx
  ON "Notification" ("recipientId")
  WHERE "isRead" = false;
