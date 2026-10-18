import { z } from 'zod';

// V12 legal pages. The Impressum details (§5 DDG, §18 MStV) are personal data of the operator,
// so they are not in the repo: the server reads them from `LEGAL_PATH` (prod
// `/app/data/legal.json`, example in `deploy/legal.example.json`) and serves them here.

export const LEGAL_ROUTE = '/api/legal';

const text = (max: number) => z.string().trim().min(1).max(max);

export const LegalInfoSchema = z.object({
  /** Full name of the operator (natural person). */
  name: text(200),
  /** Postal address ("ladungsfähige Anschrift"), one line per `\n`. No P.O. box. */
  address: text(500),
  /** Contact email; also the address for legal notices / takedown requests. */
  email: z.string().trim().max(200).pipe(z.email()),
  phone: text(50).optional(),
  /** §18 Abs. 2 MStV: "Verantwortlich für den Inhalt", name + address, one line per `\n`. */
  responsibleForContent: text(500).optional(),
  /** USt-IdNr. (§27a UStG), only if one exists. */
  vatId: text(50).optional(),
});
export type LegalInfo = z.infer<typeof LegalInfoSchema>;

/**
 * What `GET /api/legal` sends (V13, anti-scraping): the email split into its two parts, so the
 * JSON holds no plain address; the client joins them for display (no `mailto:` link).
 */
export type LegalPublic = Omit<LegalInfo, 'email'> & { emailUser: string; emailDomain: string };

export function toLegalPublic({ email, ...rest }: LegalInfo): LegalPublic {
  const at = email.lastIndexOf('@');
  return { ...rest, emailUser: email.slice(0, at), emailDomain: email.slice(at + 1) };
}

/** Joins the parts back together, client-side only. */
export function legalEmail(l: Pick<LegalPublic, 'emailUser' | 'emailDomain'>): string {
  return [l.emailUser, l.emailDomain].join(String.fromCharCode(64));
}

// GET /api/legal
export type LegalResponse = { configured: true; legal: LegalPublic } | { configured: false };
