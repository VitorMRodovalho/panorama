import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { EmailConfigService } from './email.config.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Optional message-level headers, e.g. `List-Unsubscribe`. */
  headers?: Record<string, string>;
}

/**
 * Recipient address shape gate (#80 / SUPPLY-02).
 *
 * Defends against malicious group-list shapes (`g0: g1: ... gN:`)
 * that historically crashed nodemailer's address parser via
 * unbounded recursion (CVE-2025-14874). Even after the upstream
 * fix, the gate is a cheap belt-and-suspenders — colon and
 * semicolon are not legal in the local-part or domain of any
 * normal email anyway.
 */
const SAFE_RECIPIENT = /^[^:;]+@[^:;]+$/;

/**
 * Minimal transactional email wrapper over nodemailer. In dev the SMTP
 * target is MailHog (`localhost:1025`); in prod swap envs to SES / a
 * provider with DKIM configured. Retries and bounce handling belong
 * to the caller (invitation email worker) — this service just sends.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly log = new Logger('EmailService');
  private _transporter: Transporter | null = null;

  constructor(private readonly cfg: EmailConfigService) {}

  async send(input: SendEmailInput): Promise<{ messageId: string }> {
    if (!SAFE_RECIPIENT.test(input.to)) {
      throw new Error(`email_recipient_rejected: malformed shape`);
    }
    const transporter = this.transporter();
    const info = await transporter.sendMail({
      from: `"${this.cfg.config.fromName}" <${this.cfg.config.fromAddress}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      headers: input.headers,
    });
    this.log.debug({ to: input.to, messageId: info.messageId }, 'email_sent');
    return { messageId: String(info.messageId ?? '') };
  }

  private transporter(): Transporter {
    if (this._transporter) return this._transporter;
    const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword } = this.cfg.config;
    const auth = smtpUser && smtpPassword ? { user: smtpUser, pass: smtpPassword } : undefined;
    this._transporter = createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth,
    });
    return this._transporter;
  }

  async onModuleDestroy(): Promise<void> {
    this._transporter?.close();
    this._transporter = null;
  }
}
