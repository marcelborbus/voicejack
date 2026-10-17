/**
 * Results share card (docs/design-v1.1.md §7.4): a 1080×1350 PNG drawn on a canvas in the
 * browser. No server round-trip. Shared via the Web Share API with files where supported,
 * otherwise downloaded.
 */
import { avatarDataUrl } from '@/lib/avatar';
import { resultsCaption } from '@/lib/share';

export interface ShareStanding {
  name: string;
  total: number;
  winner: boolean;
}

const W = 1080;
const H = 1350;
const INK = '#0d0818';
const CARD = '#170f28';
const DISPLAY = "'Bricolage Grotesque Variable', 'Inter Variable', sans-serif";
const BODY = "'Inter Variable', sans-serif";
const SCRIBBLE = "'Caveat Variable', cursive";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function brandGradient(c: CanvasRenderingContext2D, x0: number, x1: number) {
  const g = c.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, '#d946ef');
  g.addColorStop(0.5, '#ec4899');
  g.addColorStop(1, '#f97316');
  return g;
}

/** Sticker: hard offset shadow + rim, then fill. */
function sticker(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string | CanvasGradient,
) {
  c.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(c, x, y + 10, w, h, r);
  c.fill();
  c.fillStyle = fill;
  roundRect(c, x, y, w, h, r);
  c.fill();
  c.lineWidth = 5;
  c.strokeStyle = '#1a1027';
  c.stroke();
}

async function drawMug(
  c: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  size: number,
) {
  const img = await loadImage(avatarDataUrl(name));
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(c, x, y + size * 0.05, size, size, size * 0.3);
  c.fill();
  roundRect(c, x, y, size, size, size * 0.3);
  c.clip();
  c.drawImage(img, x, y, size, size);
  c.restore();
  c.lineWidth = Math.max(3, size * 0.035);
  c.strokeStyle = '#1a1027';
  roundRect(c, x, y, size, size, size * 0.3);
  c.stroke();
}

