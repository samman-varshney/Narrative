import { logger } from '../../utils/logger';
import type { IEmailProvider, EmailMessage, EmailSendResult } from './IEmailProvider';

let counter = 0;

/**
 * Development provider: renders the message and logs it instead of sending.
 *
 * This is the default so the entire notification pipeline — orchestrator,
 * channel, queue, worker, templates, delivery tracking — is exercisable without
 * a vendor account or a verified sending domain. It is also what keeps tests
 * from making network calls.
 *
 * Never selected in production: env validation requires a real provider there.
 */
export class LogEmailProvider implements IEmailProvider {
  readonly name = 'log';

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const providerMessageId = `log-${++counter}`;

    logger.info(
      {
        providerMessageId,
        to: message.to,
        subject: message.subject,
        // The text part only: HTML would bury the log line, and this exists to
        // be read by a human checking that copy renders correctly.
        body: message.text,
      },
      '[LogEmailProvider] email not sent (development transport)'
    );

    return { providerMessageId };
  }
}
