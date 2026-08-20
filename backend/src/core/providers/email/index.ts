import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { IEmailProvider } from './IEmailProvider';
import { LogEmailProvider } from './LogEmailProvider';
import { ResendProvider } from './ResendProvider';

/**
 * Selects the transport from config. Mirrors the storage provider's factory
 * shape, so adding SendGrid/SES means one more case here and nothing else.
 */
function createEmailProvider(): IEmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'resend':
      // Env validation guarantees the key exists when this branch is reachable.
      return new ResendProvider(env.RESEND_API_KEY!, env.EMAIL_FROM);
    case 'log':
    default:
      return new LogEmailProvider();
  }
}

export const emailProvider = createEmailProvider();

logger.info({ provider: emailProvider.name }, 'Email provider initialised');

export type { IEmailProvider, EmailMessage, EmailSendResult } from './IEmailProvider';
export { LogEmailProvider } from './LogEmailProvider';
export { ResendProvider } from './ResendProvider';
