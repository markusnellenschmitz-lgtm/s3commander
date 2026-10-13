import { describe, expect, it, vi } from 'vitest';
import type { FolderPage, ListPage } from '../../core/backend';
import { Selection } from '../../core/table/selection.svelte';
import { FakeWindows } from '../../infrastructure/fakeWindows';
import { FLUSH_INTERVAL_MS, FolderContent, WINDOW_REFRESH_MS } from './folderContent.svelte';

const PREFIX = 'p/';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function objects(names: string[]): ListPage {
  return {
    objects: names.map((name) => ({
      key: `${PREFIX}${name}`,
      size: name.length,
      lastModifiedMs: null,
      etag: null,
      storageClass: null,
    })),
    prefixes: [],
    nextToken: null,
  };
}

const page = (names: string[], cachedMs: number | null = null): FolderPage => ({
  ...objects(names),
  cachedMs,
  window: null,
});

const windowPage = (listingId: number, loaded: number, cachedMs: number | null = null): FolderPage => ({
  ...objects([]),
  cachedMs,
  window: { listingId, loaded },
});

function setup() {
  const windows = new FakeWindows();
  const release = vi.fn().mockResolvedValue(undefined);
  const scheduled: { run: () => void; delayMs: number }[] = [];
  const onError = vi.fn();
  const selection = new Selection();
  const content = new FolderContent({
    port: Object.assign(windows, { releaseListing: release }),
    selection,
    sort: { column: 'name', dir: 1 },
    schedule: (run, delayMs) => scheduled.push({ run, delayMs }),
    onError,
  });
  content.reset(PREFIX);
  const runScheduled = () => scheduled.splice(0).forEach(({ run }) => run());
  return { windows, release, scheduled, runScheduled, onError, selection, content };
}

const names = (content: FolderContent) =>
  Array.from({ length: content.source.length }, (_, i) => content.source.get(i)?.name);

describe('FolderContent', () => {
  it('sammelt kleine Listings gebündelt in einer vollständigen Liste', () => {
    const { content, scheduled, runScheduled } = setup();
    content.receive(page(['b', 'a']));
    content.receive(page(['c']));
    expect(scheduled.map((s) => s.delayMs)).toEqual([FLUSH_INTERVAL_MS]);
    expect(content.source.length).toBe(0);
    runScheduled();
    expect(names(content)).toEqual(['a', 'b', 'c']);
    expect([content.loadedCount, content.source.isComplete]).toEqual([3, true]);
  });

  it('wechselt ab dem Verweis auf ein Listing zu Fenstern und frischt sie während des Listings auf', async () => {
    const { content, windows, scheduled, runScheduled } = setup();
    content.receive(page(['a']));
    const listingId = windows.createListing(PREFIX, [objects(['a', 'b', 'c'])]);
    content.receive(windowPage(listingId, 3));
    expect([content.source.isComplete, content.loadedCount]).toEqual([false, 3]);
    windows.append(listingId, objects(['d']));
    content.receive(windowPage(listingId, 4));
    content.receive(windowPage(listingId, 4));
    expect(scheduled.filter((s) => s.delayMs === WINDOW_REFRESH_MS)).toHaveLength(1);
    runScheduled();
    content.flush();
    await settle();
    expect(content.source.totalCount).toBe(4);
    windows.append(listingId, objects(['e']));
    content.finish();
    await settle();
    expect(content.source.totalCount).toBe(5);
  });

  it('zeigt einen großen Stand aus dem Cache als Fenster und danach das frische Listing', async () => {
    const { content, windows, release } = setup();
    const cached = windows.createListing(PREFIX, [objects(['alt'])]);
    content.receive(windowPage(cached, 1, 77));
    expect(content.cachedAtMs).toBe(77);
    await settle();
    expect(content.isOpening).toBe(false);
    expect(content.source.totalCount).toBe(1);
    const fresh = windows.createListing(PREFIX, [objects(['neu', 'neu2'])]);
    content.receive(windowPage(fresh, 2));
    expect(content.source.totalCount).toBe(1);
    content.finish();
    expect(release).toHaveBeenCalledWith(cached);
    await settle();
    expect([content.source.totalCount, content.cachedAtMs]).toEqual([2, null]);
  });

  it('kehrt zur vollständigen Liste zurück, wenn das frische Listing klein ist', async () => {
    const { content, windows, release, selection } = setup();
    const cached = windows.createListing(PREFIX, [objects(['a', 'b'])]);
    content.receive(windowPage(cached, 2, 77));
    selection.set(`${PREFIX}a`, true);
    selection.set(`${PREFIX}weg`, true);
    content.receive(page(['a']));
    content.finish();
    expect(release).toHaveBeenCalledWith(cached);
    expect([content.source.isComplete, names(content)]).toEqual([true, ['a']]);
    expect([...selection.rawKeys]).toEqual([`${PREFIX}a`]);
  });

  it('gibt ein nie gezeigtes frisches Listing nach Abbruch oder beim Ordnerwechsel frei', async () => {
    const { content, windows, release } = setup();
    content.receive(page(['a'], 77));
    content.receive(windowPage(41, 60_000));
    content.abort();
    expect(release).toHaveBeenCalledWith(41);
    content.receive(windowPage(42, 60_000));
    content.reset('anders/');
    expect(release).toHaveBeenLastCalledWith(42);
    const shown = windows.createListing(PREFIX, [objects(['x'])]);
    content.receive(windowPage(shown, 1));
    content.reset('');
    expect(release).toHaveBeenLastCalledWith(shown);
    expect([content.loadedCount, content.cachedAtMs, content.source.isComplete]).toEqual([0, null, true]);
  });

  it('sortiert und filtert die gezeigte Quelle und behält den Filter beim Wechsel', async () => {
    const { content, windows, selection } = setup();
    const query = { text: 'b', kind: null, minSize: null, maxSize: null, modifiedFrom: null, modifiedTo: null };
    content.receive(page(['a', 'bb']));
    content.flush();
    selection.set(`${PREFIX}a`, true);
    content.applyFilter(query);
    expect(names(content)).toEqual(['bb']);
    expect(selection.count(10)).toBe(0);
    const listingId = windows.createListing(PREFIX, [objects(['a', 'b', 'bb', 'cb'])]);
    content.receive(windowPage(listingId, 4));
    await settle();
    expect([content.source.length, content.source.totalCount]).toEqual([3, 4]);
    content.setSort({ column: 'size', dir: -1 });
    content.applyFilter(null);
    await settle();
    content.source.ensureRange?.(0, 4);
    await settle();
    expect(content.source.get(0)?.name).toMatch(/^(bb|cb)$/);
    expect(content.source.length).toBe(4);
  });

  it('löst die Auswahl über die gezeigte Quelle auf und meldet Fehler der Fenster', async () => {
    const { content, windows, selection, onError } = setup();
    const listingId = windows.createListing(PREFIX, [objects(['a', 'b'])]);
    content.receive(windowPage(listingId, 2));
    selection.selectAll();
    expect((await content.resolveSelected()).map((e) => e.name)).toEqual(['a', 'b']);
    content.receive(windowPage(999_999, 2));
    await settle();
    expect(onError).not.toHaveBeenCalled();
    vi.spyOn(windows, 'openWindow').mockRejectedValueOnce({ kind: 'cache', message: 'gesperrt' });
    content.receive(windowPage(listingId + 1, 2));
    await settle();
    expect(onError).toHaveBeenCalledWith({ kind: 'cache', message: 'gesperrt' });
  });
});
