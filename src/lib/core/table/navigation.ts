// Cursor-Bewegung in Listen per Tastatur (UI-SPEC §6, "In Listen").

const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'] as const;
export type NavKey = (typeof NAV_KEYS)[number];

export function isNavKey(key: string): key is NavKey {
  return (NAV_KEYS as readonly string[]).includes(key);
}

/**
 * Zielzeile für eine Navigationstaste. Ohne Cursor (current < 0) springen
 * alle Tasten außer Ende auf die erste Zeile.
 */
export function navigationTarget(key: NavKey, current: number, rowCount: number, pageSize: number): number | null {
  if (rowCount <= 0) return null;
  const last = rowCount - 1;
  if (key === 'End') return last;
  if (key === 'Home' || current < 0) return 0;
  const page = Math.max(1, pageSize);
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, current + 1);
    case 'ArrowUp':
      return Math.max(0, current - 1);
    case 'PageDown':
      return Math.min(last, current + page);
    case 'PageUp':
      return Math.max(0, current - page);
  }
}

export type NavMode = 'single' | 'extend' | 'extendAdd' | 'cursorOnly';

/** Umschalt erweitert, Strg+Umschalt erweitert additiv, Strg bewegt nur den Cursor. */
export function navMode(shift: boolean, ctrl: boolean): NavMode {
  if (shift) return ctrl ? 'extendAdd' : 'extend';
  return ctrl ? 'cursorOnly' : 'single';
}
