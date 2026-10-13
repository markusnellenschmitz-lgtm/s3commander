import { describe, expect, it } from 'vitest';
import { FAKE_MAX_OPEN_VIEWS, FakeWindows } from './fakeWindows';

const page = {
  objects: [{ key: 'p/a', size: 1, lastModifiedMs: null, etag: null, storageClass: null }],
  prefixes: ['p/d/'],
  nextToken: null,
};

describe('FakeWindows', () => {
  it('hält wie das Backend nur die zuletzt geöffneten Sichten offen', async () => {
    const windows = new FakeWindows();
    const listing = windows.createListing('p/', [page]);
    const views = [];
    for (let i = 0; i <= FAKE_MAX_OPEN_VIEWS; i++) {
      views.push((await windows.openWindow(listing, null, { column: 'name', dir: 1 })).viewId);
    }
    expect(windows.openViews).toBe(FAKE_MAX_OPEN_VIEWS);
    await expect(windows.windowEntries(views[0], 0, 1)).rejects.toMatchObject({ kind: 'cache' });
    expect((await windows.windowEntries(views[FAKE_MAX_OPEN_VIEWS], 0, 5)).map((e) => e.key)).toEqual(['p/d/', 'p/a']);
  });

  it('ignoriert Seiten für unbekannte Listings und zeigt sie leer', async () => {
    const windows = new FakeWindows();
    windows.append(7, page);
    const view = await windows.openWindow(7, null, { column: 'name', dir: 1 });
    expect(view.stats).toEqual({ count: 0, folders: 0, bytes: 0, total: 0 });
  });
});
