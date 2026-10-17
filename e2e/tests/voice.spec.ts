import { expect, test } from '@playwright/test';
import { closeAll, createRoom, joinViaInvite, newPlayer, type Player } from './helpers';

type PcWindow = Window & { __pcs?: RTCPeerConnection[] };

test('two players connect voice in the lobby', async ({ browser }) => {
  const players: Player[] = [];
  try {
    for (const name of ['Vee', 'Wes']) players.push(await newPlayer(browser, name));
    const [a, b] = players as [Player, Player];
    const code = await createRoom(a);
    await joinViaInvite(b, code);

    for (const p of players) {
      await expect(p.page.getByTestId('voice-dock')).toHaveAttribute('data-allowed', 'true');
      await expect
        .poll(
          () =>
            p.page.evaluate(() =>
              ((window as PcWindow).__pcs ?? []).map((pc) => pc.connectionState),
            ),
          { timeout: 20_000 },
        )
        .toContain('connected');
      // The remote stream lands in a live <audio> element.
      await expect
        .poll(() =>
          p.page.evaluate(() =>
            [...document.querySelectorAll('[data-testid=voice-audio] audio')].some((el) => {
              const s = (el as HTMLAudioElement).srcObject as MediaStream | null;
              return !!s && s.getAudioTracks().some((t) => t.readyState === 'live');
            }),
          ),
        )
        .toBe(true);
    }
  } finally {
    await closeAll(players);
  }
});
