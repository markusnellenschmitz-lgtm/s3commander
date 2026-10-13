import { describe, expect, it, vi } from 'vitest';
import type { ListPage, WindowPort } from '../../core/backend';
import { Selection } from '../../core/table/selection.svelte';
import { FakeWindows } from '../../infrastructure/fakeWindows';
import {
  MAX_LOADED_PAGES,
  WINDOW_PAGE_SIZE,
  WindowSource,
  fromWindowEntry,
  type WindowSourceOptions,
} from './windowSource.svelte';

const PREFIX = 'logs/';
const BY_NAME = { column: 'name', dir: 1 } as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Ordner `logs/` mit `count` Dateien `f00000` … (Größe = Nummer) und einem Unterordner. */
function listing(count: number): ListPage {
  return {
    objects: Array.from({ length: count }, (_, i) => ({
      key: `${PREFIX}f${String(i).padStart(5, '0')}`,
      size: i,
      lastModifiedMs: i * 1000,
      etag: `"e${i}"`,
      storageClass: 'STANDARD',
    })),
    prefixes: [`${PREFIX}archiv/`],
    nextToken: null,
  };
}

function setup(count: number, options: Partial<WindowSourceOptions> = {}) {
  const port = new FakeWindows();
  const listingId = port.createListing(PREFIX, [listing(count)]);
  const source = new WindowSource({ port, listingId, prefix: PREFIX, sort: BY_NAME, filter: null, ...options });
  return { port, source };
}

async function show(source: WindowSource, start: number, end: number) {
  source.ensureRange(start, end);
  await settle();
}

