import { describe, expect, it } from 'vitest';
import {
  pickRenderMime,
  RENDER_MIMES,
  renderExtension,
  renderFileName,
  renderSize,
} from '../src/render/renderDub';

describe('pickRenderMime', () => {
  it('prefers vp9 webm when supported', () => {
    expect(pickRenderMime(() => true)).toBe('video/webm;codecs=vp9,opus');
  });
  it('falls back to vp8 when vp9 is missing', () => {
    expect(pickRenderMime((m) => !m.includes('vp9'))).toBe('video/webm;codecs=vp8,opus');
  });
  it('falls back to mp4 on Safari-like browsers', () => {
    expect(pickRenderMime((m) => m.startsWith('video/mp4'))).toBe(
      'video/mp4;codecs=avc1,mp4a.40.2',
    );
  });
  it('returns null when nothing is supported or the check throws', () => {
    expect(pickRenderMime(() => false)).toBeNull();
    expect(
      pickRenderMime(() => {
        throw new Error('nope');
      }),
    ).toBeNull();
  });
  it('asks in preference order and stops at the first hit', () => {
    const asked: string[] = [];
    pickRenderMime((m) => {
      asked.push(m);
      return m === 'video/webm';
    });
    expect(asked).toEqual(RENDER_MIMES.slice(0, 3));
  });
});

describe('render file naming', () => {
  it('maps mime to extension', () => {
    expect(renderExtension('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(renderExtension('video/mp4')).toBe('mp4');
  });
  it('builds a safe file name', () => {
    expect(renderFileName('tos-breakup', 'Zoë the Great!', 'video/webm')).toBe(
      'voicejack-tos-breakup-zoe-the-great.webm',
    );
    expect(renderFileName('x', '🙂🙂', 'video/mp4')).toBe('voicejack-x-dub.mp4');
  });
});

describe('renderSize', () => {
  it('keeps small clips and caps big ones to 1280x720 with even sides', () => {
    expect(renderSize(854, 356)).toEqual({ width: 854, height: 356 });
    expect(renderSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(renderSize(1280, 534)).toEqual({ width: 1280, height: 534 });
    expect(renderSize(641, 361)).toEqual({ width: 642, height: 362 });
  });
});
