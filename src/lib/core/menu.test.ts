import { describe, expect, it } from 'vitest';
import { isMenuItem, nextEnabledIndex, SEPARATOR, tidySeparators, type MenuEntry } from './menu';

const item = (id: string, disabled = false): MenuEntry => ({ id, label: id, icon: 'copy', disabled });

describe('Menü-Navigation', () => {
  const entries = [item('a'), SEPARATOR, item('b', true), item('c')];

  it('springt über Trennlinien und gesperrte Einträge mit Umlauf', () => {
    expect(nextEnabledIndex(entries, -1, 1)).toBe(0);
    expect(nextEnabledIndex(entries, 0, 1)).toBe(3);
    expect(nextEnabledIndex(entries, 3, 1)).toBe(0);
    expect(nextEnabledIndex(entries, 0, -1)).toBe(3);
    expect(nextEnabledIndex(entries, -1, -1)).toBe(3);
  });

  it('liefert -1 ohne wählbare Einträge', () => {
    expect(nextEnabledIndex([SEPARATOR, item('x', true)], -1, 1)).toBe(-1);
    expect(nextEnabledIndex([], -1, 1)).toBe(-1);
  });

  it('räumt Trennlinien auf', () => {
    const tidy = tidySeparators([SEPARATOR, item('a'), SEPARATOR, SEPARATOR, item('b'), SEPARATOR]);
    expect(tidy.map((e) => (isMenuItem(e) ? e.id : e))).toEqual(['a', SEPARATOR, 'b']);
    expect(tidySeparators([SEPARATOR])).toEqual([]);
  });
});
