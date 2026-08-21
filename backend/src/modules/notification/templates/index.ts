import { NotificationType } from '@prisma/client';
import { appBaseUrl, authorUrl, blogUrl } from '../../../core/utils/publicUrls';
import { env } from '../../../core/config/env';

/**
 * Email templates.
 *
 * Kept out of services deliberately: rendering in a service mixes copy with
 * business rules and makes both harder to change. Each template is a pure
 * function from a typed DTO to `{ subject, html, text }`, which also makes them
 * trivially testable and swappable for React Email later.
 */

export interface TemplateContext {
  recipientName: string;
  actorName: string | null;
  /** Render inputs carried on the notification (blogTitle, slug, ...). */
  metadata: Record<string, unknown>;
  entityId: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const appUrl = appBaseUrl;

/**
 * Every email carries a preferences link. Non-transactional mail legally
 * requires an opt-out path (CAN-SPAM), and pointing at the authenticated
 * settings page avoids minting unsubscribe tokens for V1.
 *
 * Extension point: a signed one-click unsubscribe token, which some providers
 * now require for bulk senders.
 */
const preferencesUrl = () => `${appUrl()}/settings/notifications`;

function layout(bodyHtml: string, bodyText: string): Pick<RenderedEmail, 'html' | 'text'> {
  const url = preferencesUrl();
  return {
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111">
${bodyHtml}
<hr style="margin:24px 0;border:none;border-top:1px solid #e5e5e5" />
<p style="font-size:12px;color:#666">
  You received this because of your notification settings.
  <a href="${url}">Manage preferences</a>.
</p>
</div>`,
    text: `${bodyText}\n\n---\nYou received this because of your notification settings.\nManage preferences: ${url}\n`,
  };
}

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.length > 0 ? v : fallback;

/**
 * Escapes text before it enters an HTML email body.
 *
 * Display names, blog titles and comment excerpts are user-controlled and are
 * NOT sanitized upstream (`user.validator.ts` bounds length only). Without this,
 * someone whose name is `<a href="https://evil/reset">Reset password</a>` gets
 * attacker-authored markup delivered in mail the platform vouches for — and
 * FOLLOW email is on by default, so it only takes a follow.
 */
const esc = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Public page links come from the platform's single URL vocabulary
 * (`core/utils/publicUrls`), which percent-encodes each segment itself. These
 * templates built `/blog/<slug>` and `/@<username>` by hand until the SEO module
 * needed the same answers for canonical tags — an email pointing somewhere other
 * than the canonical URL of the post it announces is a duplicate-content bug and
 * a confusing link at once.
 */

export function renderFollowEmail(ctx: TemplateContext): RenderedEmail {
  const actor = ctx.actorName ?? 'Someone';
  const profile = authorUrl(str(ctx.metadata.username, ''));
  return {
    subject: `${actor} started following you`,
    ...layout(
      `<p>Hi ${esc(ctx.recipientName)},</p><p><strong>${esc(actor)}</strong> started following you on Narrative.</p><p><a href="${profile}">View their profile</a></p>`,
      `Hi ${ctx.recipientName},\n\n${actor} started following you on Narrative.\n${profile}`
    ),
  };
}

export function renderCommentEmail(ctx: TemplateContext): RenderedEmail {
  const actor = ctx.actorName ?? 'Someone';
  const title = str(ctx.metadata.blogTitle, 'your post');
  const link = blogUrl(str(ctx.metadata.slug, ''));
  return {
    subject: `${actor} commented on ${title}`,
    ...layout(
      `<p>Hi ${esc(ctx.recipientName)},</p><p><strong>${esc(actor)}</strong> commented on <em>${esc(title)}</em>.</p><p><a href="${link}">Read the comment</a></p>`,
      `Hi ${ctx.recipientName},\n\n${actor} commented on "${title}".\n${link}`
    ),
  };
}

export function renderReplyEmail(ctx: TemplateContext): RenderedEmail {
  const actor = ctx.actorName ?? 'Someone';
  const link = blogUrl(str(ctx.metadata.slug, ''));
  return {
    subject: `${actor} replied to your comment`,
    ...layout(
      `<p>Hi ${esc(ctx.recipientName)},</p><p><strong>${esc(actor)}</strong> replied to your comment.</p><p><a href="${link}">View the reply</a></p>`,
      `Hi ${ctx.recipientName},\n\n${actor} replied to your comment.\n${link}`
    ),
  };
}

export function renderBlogPublishedEmail(ctx: TemplateContext): RenderedEmail {
  const actor = ctx.actorName ?? 'An author you follow';
  const title = str(ctx.metadata.blogTitle, 'a new post');
  const link = blogUrl(str(ctx.metadata.slug, ''));
  return {
    subject: `${actor} published ${title}`,
    ...layout(
      `<p>Hi ${esc(ctx.recipientName)},</p><p><strong>${esc(actor)}</strong> just published <em>${esc(title)}</em>.</p><p><a href="${link}">Read it now</a></p>`,
      `Hi ${ctx.recipientName},\n\n${actor} just published "${title}".\n${link}`
    ),
  };
}

export function renderSystemEmail(ctx: TemplateContext): RenderedEmail {
  const subject = str(ctx.metadata.subject, 'A notification from Narrative');
  const body = str(ctx.metadata.body, 'You have a new notification.');
  return {
    subject,
    ...layout(
      `<p>Hi ${esc(ctx.recipientName)},</p><p>${esc(body)}</p>`,
      `Hi ${ctx.recipientName},\n\n${body}`
    ),
  };
}

const RENDERERS: Record<NotificationType, (ctx: TemplateContext) => RenderedEmail> = {
  FOLLOW: renderFollowEmail,
  COMMENT: renderCommentEmail,
  REPLY: renderReplyEmail,
  BLOG: renderBlogPublishedEmail,
  SYSTEM: renderSystemEmail,
  MENTION: renderSystemEmail, // reserved — falls back until built
  LIKE: renderSystemEmail, // reserved — falls back until built
};

/**
 * Renders the email for a notification type. A lookup table rather than a switch,
 * so adding a type is a one-line registration and an unhandled type is a
 * compile error rather than a silent fallthrough.
 */
export function renderNotificationEmail(
  type: NotificationType,
  ctx: TemplateContext
): RenderedEmail {
  return RENDERERS[type](ctx);
}
