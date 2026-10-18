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

// GET /api/legal
export type LegalResponse = { configured: true; legal: LegalInfo } | { configured: false };
