import fs from 'node:fs';
import { LegalInfoSchema, type LegalInfo } from '@dub/shared';

export type LegalLoad = { ok: true; legal: LegalInfo } | { ok: false; reason: string };

/**
 * Reads the operator's Impressum details (V12). Read on every request (tiny file), so the owner
 * can fix a typo on the host without a restart.
 */
export async function readLegal(file: string): Promise<LegalLoad> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? `${file} does not exist` : `${file}: ${code}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `${file} is not valid JSON: ${(e as Error).message}` };
  }
  const r = LegalInfoSchema.safeParse(json);
  if (!r.success) {
    const fields = r.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    return { ok: false, reason: `${file} is invalid (${fields})` };
  }
  return { ok: true, legal: r.data };
}