describe('WindowSource', () => {
  it('zählt die Sicht und lädt nur die Seiten um den sichtbaren Bereich', async () => {
    const { port, source } = setup(1200);
    const requests = vi.spyOn(port, 'windowEntries');
    await source.ready;
    expect([source.length, source.totalCount, source.folderCount]).toEqual([1201, 1201, 1]);
    expect(source.totalBytes).toBe((1199 * 1200) / 2);
    expect(source.get(0)).toBeUndefined();
    await show(source, 0, 30);
    expect(requests).toHaveBeenCalledTimes(2);
    expect(source.get(0)).toMatchObject({ name: 'archiv/', isPrefix: true });
    expect(source.get(1)).toMatchObject({ name: 'f00000', size: 0, etag: '"e0"' });
    expect(source.keyAt(600)).toBe('logs/f00599');
    expect(source.get(1100)).toBeUndefined();
    expect(source.indexOfKey('logs/f00010')).toBe(11);
    expect(source.indexOfKey('logs/f01100')).toBe(-1);
    expect(source.sizeOfKey('logs/f00010')).toBe(10);
    expect([source.isComplete, source.isFiltered]).toEqual([false, false]);
  });

  it('öffnet beim Sortieren und Filtern eine neue Sicht und schließt die alte', async () => {
    const { port, source } = setup(1200);
    await show(source, 0, 10);
    const version = source.version;
    source.setSort({ column: 'size', dir: -1 });
    await source.ready;
    expect(source.version).toBeGreaterThan(version);
    expect(source.get(1)).toBeUndefined();
    await show(source, 0, 10);
    expect(source.get(1)?.name).toBe('f01199');
    source.setFilter({ text: 'f011*', kind: null, minSize: null, maxSize: null, modifiedFrom: null, modifiedTo: null });
    await source.ready;
    expect([source.length, source.totalCount, source.isFiltered]).toEqual([100, 1201, true]);
    expect(port.openViews).toBe(1);
  });

  it('verwirft Antworten zu überholten Sichten', async () => {
    const { port, source } = setup(100);
    await source.ready;
    source.setSort({ column: 'size', dir: -1 });
    source.setSort({ column: 'size', dir: 1 });
    await source.ready;
    await settle();
    await show(source, 0, 5);
    expect(source.get(1)?.name).toBe('f00000');
    expect(port.openViews).toBe(1);
  });

  it('vergisst lange nicht gezeigte Seiten, behält aber Einträge der Auswahl', async () => {
    const selected = new Set(['logs/f00003']);
    const { source } = setup((MAX_LOADED_PAGES + 10) * WINDOW_PAGE_SIZE, { retain: (key) => selected.has(key) });
    await source.ready;
    for (let page = 0; page < MAX_LOADED_PAGES + 10; page++) {
      await show(source, page * WINDOW_PAGE_SIZE, page * WINDOW_PAGE_SIZE + 10);
    }
    expect(source.get(5)).toBeUndefined();
    expect(source.indexOfKey('logs/f00003')).toBe(-1);
    expect(source.sizeOfKey('logs/f00003')).toBe(3);
    expect(source.sizeOfKey('logs/f00004')).toBe(0);
    expect(source.get(source.length - 1)).toBeDefined();
  });

  it('lädt einen ganzen Bereich mit wenigen Anfragen', async () => {
    const { port, source } = setup(25_000);
    const requests = vi.spyOn(port, 'windowEntries');
    await source.ensureLoaded(0, 24_000);
    expect(requests).toHaveBeenCalledTimes(3);
    expect(source.keyAt(24_000)).toBe('logs/f23999');
    await source.ensureLoaded(0, 9_000);
    expect(requests).toHaveBeenCalledTimes(3);
  });

  it('lädt den vor dem Öffnen angeforderten Bereich, sobald die Sicht offen ist', async () => {
    const { source } = setup(100);
    source.ensureRange(0, 10);
    await source.ready;
    await settle();
    expect(source.get(1)?.name).toBe('f00000');
  });

  it('löst die Auswahl auf: „alle außer …“ über das Backend, sonst aus bekannten Einträgen', async () => {
    const { source } = setup(1200);
    await show(source, 0, 10);
    const all = new Selection();
    all.selectAll();
    all.set('logs/archiv/', false);
    all.set('logs/f00001', false);
    const everything = await source.resolveSelected(all);
    expect(everything).toHaveLength(1199);
    expect(everything[0].name).toBe('f00000');
    const some = new Selection();
    some.set('logs/f00005', true);
    some.set('logs/f00002', true);
    some.set('logs/unbekannt', true);
    expect((await source.resolveSelected(some)).map((e) => e.name)).toEqual(['f00002', 'f00005']);
  });

  it('meldet Fehler beim Öffnen und Laden', async () => {
    const onError = vi.fn();
    const failing: WindowPort = {
      openWindow: () => Promise.reject({ kind: 'cache', message: 'kaputt' }),
      windowEntries: () => Promise.reject(new Error('nie')),
      windowSelection: () => Promise.reject(new Error('nie')),
      closeWindow: () => Promise.resolve(),
    };
    const source = new WindowSource({ port: failing, listingId: 1, prefix: '', sort: BY_NAME, filter: null, onError });
    await source.ready;
    expect(onError).toHaveBeenCalledWith({ kind: 'cache', message: 'kaputt' });
    expect(source.length).toBe(0);
    expect(await source.resolveSelected(Object.assign(new Selection(), {}))).toEqual([]);
    const all = new Selection();
    all.selectAll();
    expect(await source.resolveSelected(all)).toEqual([]);
    source.ensureRange(0, 10);

    const { port, source: open } = setup(10, { onError });
    await open.ready;
    vi.spyOn(port, 'windowEntries').mockRejectedValueOnce({ kind: 'cache', message: 'Sicht weg' });
    await show(open, 0, 5);
    expect(onError).toHaveBeenLastCalledWith({ kind: 'cache', message: 'Sicht weg' });
  });

  it('schließt die Sicht beim Verwerfen und ignoriert danach eintreffende Antworten', async () => {
    const { port, source } = setup(100);
    await source.ready;
    source.ensureRange(0, 10);
    source.dispose();
    await settle();
    expect(port.openViews).toBe(0);
    expect(source.get(1)).toBeUndefined();
    expect(source.length).toBe(0);
  });

  it('wandelt Einträge des Backends in Tabellenzeilen', () => {
    const folder = { key: 'a/b/', isPrefix: true, size: 0, lastModifiedMs: null, etag: null, storageClass: null };
    expect(fromWindowEntry(folder, 'a/')).toEqual({ key: 'a/b/', name: 'b/', isPrefix: true });
    const file = { key: 'a/x', isPrefix: false, size: 3, lastModifiedMs: null, etag: '"e"', storageClass: null };
    expect(fromWindowEntry(file, 'a/')).toEqual({
      key: 'a/x',
      name: 'x',
      isPrefix: false,
      size: 3,
      lastModified: undefined,
      storageClass: undefined,
      etag: '"e"',
    });
  });
});
