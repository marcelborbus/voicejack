import { create } from 'zustand';

export type ToastVariant = 'default' | 'success' | 'error' | 'warning';

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  durationMs: number;
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id' | 'variant' | 'durationMs'> & Partial<ToastItem>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    const item: ToastItem = { variant: 'default', durationMs: 4500, ...t, id };
    // Keep at most 4 on screen; same title+description replaces the older one.
    set((s) => ({
      toasts: [
        ...s.toasts
          .filter((x) => !(x.title === item.title && x.description === item.description))
          .slice(-3),
        item,
      ],
    }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Fire a toast from anywhere (also outside React). */
export function toast(
  title: string,
  opts: { description?: string; variant?: ToastVariant; durationMs?: number } = {},
): number {
  return useToasts.getState().push({ title, ...opts });
}
