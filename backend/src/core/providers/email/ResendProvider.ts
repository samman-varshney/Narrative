import type { IEmailProvider, EmailMessage, EmailSendResult } from './IEmailProvider';

/**
 * Resend transport.
 *
 * Implemented against the REST API with `fetch` rather than the `resend` SDK, so
 * the project takes on no dependency for a single endpoint — and so this file
 * stays a straightforward reference for adding SendGrid/SES alongside it.
 *
 * Inactive until EMAIL_PROVIDER=resend and a verified sending domain exist.
 */
export class ResendProvider implements IEmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // Throwing (rather than returning a failure) is the contract: the worker
      // marks the delivery FAILED and BullMQ retries with backoff.
      const body = await response.text().catch(() => '<unreadable>');
      throw new Error(`Resend rejected the message (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { id?: string };
    return { providerMessageId: data.id ?? 'unknown' };
  }
}