function fitText(c: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (c.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function crown(c: CanvasRenderingContext2D, cx: number, y: number, w: number) {
  const h = w * 0.62;
  c.save();
  c.translate(cx, y);
  c.rotate(-0.12);
  c.beginPath();
  c.moveTo(-w / 2, h);
  c.lineTo(-w / 2, h * 0.25);
  c.lineTo(-w / 4, h * 0.6);
  c.lineTo(0, 0);
  c.lineTo(w / 4, h * 0.6);
  c.lineTo(w / 2, h * 0.25);
  c.lineTo(w / 2, h);
  c.closePath();
  c.fillStyle = '#ffd23f';
  c.fill();
  c.lineWidth = 6;
  c.lineJoin = 'round';
  c.strokeStyle = '#1a1027';
  c.stroke();
  c.restore();
}

function sparkle(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.moveTo(0, -r);
  c.quadraticCurveTo(r * 0.12, -r * 0.12, r, 0);
  c.quadraticCurveTo(r * 0.12, r * 0.12, 0, r);
  c.quadraticCurveTo(-r * 0.12, r * 0.12, -r, 0);
  c.quadraticCurveTo(-r * 0.12, -r * 0.12, 0, -r);
  c.lineWidth = 5;
  c.strokeStyle = color;
  c.lineJoin = 'round';
  c.stroke();
  c.restore();
}

export async function renderShareCard(opts: {
  standings: ShareStanding[];
  rounds: number;
}): Promise<Blob> {
  await Promise.all([
    document.fonts.load(`800 100px ${DISPLAY}`),
    document.fonts.load(`600 40px ${BODY}`),
    document.fonts.load(`700 50px ${SCRIBBLE}`),
  ]).catch(() => {});
  await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d')!;

  // background + glows
  c.fillStyle = INK;
  c.fillRect(0, 0, W, H);
  for (const [x, y, r, col] of [
    [120, 80, 520, 'rgba(192,38,211,0.35)'],
    [1000, 560, 480, 'rgba(249,115,22,0.22)'],
    [300, 1300, 520, 'rgba(124,58,237,0.3)'],
  ] as const) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }
  sparkle(c, 930, 210, 34, '#ffd23f');
  sparkle(c, 140, 520, 22, '#2de2e6');
  sparkle(c, 960, 560, 18, '#ff5fa2');

  // logo
  c.save();
  c.translate(84, 70);
  c.rotate(-0.1);
  sticker(c, 0, 0, 84, 84, 24, brandGradient(c, 0, 84));
  c.fillStyle = '#fff';
  roundRect(c, 30, 14, 24, 36, 12);
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = '#fff';
  c.lineCap = 'round';
  c.beginPath();
  c.arc(42, 38, 22, 0.15 * Math.PI, 0.85 * Math.PI);
  c.stroke();
  c.restore();
  c.font = `800 60px ${DISPLAY}`;
  c.textBaseline = 'middle';
  c.fillStyle = '#fafafa';
  c.fillText('Voice', 194, 112);
  const vw = c.measureText('Voice').width;
  c.fillStyle = brandGradient(c, 194 + vw, 194 + vw + 120);
  c.fillText('jack', 194 + vw, 112);

  const winners = opts.standings.filter((s) => s.winner);
  const top = winners[0] ?? opts.standings[0];

  // tape label
  c.save();
  c.translate(W / 2, 222);
  c.rotate(-0.03);
  c.font = `800 30px ${BODY}`;
  const label = (winners.length > 1 ? 'Shared victory' : 'And the winner is').toUpperCase();
  const lw = c.measureText(label).width + 48;
  c.fillStyle = '#ffd23f';
  c.fillRect(-lw / 2, -28, lw, 56);
  c.fillStyle = INK;
  c.textAlign = 'center';
  c.fillText(label, 0, 2);
  c.restore();

  // winner mug + crown
  if (top) {
    await drawMug(c, top.name, W / 2 - 130, 300, 260);
    crown(c, W / 2 + 104, 252, 100);
    c.textAlign = 'center';
    c.font = `800 104px ${DISPLAY}`;
    const name = fitText(c, winners.map((w) => w.name).join(' & ') || top.name, W - 140);
    c.fillStyle = brandGradient(
      c,
      W / 2 - c.measureText(name).width / 2,
      W / 2 + c.measureText(name).width / 2,
    );
    c.fillText(name, W / 2, 650);
  }
  c.font = `700 46px ${SCRIBBLE}`;
  c.fillStyle = '#d4d4d8';
  c.textAlign = 'center';
  c.fillText(
    `stole the scene after ${opts.rounds} round${opts.rounds === 1 ? '' : 's'} of terrible voices`,
    W / 2,
    724,
  );

  // standings card
  const rows = opts.standings.slice(0, 5);
  const rowH = 74;
  const cardY = 780;
  const cardH = 40 + rows.length * rowH;
  sticker(c, 90, cardY, W - 180, cardH, 40, CARD);
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i]!;
    const y = cardY + 20 + i * rowH;
    c.textAlign = 'left';
    c.font = `800 40px ${DISPLAY}`;
    c.fillStyle = s.winner ? '#ffd23f' : '#8a8a93';
    c.fillText(String(i + 1), 134, y + rowH / 2);
    await drawMug(c, s.name, 186, y + 9, 58);
    c.font = `600 38px ${BODY}`;
    c.fillStyle = '#fafafa';
    c.fillText(fitText(c, s.name, 560), 268, y + rowH / 2);
    c.textAlign = 'right';
    c.font = `800 44px ${DISPLAY}`;
    c.fillText(String(s.total), W - 134, y + rowH / 2);
  }

  // footer
  c.textAlign = 'center';
  c.font = `700 44px ${SCRIBBLE}`;
  c.fillStyle = '#2de2e6';
  c.fillText('think you can do worse?', W / 2, H - 100);
  c.font = `700 38px ${BODY}`;
  c.fillStyle = '#fafafa';
  c.fillText('voicejack.borbus.eu', W / 2, H - 50);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

/** Renders the card and shares it (files) or downloads it. Returns what happened. */
export async function shareResults(opts: {
  standings: ShareStanding[];
  rounds: number;
}): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = await renderShareCard(opts);
  const file = new File([blob], 'voicejack-results.png', { type: 'image/png' });
  const winner = opts.standings.find((s) => s.winner)?.name ?? opts.standings[0]?.name ?? '';
  const text = resultsCaption(winner);
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text, title: 'Voicejack results' });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'voicejack-results.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
