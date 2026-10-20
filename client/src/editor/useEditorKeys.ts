import { useEffect, useRef } from 'react';
import { editorStore, SPEEDS, transport } from './editorStore';

export interface EditorKeyHandlers {
  /** R: record / stop. */
  onRecord?: () => void;
  /** Shift+R: re-record the selected chunk. */
  onRerecord?: (id: string) => void;
  /** Del / Backspace: delete the selected chunk. */
  onDelete?: (id: string) => void;
  /** Esc while recording. */
  onStopRecording?: () => void;
  /** #48 E: open/close the effect picker. Shift+E: next effect on the selected take. */
  onCycleFx?: (id: string) => void;
  /** Disable all shortcuts (e.g. after Done). */
  disabled?: boolean;
}

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(type);
  }
  return false;
}

/**
 * Editor shortcuts (§2.3): Space play/pause · R record/stop · ←/→ ±5 s · Shift+←/→ ±0.1 s ·
 * Home start · 1–4 speed · M reference audio · Del/Backspace delete · Shift+R re-record ·
 * E effect picker · Shift+E next effect on the selected take · Esc close picker / deselect /
 * stop recording. Inactive while typing in an input.
 */
export function useEditorKeys(handlers: EditorKeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const h = ref.current;
      if (h.disabled || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextTarget(e.target)) return;
      // Leave arrow keys to a focused slider (volume).
      const onSlider =
        e.target instanceof HTMLElement && e.target.getAttribute('role') === 'slider';
      const s = editorStore.get();
      const recording = s.recording !== null;
      let handled = true;
      switch (e.code) {
        case 'Space':
          if (!e.repeat && !recording) transport.toggle();
          break;
        case 'KeyR':
          if (e.repeat) break;
          if (e.shiftKey) {
            if (!recording && s.selectedId) h.onRerecord?.(s.selectedId);
          } else h.onRecord?.();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (onSlider) return;
          const dir = e.code === 'ArrowLeft' ? -1 : 1;
          transport.nudge(dir * (e.shiftKey ? 100 : 5000));
          break;
        }
        case 'Home':
          transport.seek(0);
          break;
        case 'End':
          transport.seek(s.durationMs);
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4':
        case 'Numpad1':
        case 'Numpad2':
        case 'Numpad3':
        case 'Numpad4': {
          const i = Number(e.code.slice(-1)) - 1;
          transport.setSpeed(SPEEDS[i]!);
          break;
        }
        case 'KeyE':
          if (e.repeat || recording) break;
          if (e.shiftKey) {
            if (s.selectedId) h.onCycleFx?.(s.selectedId);
          } else transport.setFxOpen(!s.fxOpen);
          break;
        case 'KeyM':
          transport.setRefAudio(!s.refAudio);
          break;
        case 'Delete':
        case 'Backspace':
          if (!recording && s.selectedId) h.onDelete?.(s.selectedId);
          break;
        case 'Escape':
          if (recording) h.onStopRecording?.();
          else if (s.fxOpen) transport.setFxOpen(false);
          else if (s.selectedId) transport.select(null);
          else handled = false;
          break;
        case 'Tab':
          handled = false;
          break;
        case 'BracketLeft':
        case 'BracketRight':
          if (!recording) transport.selectNeighbour(e.code === 'BracketLeft' ? -1 : 1);
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    // Space on a focused button would also "click" it on keyup.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !ref.current.disabled && !isTextTarget(e.target))
        e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
}
