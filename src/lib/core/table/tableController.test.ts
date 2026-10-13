import { beforeEach, describe, expect, it } from 'vitest';
import { TableController } from './tableController.svelte';
import { Selection } from './selection.svelte';
import { KeyListSource } from '../../../test/fakes';

const none = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };
const ctrlShift = { ctrl: true, shift: true };

let source: KeyListSource;
let selection: Selection;
let table: TableController;

const selected = () => [...selection.rawKeys].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

beforeEach(() => {
  source = KeyListSource.ofSize(20);
  selection = new Selection();
  table = new TableController(
    () => source,
    () => selection,
  );
});

describe('Mausauswahl', () => {
  it('Klick wählt nur diese Zeile und setzt Cursor und Anker', () => {
    table.click(3, none);
    table.click(5, none);
    expect(selected()).toEqual(['k5']);
    expect(table.cursorIndex).toBe(5);
    expect(table.anchorKey).toBe('k5');
  });

  it('Strg+Klick schaltet um', () => {
    table.click(3, none);
    table.click(5, ctrl);
    expect(selected()).toEqual(['k3', 'k5']);
    table.click(3, ctrl);
    expect(selected()).toEqual(['k5']);
  });

  it('Umschalt+Klick wählt vom Anker bis zur Zeile', () => {
    table.click(3, none);
    table.click(6, shift);
    expect(selected()).toEqual(['k3', 'k4', 'k5', 'k6']);
    expect(table.anchorKey).toBe('k3');
  });

  it('Strg+Umschalt+Klick ergänzt den Bereich', () => {
    table.click(10, none);
    table.click(1, ctrl);
    table.click(3, ctrlShift);
    expect(selected()).toEqual(['k1', 'k2', 'k3', 'k10']);
  });

  it('Umschalt+Klick ohne Anker verhält sich wie Klick', () => {
    table.click(4, shift);
    expect(selected()).toEqual(['k4']);
  });

  it('ignoriert Klicks außerhalb der Quelle', () => {
    table.click(99, none);
    table.toggle(-1);
    table.contextClick(50);
    expect(selection.count(20)).toBe(0);
    expect(table.cursorIndex).toBe(-1);
  });

  it('Rechtsklick wählt eine nicht gewählte Zeile allein, behält bestehende Auswahl', () => {
    table.click(1, none);
    table.click(2, ctrl);
    table.contextClick(2);
    expect(selected()).toEqual(['k1', 'k2']);
    table.contextClick(7);
    expect(selected()).toEqual(['k7']);
    expect(table.cursorIndex).toBe(7);
  });

  it('Kopf-Checkbox: keine → alle → keine, gemischt → keine', () => {
    expect(table.headState).toBe('none');
    table.toggleAll();
    expect(table.headState).toBe('all');
    table.toggleAll();
    expect(table.headState).toBe('none');
    table.click(1, none);
    expect(table.headState).toBe('mixed');
    table.toggleAll();
    expect(table.headState).toBe('none');
  });

  it('isSelected prüft über den Schlüssel', () => {
    table.click(2, none);
    expect(table.isSelected(2)).toBe(true);
    expect(table.isSelected(3)).toBe(false);
    expect(table.isSelected(-1)).toBe(false);
  });

  it('Cursor und Auswahl überleben Umsortieren', () => {
    table.click(2, none);
    source.reverse();
    expect(table.cursorIndex).toBe(17);
    expect(table.isSelected(17)).toBe(true);
  });
});

