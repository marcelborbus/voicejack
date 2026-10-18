import type { MeUser } from '@dub/shared';

/**
 * Which name the name fields start with (#41):
 * - a registered account's name is the default (it changes only via the account menu);
 * - a guest gets the name they used last (`dub.name` in this browser, else the profile's,
 *   which the server keeps as the guest's last room name).
 */
export function defaultPlayerName(user: MeUser | null, saved: string): string {
  if (user?.kind === 'registered' && user.displayName) return user.displayName;
  return saved || user?.displayName || '';
}

export interface NameField {
  value: string;
  /** The user typed or rolled the dice: the prefill must not touch the field any more. */
  edited: boolean;
}

/** The field after the profile (re)loads: only an untouched field follows the default. */
export function prefillName(field: NameField, user: MeUser | null, saved: string): NameField {
  if (field.edited) return field;
  const value = defaultPlayerName(user, saved);
  return value === field.value ? field : { value, edited: false };
}

/**
 * The account name a registered user plays under when the field holds a different name for
 * this room only (shown as a hint), else null.
 */
export function roomOnlyNameOf(user: MeUser | null, name: string): string | null {
  const account = user?.kind === 'registered' ? user.displayName : null;
  const n = name.trim();
  return account && n && n !== account ? account : null;
}
