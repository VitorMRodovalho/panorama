import { Injectable } from '@nestjs/common';

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  fromAddress: string;
  fromName: string;
  /** `https://panorama.vitormr.dev` — used to build absolute URLs in emails. */
  baseUrl: string;
}

@Injectable()
export class EmailConfigService {
  readonly config: EmailConfig;

  constructor() {
    const config: EmailConfig = {
      smtpHost: process.env.SMTP_HOST ?? 'localhost',
      smtpPort: Number(process.env.SMTP_PORT ?? 1025), // MailHog default
      smtpSecure: process.env.SMTP_SECURE === 'true',
      fromAddress: process.env.MAIL_FROM ?? 'panorama@localhost',
      fromName: process.env.MAIL_FROM_NAME ?? 'Panorama',
      baseUrl: (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    };
    if (process.env.SMTP_USER) config.smtpUser = process.env.SMTP_USER;
    if (process.env.SMTP_PASSWORD) config.smtpPassword = process.env.SMTP_PASSWORD;
    this.config = config;
  }
}
