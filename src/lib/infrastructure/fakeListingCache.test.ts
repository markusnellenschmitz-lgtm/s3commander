import { describe, expect, it } from 'vitest';
import { FakeListingCache } from './fakeListingCache';
import { createFakeBackend } from './fakeBackend';
import type { FolderPage } from '../core/backend';

const page = { objects: [], prefixes: ['a/', 'b/'], nextToken: null };

describe('FakeListingCache', () => {
  it('speichert je Ordner, vergisst Verbindungen und zählt Einträge', () => {
    const cache = new FakeListingCache();
    cache.store('p1', 'b', '', [page], 5);
    cache.store('p2', 'b', '', [page], 6);
    expect(cache.load('p1', 'b', '')).toEqual({ fetchedMs: 5, pages: [page] });
    expect(cache.stats()).toEqual({ folders: 2, entries: 4, bytes: 640 });
    cache.forgetProfile('p1');
    expect(cache.load('p1', 'b', '')).toBeUndefined();
    cache.clear();
    expect(cache.stats().folders).toBe(0);
  });
});

describe('Listing-Cache im Fake-Backend', () => {
  async function list(backend: ReturnType<typeof createFakeBackend>, fresh = false) {
    const pages: FolderPage[] = [];
    await backend.listFolder('aws-prod', 'prod-backups-eu', '', 'l', (p) => pages.push(p), { fresh });
    return pages.map((p) => (p.cachedMs === null ? 'frisch' : 'cache'));
  }

  it('liefert ab dem zweiten Listing zuerst den gespeicherten Stand', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    expect(await list(backend)).toEqual(['frisch']);
    expect(await list(backend)).toEqual(['cache', 'frisch']);
    expect(await list(backend, true)).toEqual(['frisch']);
    expect((await backend.cacheStats()).folders).toBe(1);
    await backend.deleteProfile('aws-prod');
    expect((await backend.cacheStats()).folders).toBe(0);
  });

  it('nutzt den Cache nicht, wenn er ausgeschaltet ist, und leert ihn auf Wunsch', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    await list(backend);
    await backend.clearListingCache();
    expect(await list(backend)).toEqual(['frisch']);
    await backend.saveSettings({ ...(await backend.getSettings()), cache: { enabled: false } });
    expect(await list(backend)).toEqual(['frisch']);
    await backend.clearListingCache();
    await list(backend);
    expect((await backend.cacheStats()).folders).toBe(0);
  });
});
