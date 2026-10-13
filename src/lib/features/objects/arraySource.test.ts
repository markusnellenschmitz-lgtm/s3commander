import { describe, expect, it } from 'vitest';
import { ArraySource } from './arraySource.svelte';
import { keepVisibleSelection, selectedBytes, selectedEntries, type ObjectSource } from './objectSource';
import { Selection } from '../../core/table/selection.svelte';
import { file, folder } from '../../../test/fakes';

const rows = [file('b', { size: 200 }), folder('dir'), file('a', { size: 100 }), file('c', { size: 300 })];

describe('ArraySource', () => {
  it('sortiert beim Anlegen und indiziert Schlüssel', () => {
    const s = new ArraySource(rows, { column: 'name', dir: 1 });
    expect(s.length).toBe(4);
    expect([0, 1, 2, 3].map((i) => s.get(i)?.name)).toEqual(['dir/', 'a', 'b', 'c']);
    expect(s.keyAt(1)).toBe('p/a');
    expect(s.indexOfKey('p/c')).toBe(3);
    expect(s.indexOfKey('fehlt')).toBe(-1);
    expect(s.get(9)).toBeUndefined();
    expect(s.keyAt(9)).toBeUndefined();
  });

  it('sortiert neu und erhöht die Version', () => {
    const s = new ArraySource(rows, { column: 'name', dir: 1 });
    const v = s.version;
    s.setSort({ column: 'size', dir: -1 });
    expect(s.get(1)?.name).toBe('c');
    expect(s.indexOfKey('p/c')).toBe(1);
    expect(s.version).toBe(v + 1);
  });

  it('ersetzt den Inhalt, ohne die Eingabe zu verändern', () => {
    const input = [file('x')];
    const s = new ArraySource(rows, { column: 'name', dir: 1 });
    s.replace(input);
    expect(s.length).toBe(1);
    expect(input).toHaveLength(1);
  });

  it('liefert Größen, Summe und Ordneranzahl', () => {
    const s = new ArraySource(rows, { column: 'name', dir: 1 });
    expect(s.sizeOfKey('p/b')).toBe(200);
    expect(s.sizeOfKey('p/dir/')).toBe(0);
    expect(s.sizeOfKey('fehlt')).toBe(0);
    expect(s.totalBytes).toBe(600);
    expect(s.folderCount).toBe(1);
  });
});

describe('selectedBytes', () => {
  const source = new ArraySource(rows, { column: 'name', dir: 1 });

  it('summiert gewählte Objekte', () => {
    const sel = new Selection();
    sel.set('p/a', true);
    sel.set('p/c', true);
    expect(selectedBytes(sel, source)).toBe(400);
  });

  it('zieht im invertierten Modus die Ausnahmen von der Summe ab', () => {
    const sel = new Selection();
    sel.selectAll();
    sel.set('p/b', false);
    expect(selectedBytes(sel, source)).toBe(400);
  });
});

describe('selectedEntries', () => {
  const source = new ArraySource(rows, { column: 'name', dir: 1 });

  it('liefert gewählte Einträge in Anzeigereihenfolge und überspringt unbekannte Schlüssel', () => {
    const sel = new Selection();
    sel.set('p/c', true);
    sel.set('p/dir/', true);
    sel.set('p/weg', true);
    expect(selectedEntries(sel, source).map((e) => e.name)).toEqual(['dir/', 'c']);
  });

  it('liefert im invertierten Modus alle außer den Ausnahmen in Anzeigereihenfolge', () => {
    const sel = new Selection();
    sel.selectAll();
    sel.set('p/b', false);
    expect(selectedEntries(sel, source).map((e) => e.name)).toEqual(['dir/', 'a', 'c']);
  });
});

describe('Filter und Auswahl', () => {
  const query = { text: '', kind: null, minSize: 150, maxSize: null, modifiedFrom: null, modifiedTo: null };

  it('filtert mit einer Abfrage und zeigt ohne wieder alles', () => {
    const s = new ArraySource(rows, { column: 'name', dir: 1 });
    s.setFilter(query);
    expect([0, 1].map((i) => s.get(i)?.name)).toEqual(['b', 'c']);
    expect(s.length).toBe(2);
    expect(s.totalCount).toBe(4);
    expect(s.isFiltered).toBe(true);
    s.setFilter(null);
    expect(s.length).toBe(4);
    expect(s.isComplete).toBe(true);
  });

  it('löst die Auswahl ohne Backend auf', async () => {
    const s = new ArraySource(rows, { column: 'name', dir: 1 });
    const sel = new Selection();
    sel.selectAll();
    sel.set('p/a', false);
    expect((await s.resolveSelected(sel)).map((e) => e.name)).toEqual(['dir/', 'b', 'c']);
  });

  it('behält nach einem Filter nur sichtbare Treffer, ohne alle Einträge gar keine', () => {
    const s = new ArraySource(rows, { column: 'name', dir: 1 });
    const sel = new Selection();
    sel.set('p/a', true);
    sel.set('p/c', true);
    s.setFilter(query);
    keepVisibleSelection(sel, s);
    expect([...sel.rawKeys]).toEqual(['p/c']);
    const partial = { isComplete: false } as ObjectSource;
    keepVisibleSelection(sel, partial);
    expect(sel.count(10)).toBe(0);
  });
});
