import { describe, expect, it } from 'vitest';
import { objectCountText, selectionText, sortText } from './statusText';

describe('Statusleisten-Texte', () => {
  it('zählt Objekte und Ordner', () => {
    expect(objectCountText(17, 4)).toBe('17 Objekte · 4 Ordner');
    expect(objectCountText(1_000_000, 0)).toBe('1.000.000 Objekte');
    expect(objectCountText(1, 0)).toBe('1 Objekt');
  });

  it('beschreibt die Auswahl', () => {
    expect(selectionText(0, 0)).toBe('Keine Auswahl');
    expect(selectionText(3, Math.round(14.16 * 1024 ** 3))).toBe('3 ausgewählt · 14,2 GiB');
    expect(selectionText(2, 0)).toBe('2 ausgewählt');
  });

  it('nennt die Sortierung', () => {
    expect(sortText({ column: 'name', dir: 1 })).toBe('Sortiert nach Name, aufsteigend');
    expect(sortText({ column: 'storageClass', dir: -1 })).toBe('Sortiert nach Storage Class, absteigend');
    expect(sortText({ column: 'unbekannt', dir: 1 })).toBe('Sortiert nach unbekannt, aufsteigend');
  });
});
