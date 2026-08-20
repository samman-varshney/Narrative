/**
 * Email transport abstraction.
 *
 * The application must never be coupled to one vendor: providers get
 * rate-limited, lose domain reputation, or get swapped for cost. Everything
 * upstream depends on this interface, so switching is a config change.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  /** Vendor-side id, persisted on NotificationDelivery for support/tracing. */
  providerMessageId: string;
}

export interface IEmailProvider {
  readonly name: string;
  /**
   * Sends a message. MUST throw on failure — the worker relies on a thrown
   * error to mark the delivery FAILED and let BullMQ retry with backoff. A
   * provider that swallows errors would silently drop mail.
   */
  send(message: EmailMessage): Promise<EmailSendResult>;
}