describe('Tastatur', () => {
  it('Pfeil nach unten ohne Cursor wählt die erste Zeile', () => {
    const r = table.keyDown('ArrowDown', none, 10);
    expect(r).toEqual({ handled: true, reveal: 0 });
    expect(selected()).toEqual(['k0']);
  });

  it('Umschalt+Pfeil erweitert vom Anker', () => {
    table.click(5, none);
    table.keyDown('ArrowDown', shift, 10);
    table.keyDown('ArrowDown', shift, 10);
    expect(selected()).toEqual(['k5', 'k6', 'k7']);
    table.keyDown('ArrowUp', shift, 10);
    expect(selected()).toEqual(['k5', 'k6']);
  });

  it('Umschalt+Pfeil ohne Anker setzt ihn', () => {
    table.keyDown('ArrowDown', shift, 10);
    expect(table.anchorKey).toBe('k0');
  });

  it('Strg+Umschalt+Ende ergänzt bis zum Ende', () => {
    table.click(0, none);
    table.click(18, ctrl);
    table.keyDown('End', ctrlShift, 10);
    expect(selection.count(20)).toBe(3);
  });

  it('Strg+Pfeil bewegt nur den Cursor', () => {
    table.click(5, none);
    table.keyDown('ArrowDown', ctrl, 10);
    expect(selected()).toEqual(['k5']);
    expect(table.cursorIndex).toBe(6);
  });

  it('Leertaste schaltet die Cursorzeile um', () => {
    table.click(5, none);
    table.keyDown('ArrowDown', ctrl, 10);
    expect(table.keyDown(' ', none, 10).handled).toBe(true);
    expect(selected()).toEqual(['k5', 'k6']);
  });

  it('Leertaste ohne Cursor tut nichts', () => {
    table.keyDown(' ', none, 10);
    expect(selection.count(20)).toBe(0);
  });

  it('Enter öffnet die Cursorzeile', () => {
    expect(table.keyDown('Enter', none, 10)).toEqual({ handled: false });
    table.click(4, none);
    expect(table.keyDown('Enter', none, 10)).toEqual({ handled: true, open: 4 });
  });

  it('Esc hebt die Auswahl auf', () => {
    table.click(4, none);
    table.keyDown('Escape', none, 10);
    expect(selection.count(20)).toBe(0);
  });

  it('Strg+A wählt alles, A allein nicht', () => {
    expect(table.keyDown('a', none, 10).handled).toBe(false);
    table.keyDown('A', ctrl, 10);
    expect(table.headState).toBe('all');
  });

  it('Umschalt+F10 fordert das Kontextmenü an', () => {
    expect(table.keyDown('F10', shift, 10).handled).toBe(false);
    table.click(3, none);
    expect(table.keyDown('F10', none, 10).handled).toBe(false);
    expect(table.keyDown('F10', shift, 10)).toEqual({ handled: true, contextMenu: 3 });
  });

  it('ignoriert unbekannte Tasten und leere Listen', () => {
    expect(table.keyDown('x', none, 10).handled).toBe(false);
    source = KeyListSource.ofSize(0);
    expect(table.keyDown('ArrowDown', none, 10).handled).toBe(false);
  });
});

/** Quelle, die wie Fenster nur geladene Zeilen kennt (anfangs 0–4). */
class LazySource extends KeyListSource {
  loaded = new Set([0, 1, 2, 3, 4]);
  requests: [number, number][] = [];

  override get(index: number): string | undefined {
    return this.loaded.has(index) ? super.get(index) : undefined;
  }

  override keyAt(index: number): string | undefined {
    return this.get(index);
  }

  override indexOfKey(key: string): number {
    const index = super.indexOfKey(key);
    return this.loaded.has(index) ? index : -1;
  }

  async ensureLoaded(start: number, end: number): Promise<void> {
    this.requests.push([start, end]);
    for (let i = start; i <= end; i++) this.loaded.add(i);
  }
}

describe('Bereichsauswahl über nicht geladene Zeilen', () => {
  it('lädt den Bereich vor der Auswahl, damit keine Zeile fehlt', async () => {
    const lazy = new LazySource(Array.from({ length: 20 }, (_, i) => `k${i}`));
    source = lazy;
    table.click(2, none);
    lazy.loaded.add(15);
    table.click(15, shift);
    await Promise.resolve();
    expect(lazy.requests).toEqual([[2, 15]]);
    expect(selection.count(20)).toBe(14);
  });

  it('wählt einen Bereich über alles ohne Laden aus', () => {
    const lazy = new LazySource(Array.from({ length: 5 }, (_, i) => `k${i}`));
    source = lazy;
    table.click(0, none);
    table.click(4, shift);
    expect(lazy.requests).toEqual([]);
    expect(selection.isInverted).toBe(true);
  });
});
