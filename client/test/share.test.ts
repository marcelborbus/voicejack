import { describe, expect, it } from 'vitest';
import { inviteMessage, inviteUrl, resultsCaption } from '@/lib/share';

describe('share copy', () => {
  it('builds the invite url and message', () => {
    const url = inviteUrl('ABC123', 'https://voicejack.borbus.eu');
    expect(url).toBe('https://voicejack.borbus.eu/r/ABC123');
    const msg = inviteMessage(' Alice ', url);
    expect(msg).toContain('Alice hijacked');
    expect(msg.endsWith(url)).toBe(true);
    expect(inviteMessage(undefined, url)).toContain('Someone');
  });
  it('captions results with the winner', () => {
    expect(resultsCaption('Bob')).toContain('Bob stole the scene');
  });
});
