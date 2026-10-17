/** Share/invite copy (docs/design-v1.1.md §7). First drafts: tweak freely. */

export function inviteUrl(code: string, origin: string = location.origin): string {
  return `${origin}/r/${code}`;
}

/** The message "Copy invite" puts on the clipboard (link included, so chat apps unfurl it). */
export function inviteMessage(hostName: string | undefined, url: string): string {
  const who = hostName?.trim() ? hostName.trim() : 'Someone';
  return `🎙️ ${who} hijacked a movie scene on Voicejack. Come do terrible voices with us → ${url}`;
}

/** Caption that goes along with the results share card. */
export function resultsCaption(winner: string, url = 'https://voicejack.borbus.eu'): string {
  return `🏆 ${winner} stole the scene on Voicejack. Think you can do worse? ${url}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for insecure contexts (plain http on a LAN IP).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function canNativeShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}
