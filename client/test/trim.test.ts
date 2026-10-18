import { describe, expect, it } from 'vitest';
import {
  INITIAL_TRIM,
  markEnd,
  markStart,
  TRIM_MAX,
  trimError,
  trimLength,
  trimQuery,
  withDuration,
} from '../src/lib/trim';

// #42: "Start here" / "End here" on the clip upload preview.
describe('clip upload trim', () => {
  it('the preview duration fills an unset end (≤ 60 s)', () => {
    expect(withDuration(INITIAL_TRIM, 90)).toEqual({ start: '0', end: String(TRIM_MAX) });
    expect(withDuration(INITIAL_TRIM, 8.04)).toEqual({ start: '0', end: '8' });
    expect(withDuration({ start: '0', end: '5' }, 90)).toEqual({ start: '0', end: '5' });
  });

  it('End here sets the end (the old form only had a hidden length)', () => {
    const u = markEnd({ start: '10', end: '70' }, 25.04);
    expect(u.fields).toEqual({ start: '10', end: '25' });
    expect(u.note).toBeNull();
    expect(trimQuery(u.fields)).toEqual({ ss: 10, t: 15 });
  });

  it('End here past 60 s pulls the start along instead of silently ignoring it', () => {
    const u = markEnd({ start: '10', end: '25' }, 80);
    expect(u.fields).toEqual({ start: '20', end: '80' });
    expect(u.note).toMatch(/Start moved to 20/);
    expect(trimLength(u.fields)).toBe(TRIM_MAX);
    expect(trimQuery(u.fields)).toEqual({ ss: 20, t: 60 });
  });

  it('End here before (or right at) the start is refused with a visible note', () => {
    const f = { start: '10', end: '25' };
    for (const at of [5, 10, 10.5]) {
      const u = markEnd(f, at);
      expect(u.fields).toBe(f);
      expect(u.note).toMatch(/after the start/);
    }
  });

  it('Start here keeps a valid end, and moves an end that is too close or too far', () => {
    expect(markStart({ start: '0', end: '30' }, 12.34)).toEqual({
      fields: { start: '12.3', end: '30' },
      note: null,
    });
    const before = markStart({ start: '0', end: '30' }, 40, 90);
    expect(before.fields).toEqual({ start: '40', end: '90' }); // min(40 + 60, duration)
    expect(before.note).toMatch(/End moved to 90/);
    const stillValid = markStart({ start: '0', end: '60' }, 0.5, 120);
    expect(stillValid.fields).toEqual({ start: '0.5', end: '60' });
    const far = markStart({ start: '30', end: '80' }, 10, 120);
    expect(far.fields).toEqual({ start: '10', end: '70' });
    expect(markStart(INITIAL_TRIM, 7)).toEqual({ fields: { start: '7', end: '' }, note: null });
  });

  it('Start here never lands past the end of the video', () => {
    const u = markStart({ start: '0', end: '8' }, 8, 8);
    expect(u.fields.start).toBe('7');
    expect(trimError(u.fields)).toBeNull();
  });

  it('validates typed values: end > start, ≤ 60 s', () => {
    expect(trimError({ start: '0', end: '' })).toBeNull();
    expect(trimError({ start: '5', end: '65' })).toBeNull();
    expect(trimError({ start: '5', end: '65.5' })).toMatch(/at most 60/);
    expect(trimError({ start: '5', end: '5' })).toMatch(/after the start/);
    expect(trimError({ start: '9', end: '3' })).toMatch(/after the start/);
    expect(trimError({ start: '-1', end: '' })).toMatch(/Start/);
    expect(trimError({ start: 'x', end: '' })).toMatch(/Start/);
    expect(trimError({ start: '0', end: 'abc' })).toMatch(/End/);
  });

  it('upload params: ss always, t only with an end', () => {
    expect(trimQuery(INITIAL_TRIM)).toEqual({ ss: 0 });
    expect(trimQuery({ start: '1.5', end: '4' })).toEqual({ ss: 1.5, t: 2.5 });
  });
});
