import { describe, expect, it } from 'vitest';
import { Selection } from './selection.svelte';
import { KeyListSource } from '../../../test/fakes';

describe('Selection', () => {
  it('ist anfangs leer', () => {
    const s = new Selection();
    expect(s.count(10)).toBe(0);
    expect(s.has('k0')).toBe(false);
    expect(s.isInverted).toBe(false);
  });

  it('only ersetzt die Auswahl', () => {
    const s = new Selection();
    s.set('a', true);
    s.only('b');
    expect([...s.rawKeys]).toEqual(['b']);
  });

  it('toggle schaltet um und erhöht die Version', () => {
    const s = new Selection();
    const v = s.version;
    s.toggle('a');
    expect(s.has('a')).toBe(true);
    s.toggle('a');
    expect(s.has('a')).toBe(false);
    expect(s.version).toBe(v + 2);
  });

  it('selectAll arbeitet invertiert ohne Schlüssel zu speichern', () => {
    const s = new Selection();
    s.selectAll();
    expect(s.isInverted).toBe(true);
    expect(s.rawKeys.size).toBe(0);
    expect(s.count(1_000_000)).toBe(1_000_000);
    s.set('x', false);
    expect(s.has('x')).toBe(false);
    expect(s.count(1_000_000)).toBe(999_999);
    s.set('x', true);
    expect(s.count(1_000_000)).toBe(1_000_000);
  });

  it('clear hebt auch die invertierte Auswahl auf', () => {
    const s = new Selection();
    s.selectAll();
    s.clear();
    expect(s.isInverted).toBe(false);
    expect(s.count(5)).toBe(0);
  });

  it('set ohne Benachrichtigung lässt die Version unverändert', () => {
    const s = new Selection();
    const v = s.version;
    s.set('a', true, false);
    expect(s.version).toBe(v);
  });

  describe('selectRange', () => {
    const source = KeyListSource.ofSize(10);

    it('wählt den Bereich in beide Richtungen', () => {
      const s = new Selection();
      s.selectRange(source, 5, 2, false);
      expect(s.count(10)).toBe(4);
      expect(['k2', 'k3', 'k4', 'k5'].every((k) => s.has(k))).toBe(true);
    });

    it('ersetzt ohne additive die bisherige Auswahl', () => {
      const s = new Selection();
      s.only('k9');
      s.selectRange(source, 0, 1, false);
      expect(s.has('k9')).toBe(false);
    });

    it('ergänzt mit additive', () => {
      const s = new Selection();
      s.only('k9');
      s.selectRange(source, 0, 1, true);
      expect(s.count(10)).toBe(3);
    });

    it('nutzt für den Gesamtbereich den invertierten Modus', () => {
      const s = new Selection();
      s.selectRange(source, 9, 0, false);
      expect(s.isInverted).toBe(true);
      expect(s.count(10)).toBe(10);
    });

    it('begrenzt den Bereich auf die Quelle und überspringt fehlende Schlüssel', () => {
      const s = new Selection();
      const sparse = new KeyListSource(['a', undefined as unknown as string, 'c']);
      s.selectRange(sparse, -5, 50, true);
      expect([...s.rawKeys]).toEqual(['a', 'c']);
    });
  });

  it('prune entfernt verschwundene Schlüssel', () => {
    const s = new Selection();
    s.set('k1', true);
    s.set('weg', true);
    const v = s.version;
    s.prune(KeyListSource.ofSize(3));
    expect([...s.rawKeys]).toEqual(['k1']);
    expect(s.version).toBe(v + 1);
    s.prune(KeyListSource.ofSize(3));
    expect(s.version).toBe(v + 1);
  });
});
