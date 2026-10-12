import { describe, expect, it } from 'vitest';
import { isNavKey, navigationTarget, navMode } from './navigation';

describe('isNavKey', () => {
  it('erkennt Navigationstasten', () => {
    expect(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].every(isNavKey)).toBe(true);
    expect(isNavKey('Enter')).toBe(false);
  });
});

describe('navigationTarget', () => {
  it.each([
    ['ArrowDown', 5, 6],
    ['ArrowDown', 99, 99],
    ['ArrowUp', 5, 4],
    ['ArrowUp', 0, 0],
    ['PageDown', 5, 15],
    ['PageDown', 95, 99],
    ['PageUp', 15, 5],
    ['PageUp', 3, 0],
    ['Home', 50, 0],
    ['End', 50, 99],
  ] as const)('%s von %d → %d', (key, from, to) => {
    expect(navigationTarget(key, from, 100, 10)).toBe(to);
  });

  it('springt ohne Cursor an den Anfang, Ende ans Ende', () => {
    expect(navigationTarget('ArrowDown', -1, 100, 10)).toBe(0);
    expect(navigationTarget('PageUp', -1, 100, 10)).toBe(0);
    expect(navigationTarget('End', -1, 100, 10)).toBe(99);
  });

  it('liefert null bei leerer Liste', () => {
    expect(navigationTarget('ArrowDown', 0, 0, 10)).toBeNull();
  });

  it('bewegt bei Seitengröße 0 mindestens eine Zeile', () => {
    expect(navigationTarget('PageDown', 5, 100, 0)).toBe(6);
  });
});

describe('navMode', () => {
  it.each([
    [false, false, 'single'],
    [true, false, 'extend'],
    [true, true, 'extendAdd'],
    [false, true, 'cursorOnly'],
  ] as const)('shift=%s ctrl=%s → %s', (shift, ctrl, mode) => {
    expect(navMode(shift, ctrl)).toBe(mode);
  });
});
