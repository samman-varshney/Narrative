import { Router } from 'express';
import {
  requireActiveAccount,
  requireAuth,
  requirePermission,
} from '../../core/middlewares/requireAuth';
import { adminLimiter, reportLimiter } from '../../core/middlewares/rateLimiter';
import { validateRequest } from '../../core/middlewares/validateRequest';
import { catchAsync } from '../../core/utils/asyncHandler';
import { moderationController } from './moderation.controller';
import {
  createReportSchema,
  moderationActionSchema,
  resolveReportSchema,
} from './moderation.validator';

/**
 * The Moderation module exposes TWO routers, because it serves two completely
 * different audiences and mixing them would be a security smell:
 *
 *   reportRoutes  mounted at `/api/v1/reports`. Authenticated USERS. One
 *                 endpoint: file a report.
 *   adminRoutes   mounted at `/api/v1/admin`. Moderators and administrators.
 *                 Everything else.
 *
 * ── Authorization ───────────────────────────────────────────────────────────
 * Every administrative route names the PERMISSION it needs, never a role. That
 * is what makes "add a support-administrator role" a change to the permission
 * catalogue rather than a sweep through this file — and what stops the two
 * levels of privilege from blurring: `content:delete`, `users:manage` and
 * `platform:settings:manage` are administrator-only, and the routes that need
 * them are visibly different here.
 *
 * `requireAuth` and `requirePermission` are applied PER ROUTE rather than with
 * `router.use()`. With a `use()`, a route added above it would be silently
 * public — on an ADMIN router — and the diff would look fine.
 *
 * The services repeat every one of these checks. Belt and braces on purpose:
 * this file is one careless edit away from being the only thing standing between
 * an anonymous request and a suspension endpoint, and it should not be.
 *
 * ── Staff accounts are checked too ──────────────────────────────────────────
 * Every administrative route carries `requireActiveAccount`, not just the
 * user-facing one. A moderator's own account can be suspended — that is the
 * whole point of an administrator being able to act on a rogue or compromised
 * staff account — and without this check their existing access token would keep
 * working for its full lifetime, which is exactly the window someone who just
 * lost their privileges would use. It costs one Redis GET on a surface that is
 * clicked rather than scrolled.
 */

/**
 * Auth + account standing + the administrative budget, before any permission is
 * even considered.
 *
 * `adminLimiter` rather than the global one: this surface is exempt from it (see
 * SELF_LIMITED_PATH_PREFIXES), because 100 requests per 15 minutes runs out
 * halfway through a spam wave — the exact moment moderation must not stop.
 */
const staffGuards = [requireAuth, requireActiveAccount, adminLimiter];

// --- User-facing: filing a report (mounted at /api/v1/reports) ---
const reportRouter = Router();

reportRouter.post(
  '/',
  requireAuth,
  // A suspended account may still read the platform; it may not act on it, and
  // filing reports is acting. Without this, suspension leaves an abuser a
  // working channel for retaliatory reports against the people who reported them.
  requireActiveAccount,
  reportLimiter,
  validateRequest(createReportSchema),
  catchAsync(moderationController.createReport)
);

export const reportRoutes = reportRouter;

// --- Administrative surface (mounted at /api/v1/admin) ---
const adminRouter = Router();

// Who am I, and what may I do. Behind auth but behind no permission: the answer
// for a regular user is an empty permission list, which is exactly what a client
// needs to know in order to not render an admin shell.
adminRouter.get('/me', staffGuards, catchAsync(moderationController.me));

// ---- Queue reads ----
adminRouter.get(
  '/moderation/overview',
  staffGuards,
  requirePermission(['reports:view']),
  catchAsync(moderationController.overview)
);
adminRouter.get(
  '/moderation/reports',
  staffGuards,
  requirePermission(['reports:view']),
  catchAsync(moderationController.listReports)
);
adminRouter.get(
  '/moderation/reports/:id',
  staffGuards,
  requirePermission(['reports:view']),
  catchAsync(moderationController.getReport)
);

// ---- Triage ----
adminRouter.post(
  '/moderation/reports/:id/claim',
  staffGuards,
  requirePermission(['reports:review']),
  catchAsync(moderationController.claimReport)
);
adminRouter.post(
  '/moderation/reports/:id/resolve',
  staffGuards,
  requirePermission(['reports:resolve']),
  validateRequest(resolveReportSchema),
  catchAsync(moderationController.resolveReport)
);
adminRouter.post(
  '/moderation/reports/:id/dismiss',
  staffGuards,
  requirePermission(['reports:resolve']),
  validateRequest(resolveReportSchema),
  catchAsync(moderationController.dismissReport)
);

// ---- Content actions ----
adminRouter.post(
  '/moderation/blogs/:id/hide',
  staffGuards,
  requirePermission(['content:hide']),
  validateRequest(moderationActionSchema),
  catchAsync(moderationController.hideBlog)
);
adminRouter.post(
  '/moderation/blogs/:id/restore',
  staffGuards,
  requirePermission(['content:restore']),
  validateRequest(moderationActionSchema),
  catchAsync(moderationController.restoreBlog)
);
// Removal is administrator-only: a hide is reversible by the next moderator who
// disagrees, a removal is not reversible by anyone.
adminRouter.post(
  '/moderation/blogs/:id/remove',
  staffGuards,
  requirePermission(['content:delete']),
  validateRequest(moderationActionSchema),
  catchAsync(moderationController.removeBlog)
);

adminRouter.post(
  '/moderation/comments/:id/hide',
  staffGuards,
  requirePermission(['content:hide']),
  validateRequest(moderationActionSchema),
  catchAsync(moderationController.hideComment)
);
adminRouter.post(
  '/moderation/comments/:id/restore',
  staffGuards,
  requirePermission(['content:restore']),
  validateRequest(moderationActionSchema),
  catchAsync(moderationController.restoreComment)
);
adminRouter.post(
  '/moderation/comments/:id/remove',
  staffGuards,
  requirePermission(['content:delete']),
  validateRequest(moderationActionSchema),
  catchAsync(moderationController.removeComment)
);

// ---- Account actions ----
adminRouter.post(
  '/moderation/users/:id/suspend',
  staffGuards,
  requirePermission(['users:suspend']),
  validateRequest(moderationActionSchema),
  catchAsync(moderationController.suspendUser)
);
adminRouter.post(
  '/moderation/users/:id/unsuspend',
  staffGuards,
  requirePermission(['users:unsuspend']),
  validateRequest(moderationActionSchema),
  catchAsync(moderationController.unsuspendUser)
);

// ---- Investigation ----
// Declared AFTER the two-segment `/moderation/users/:id/...` action routes.
// Express matches in declaration order and these are GETs against POST routes,
// so nothing could actually shadow anything — the ordering is kept anyway so the
// grouping reads the way every other router in this codebase does.
adminRouter.get(
  '/moderation/users/:id',
  staffGuards,
  requirePermission(['reports:view']),
  catchAsync(moderationController.userModeration)
);
adminRouter.get(
  '/moderation/content/:targetType/:targetId',
  staffGuards,
  requirePermission(['reports:view']),
  catchAsync(moderationController.contentModeration)
);
adminRouter.get(
  '/moderation/history',
  staffGuards,
  requirePermission(['moderation:history:view']),
  catchAsync(moderationController.history)
);

export const adminRoutes = adminRouter;
