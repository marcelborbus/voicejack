import net from 'node:net';
import { randomBytes } from 'node:crypto';

/**
 * Minimal SMTP submission client (V04): plain SMTP, no AUTH, no TLS. It only talks to the
 * host-local Postfix null client (ARCHITECTURE §7), which accepts the docker bridge via
 * `mynetworks` and does TLS + auth on its goneo leg. Not a general-purpose mailer.
 */
export interface SmtpOptions {
  host: string;
  port: number;
  /** Whole-conversation timeout (default 15 s). */
  timeoutMs?: number;
  /** EHLO name (default `voicejack`). */
  heloName?: string;
}

export interface OutgoingMail {
  /** Header form, e.g. `Voicejack <noreply@borbus.eu>`. */
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Bare address of `Name <a@b>` (or the input itself). */
export function addressOf(header: string): string {
  const m = /<([^<>\s]+)>/.exec(header);
  return (m ? m[1]! : header).trim();
}

function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function b64(body: string): string {
  return (Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** RFC 5322 message (multipart/alternative, base64 parts), CRLF line endings. */
export function buildMessage(mail: OutgoingMail, now = new Date()): string {
  for (const v of [mail.from, mail.to, mail.subject]) {
    if (/[\r\n]/.test(v)) throw new Error('header value contains a line break');
  }
  const boundary = `vj-${randomBytes(12).toString('hex')}`;
  const domain = addressOf(mail.from).split('@')[1] ?? 'localhost';
  const lines = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(mail.html),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

/** Sends one mail; resolves once the server accepted it (250 after DATA). */
export function sendSmtp(opts: SmtpOptions, mail: OutgoingMail): Promise<void> {
  const data = buildMessage(mail)
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? '.' + l : l))
    .join('\r\n');
  const steps: { cmd: string | null; expect: number[] }[] = [
    { cmd: null, expect: [220] },
    { cmd: `EHLO ${opts.heloName ?? 'voicejack'}`, expect: [250] },
    { cmd: `MAIL FROM:<${addressOf(mail.from)}>`, expect: [250] },
    { cmd: `RCPT TO:<${addressOf(mail.to)}>`, expect: [250, 251] },
    { cmd: 'DATA', expect: [354] },
    { cmd: `${data}\r\n.`, expect: [250] },
  ];
  return new Promise<void>((resolve, reject) => {
    const sock = net.connect({ host: opts.host, port: opts.port });
    let buf = '';
    let step = 0;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        sock.destroy();
        reject(err);
      } else {
        sock.end('QUIT\r\n');
        resolve();
      }
    };
    const timer = setTimeout(
      () => finish(new Error('smtp: timeout')),
      opts.timeoutMs ?? 15_000,
    );
    sock.setEncoding('utf8');
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('smtp: connection closed early')));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      // A reply is complete at a line "NNN text" (multi-line replies use "NNN-text").
      while (!done) {
        const lines = buf.split('\r\n');
        const endIdx = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
        if (endIdx < 0 || endIdx === lines.length - 1) return;
        const reply = lines.slice(0, endIdx + 1);
        buf = lines.slice(endIdx + 1).join('\r\n');
        const code = Number(reply[endIdx]!.slice(0, 3));
        const cur = steps[step]!;
        if (!cur.expect.includes(code)) {
          finish(new Error(`smtp: unexpected reply ${reply.join(' | ')}`));
          return;
        }
        step++;
        if (step >= steps.length) {
          finish();
          return;
        }
        sock.write(steps[step]!.cmd + '\r\n');
      }
    });
  });
}
