import type { Config } from '../config.js';
import { sendSmtp, type OutgoingMail } from './smtp.js';

export type { OutgoingMail };

/** Sends transactional mail (V04 magic links). */
export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/** `MAIL_TRANSPORT=log`: nothing leaves the box; mails go to the log and `outbox` (tests). */
export class LogMailer implements Mailer {
  readonly outbox: OutgoingMail[] = [];
  constructor(private readonly log?: (msg: string) => void) {}
  send(mail: OutgoingMail): Promise<void> {
    this.outbox.push(mail);
    if (this.outbox.length > 100) this.outbox.shift();
    this.log?.(`mail (log transport) to ${mail.to}: ${mail.subject}\n${mail.text}`);
    return Promise.resolve();
  }
}

/** Plain SMTP to the host's Postfix relay (`SMTP_HOST:SMTP_PORT`). */
export class SmtpMailer implements Mailer {
  constructor(private readonly opts: { host: string; port: number }) {}
  send(mail: OutgoingMail): Promise<void> {
    return sendSmtp(this.opts, mail);
  }
}

export function createMailer(config: Config, log?: (msg: string) => void): Mailer {
  return config.mailTransport === 'smtp'
    ? new SmtpMailer({ host: config.smtpHost, port: config.smtpPort })
    : new LogMailer(log);
}
