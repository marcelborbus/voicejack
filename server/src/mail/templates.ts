/** V04 mail + page templates. Plain and small: no images, no remote assets, no tracking. */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function loginMail(link: string): { subject: string; text: string; html: string } {
  const subject = 'Your Voicejack sign-in link';
  const text = [
    'Hi!',
    '',
    'Use this link to sign in to Voicejack. It works once and expires in 15 minutes:',
    '',
    link,
    '',
    "If you didn't ask for it, ignore this mail; nothing happens without the click.",
    '',
    '-- Voicejack (https://voicejack.borbus.eu)',
    'This address does not take replies. Questions: m@borbus.eu',
  ].join('\n');
  const l = escapeHtml(link);
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f1fa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1530">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:28px">
<p style="margin:0 0 16px;font-size:22px;font-weight:800;color:#c026d3">Voicejack</p>
<p style="margin:0 0 20px;font-size:16px;line-height:1.5">Tap the button to sign in. The link works once and expires in 15&nbsp;minutes.</p>
<p style="margin:0 0 24px"><a href="${l}" style="display:inline-block;background:#c026d3;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:12px">Sign in to Voicejack</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#6b6380">Or paste this into your browser:<br><span style="word-break:break-all">${l}</span></p>
<p style="margin:16px 0 0;font-size:13px;color:#6b6380">Didn't ask for this? Ignore it; nothing happens without the click. Replies to this address go nowhere; questions to m@borbus.eu.</p>
</div></body></html>`;
  return { subject, text, html };
}

const PAGE_CSS = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#120d1f;color:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:420px;margin:16px;padding:32px;border-radius:24px;background:#1d1530;border:1.5px solid rgba(255,255,255,.12);box-shadow:0 6px 0 rgba(0,0,0,.45);text-align:center}
h1{margin:0 0 4px;font-size:26px;font-weight:800;color:#e879f9}p{color:#a1a1aa;line-height:1.5}
button,a.btn{display:inline-block;margin-top:12px;border:0;border-radius:16px;padding:14px 28px;font:inherit;font-weight:700;font-size:16px;color:#fff;background:linear-gradient(90deg,#c026d3,#7c3aed);cursor:pointer;text-decoration:none}
strong{color:#f4f4f5;word-break:break-all}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body><main><h1>Voicejack</h1>${body}</main></body></html>`;
}

/** GET /api/auth/verify: the click-to-confirm page (POST consumes the token). */
export function confirmPage(token: string, email: string, action: string): string {
  return page(
    'Sign in · Voicejack',
    `<p>Sign in as <strong>${escapeHtml(email)}</strong> on this device?</p>
<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit">Sign in</button></form>`,
  );
}

export function invalidLinkPage(): string {
  return page(
    'Link expired · Voicejack',
    `<p>This sign-in link has expired or was already used. Request a new one from the game.</p><a class="btn" href="/">Back to Voicejack</a>`,
  );
}
