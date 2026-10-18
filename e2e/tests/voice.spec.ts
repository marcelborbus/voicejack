import { expect, test } from '@playwright/test';
import { closeAll, createRoom, joinViaInvite, newPlayer, readyUp, type Player } from './helpers';

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

// #43: per-player mute + volume on the lobby cards, and the host's "mute for everyone".
test('lobby: mute a player for yourself, host mutes for everyone', async ({ browser }) => {
  const players: Player[] = [];
  try {
    for (const name of ['Hoss', 'Gil']) players.push(await newPlayer(browser, name));
    const [host, guest] = players as [Player, Player];
    const code = await createRoom(host);
    await joinViaInvite(guest, code);
    await readyUp(guest); // mic check: the guest now has an outgoing voice track
    for (const p of players) {
      await expect
        .poll(
          () =>
            p.page.evaluate(() =>
              ((window as PcWindow).__pcs ?? []).map((pc) => pc.connectionState),
            ),
          { timeout: 20_000 },
        )
        .toContain('connected');
    }
    const card = (p: Player, name: string) =>
      p.page.getByTestId('player-card').filter({ hasText: name });
    const hostAudioOfGuest = async () => {
      const id = await card(host, 'Gil').getAttribute('data-player-id');
      return host.page.evaluate((pid) => {
        const a = document.querySelector<HTMLAudioElement>(
          `[data-testid=voice-audio] audio[data-peer="${pid}"]`,
        );
        return a ? { muted: a.muted, volume: a.volume } : null;
      }, id);
    };
    const guestSending = () =>
      guest.page.evaluate(() =>
        ((window as PcWindow).__pcs ?? []).flatMap((pc) =>
          pc
            .getSenders()
            .filter((s) => s.track?.kind === 'audio')
            .map((s) => s.track!.enabled),
        ),
      );
    await expect.poll(guestSending).toEqual([true]);

    // Local mute: one visible button on the card; only the host's playback changes.
    const mute = card(host, 'Gil').getByTestId('voice-peer-mute');
    await expect(mute).toBeVisible();
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(hostAudioOfGuest).toMatchObject({ muted: true });
    await expect.poll(guestSending).toEqual([true]);
    await mute.click();
    await expect.poll(hostAudioOfGuest).toMatchObject({ muted: false });

    // Volume (only for the host).
    await card(host, 'Gil').getByTestId('voice-peer-menu').click();
    const dialog = host.page.getByTestId('voice-peer-dialog');
    const thumb = dialog.getByTestId('voice-peer-volume').getByRole('slider');
    await thumb.focus();
    await thumb.press('PageDown');
    await expect.poll(async () => (await hostAudioOfGuest())?.volume).toBeLessThan(1);

    // Host mute for everyone: the guest stops sending, everyone sees it.
    await dialog.getByTestId('host-mute').click();
    await expect(dialog.getByTestId('host-mute')).toHaveText(/Unmute for everyone/);
    await expect(guest.page.getByTestId('voice-host-muted')).toBeVisible();
    await expect.poll(guestSending).toEqual([false]);
    await expect.poll(hostAudioOfGuest).toMatchObject({ muted: true });
    for (const p of players)
      await expect(card(p, 'Gil').getByTestId('host-muted-badge')).toBeVisible();
    // The guest can't mute the host for everyone (no host controls for them).
    await card(guest, 'Hoss').getByTestId('voice-peer-menu').click();
    await expect(guest.page.getByTestId('voice-peer-dialog')).toBeVisible();
    await expect(guest.page.getByTestId('host-mute')).toHaveCount(0);
    await guest.page.keyboard.press('Escape');

    await dialog.getByTestId('host-mute').click();
    await expect(guest.page.getByTestId('voice-host-muted')).toBeHidden();
    await expect.poll(guestSending).toEqual([true]);
    await expect.poll(hostAudioOfGuest).toMatchObject({ muted: false });
    await expect(card(guest, 'Gil').getByTestId('host-muted-badge')).toHaveCount(0);
  } finally {
    await closeAll(players);
  }
});
