import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';

/**
 * Runs several moderation writes as one atomic unit.
 *
 * Lives at the repository layer (it is the only place in this module that
 * touches the Prisma client directly, alongside the two repositories) so
 * services keep talking to repositories rather than to the database.
 *
 * It exists for exactly one shape: a decision and its audit record. Claiming a
 * report writes the claim AND an audit row; resolving one writes the resolution
 * AND an audit row. Split across two statements, a crash in between leaves
 * either a decision nobody can account for or an audit record for a decision
 * that never happened — and an audit log with either property is not one.
 *
 * It is deliberately NOT used for actions that cross a module boundary. Hiding a
 * blog commits inside the Blog module before moderation writes its audit row;
 * wrapping that in a transaction here would mean passing a transaction client
 * through another module's service, which is exactly the coupling the modular
 * monolith exists to avoid. The residual gap — a crash between the two — is
 * documented in MODERATION_MODULE.md § Audit logging, along with why it is
 * survivable: the action's own event is durable, and the log's job is to record
 * intent, not to be the only trace.
 */
export function runModerationTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(fn);
}
