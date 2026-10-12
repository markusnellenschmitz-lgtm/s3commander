import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTauriBackend, isTauri, TRANSFERS_EVENT } from './tauriBackend';
import { createFakeBackend, FAKE_PRESETS, FAKE_PROFILES, SIGNATURE_ERROR } from './fakeBackend';
import type { DeleteProgress, FolderPage, ListPage, RenameProgress, TransferUpdate } from '../core/backend';
import { BACKUPS_PREFIX } from './fixtures/buckets';
import { DEFAULT_TRANSFER_PREFERENCES } from '../features/settings/settingsRules';

describe('createTauriBackend', () => {
  it('erkennt die Plattform am User-Agent der WebView', () => {
    const backend = (userAgent: string) => createTauriBackend(vi.fn() as never, undefined, undefined, userAgent);
    expect(backend('Mozilla/5.0 (Windows NT 10.0; Win64; x64)').platform).toBe('windows');
    expect(backend('Mozilla/5.0 (X11; Linux x86_64)').platform).toBe('linux');
    expect(['windows', 'linux']).toContain(createTauriBackend(vi.fn() as never).platform);
  });

  it('ruft die Tauri-Befehle mit den erwarteten Argumenten auf', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    const backend = createTauriBackend(call as never);
    const profile = FAKE_PROFILES[0];
    const credentials = { accessKeyId: 'a', secretAccessKey: 'b' };

    await backend.listPresets();
    await backend.listProfiles();
    await backend.saveProfile(profile, credentials);
    await backend.deleteProfile('p');
    await backend.testConnection(profile, null);
    await backend.listBuckets('p');
    await backend.cancelListing('l');
    const target = { profileId: 'p', bucket: 'b', prefix: 'x/' };
    await backend.enqueueUploads(target, ['C:\\a.bin']);
    const items = [{ key: 'x/a.bin', isFolder: false, size: 1, etag: null }];
    await backend.enqueueDownloads(target, items, 'D:\\Ziel');
    const source = { folder: target, items };
    await backend.enqueueCopies(source, { profileId: 'p', bucket: 'z', prefix: 'y/' }, true);
    await backend.listTransfers();
    await backend.pauseTransfer(1);
    await backend.resumeTransfer(1);
    await backend.cancelTransfer(1);
    await backend.retryTransfer(1);
    await backend.pauseAllTransfers();
    await backend.resumeAllTransfers();
    await backend.removeFinishedTransfers();

    expect(call.mock.calls).toEqual([
      ['list_presets'],
      ['list_profiles'],
      ['save_profile', { profile, credentials }],
      ['delete_profile', { id: 'p' }],
      ['test_connection', { profile, credentials: null }],
      ['list_buckets', { profileId: 'p' }],
      ['cancel_listing', { listingId: 'l' }],
      ['enqueue_uploads', { profileId: 'p', bucket: 'b', prefix: 'x/', paths: ['C:\\a.bin'] }],
      ['enqueue_downloads', { profileId: 'p', bucket: 'b', prefix: 'x/', items, targetDir: 'D:\\Ziel' }],
      [
        'enqueue_copies',
        {
          profileId: 'p',
          sourceBucket: 'b',
          items,
          targetProfileId: 'p',
          targetBucket: 'z',
          targetPrefix: 'y/',
          moveItems: true,
        },
      ],
      ['list_transfers'],
      ['pause_transfer', { id: 1 }],
      ['resume_transfer', { id: 1 }],
      ['cancel_transfer', { id: 1 }],
      ['retry_transfer', { id: 1 }],
      ['pause_all_transfers'],
      ['resume_all_transfers'],
      ['remove_finished_transfers'],
    ]);
  });

  it('reicht Seiten aus dem Kanal an onPage weiter', async () => {
    const channel = { onmessage: (_: FolderPage) => {} };
    const call = vi.fn().mockResolvedValue({ pages: 1, objects: 0, prefixes: 0 });
    const backend = createTauriBackend(call as never, () => channel as never);
    const pages: FolderPage[] = [];
    await backend.listFolder('p', 'b', 'x/', 'l1', (page) => pages.push(page));
    expect(call).toHaveBeenCalledWith('list_folder', {
      profileId: 'p',
      bucket: 'b',
      prefix: 'x/',
      listingId: 'l1',
      fresh: false,
      onPage: channel,
    });
    channel.onmessage({ objects: [], prefixes: ['x/y/'], nextToken: null, cachedMs: null });
    expect(pages).toHaveLength(1);
    await backend.listFolder('p', 'b', 'x/', 'l2', () => {}, { fresh: true });
    expect(call.mock.calls[1][1]).toMatchObject({ listingId: 'l2', fresh: true });
  });

  it('ruft die Löschbefehle auf und reicht den Fortschritt weiter', async () => {
    const channel = { onmessage: (_: DeleteProgress) => {} };
    const call = vi.fn().mockResolvedValue(undefined);
    const backend = createTauriBackend(call as never, () => channel as never);
    const folder = { profileId: 'p', bucket: 'b', prefix: 'x/' };
    const items = [{ key: 'x/a', isFolder: false, size: 1, etag: null }];
    await backend.prepareDelete(folder, items);
    const progress: DeleteProgress[] = [];
    await backend.deleteObjects('delete-1', (p) => progress.push(p));
    await backend.cancelDelete('delete-1');
    await backend.discardDelete('delete-1');
    expect(call.mock.calls).toEqual([
      ['prepare_delete', { profileId: 'p', bucket: 'b', items }],
      ['delete_objects', { planId: 'delete-1', onProgress: channel }],
      ['cancel_delete', { planId: 'delete-1' }],
      ['discard_delete', { planId: 'delete-1' }],
    ]);
    channel.onmessage({ processed: 1, total: 1 });
    expect(progress).toEqual([{ processed: 1, total: 1 }]);
  });

  it('fragt den Listing-Cache ab, leert ihn und listet lokale Ordner', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const backend = createTauriBackend(call as never);
    await backend.cacheStats();
    await backend.clearListingCache();
    await backend.listLocalDir(null);
    expect(call.mock.calls).toEqual([['cache_stats'], ['clear_listing_cache'], ['list_local_dir', { path: null }]]);
  });

  it('liest und speichert Einstellungen', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const backend = createTauriBackend(call as never);
    const value = { transfers: { ...DEFAULT_TRANSFER_PREFERENCES }, cache: { enabled: true } };
    await backend.getSettings();
    await backend.saveSettings(value);
    expect(call.mock.calls).toEqual([['get_settings'], ['save_settings', { value }]]);
  });

  it('ruft die Befehle der Objekt-Details auf', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const backend = createTauriBackend(call as never);
    const at = { profileId: 'p', bucket: 'b', key: 'k' };
    const metadata = [{ name: 'cache-control', value: 'no-store' }];
    const tags = [{ key: 'env', value: 'prod' }];
    await backend.objectHead(at);
    await backend.saveObjectMetadata(at, metadata);
    await backend.objectTags(at);
    await backend.saveObjectTags(at, tags);
    await backend.objectVersions(at);
    await backend.restoreObjectVersion(at, 'v1');
    await backend.deleteObjectVersion(at, 'v2');
    await backend.objectAcl(at);
    await backend.presignObject(at, 3600);
    await backend.shareLink('k', 'https://b/k');
    expect(call.mock.calls).toEqual([
      ['object_head', at],
      ['save_object_metadata', { ...at, metadata }],
      ['object_tags', at],
      ['save_object_tags', { ...at, tags }],
      ['object_versions', at],
      ['restore_object_version', { ...at, versionId: 'v1' }],
      ['delete_object_version', { ...at, versionId: 'v2' }],
      ['object_acl', at],
      ['presign_object', { ...at, expiresSecs: 3600 }],
      ['share_link', { title: 'k', url: 'https://b/k' }],
    ]);
  });

  it('legt Ordner an und benennt mit Fortschritt um', async () => {
    const channel = { onmessage: (_: RenameProgress) => {} };
    const call = vi.fn().mockResolvedValue(undefined);
    const backend = createTauriBackend(call as never, () => channel as never);
    const folder = { profileId: 'p', bucket: 'b', prefix: 'x/' };
    const item = { key: 'x/a/', isFolder: true, size: 0, etag: null };
    await backend.createFolder(folder, 'neu');
    const progress: RenameProgress[] = [];
    await backend.renameObject(folder, item, 'b', (p) => progress.push(p));
    expect(call.mock.calls).toEqual([
      ['create_folder', { profileId: 'p', bucket: 'b', prefix: 'x/', name: 'neu' }],
      ['rename_object', { profileId: 'p', bucket: 'b', item, newName: 'b', onProgress: channel }],
    ]);
    channel.onmessage({ copied: 1, total: 2 });
    expect(progress).toEqual([{ copied: 1, total: 2 }]);
  });

  it('abonniert das Transfer-Event', async () => {
    const unlisten = vi.fn();
    const listen = vi.fn().mockResolvedValue(unlisten);
    const backend = createTauriBackend(vi.fn() as never, undefined, listen as never);
    const received: unknown[] = [];
    expect(await backend.onTransfers((list) => received.push(list))).toBe(unlisten);
    expect(listen.mock.calls[0][0]).toBe(TRANSFERS_EVENT);
    listen.mock.calls[0][1]({ payload: ['stand'] });
    expect(received).toEqual([['stand']]);
  });

  it('erkennt die Tauri-Umgebung', () => {
    expect(isTauri()).toBe(false);
    expect(isTauri({ __TAURI_INTERNALS__: {} } as unknown as Window)).toBe(true);
  });
});

describe('createFakeBackend', () => {
  const fast = () => createFakeBackend({ pageDelayMs: 0, logObjects: 2500 });

  it('gibt sich als Windows aus, wenn nichts anderes verlangt ist', () => {
    expect(fast().platform).toBe('windows');
    expect(createFakeBackend({ platform: 'linux' }).platform).toBe('linux');
  });

  it('liefert Vorlagen und Profile', async () => {
    const backend = fast();
    expect(await backend.listPresets()).toBe(FAKE_PRESETS);
    expect((await backend.listProfiles()).map((p) => p.id)).toEqual(['aws-prod', 'b2-archiv']);
  });

  it('listet Buckets, auch den Standard-Bucket, und simuliert Signaturfehler', async () => {
    const backend = fast();
    expect((await backend.listBuckets('aws-prod')).map((b) => b.name)).toContain('prod-backups-eu');
    await expect(backend.listBuckets('b2-archiv')).rejects.toBe(SIGNATURE_ERROR);
    await expect(backend.listBuckets('weg')).rejects.toMatchObject({ kind: 'profileNotFound' });
    await backend.saveProfile({ ...FAKE_PROFILES[0], id: 'neu', defaultBucket: 'gtg-mods' }, null);
    expect(await backend.listBuckets('neu')).toEqual([{ name: 'gtg-mods', createdMs: null }]);
  });

  it('speichert, ersetzt und löscht Profile', async () => {
    const backend = fast();
    await backend.saveProfile({ ...FAKE_PROFILES[1], name: 'Repariert' }, { accessKeyId: 'a', secretAccessKey: 'b' });
    const repaired = (await backend.listProfiles()).find((p) => p.id === 'b2-archiv')!;
    expect(repaired.name).toBe('Repariert');
    await expect(backend.listBuckets('b2-archiv')).resolves.toBeDefined();
    await backend.deleteProfile('b2-archiv');
    await backend.deleteProfile('gibt-es-nicht');
    expect(await backend.listProfiles()).toHaveLength(1);
  });

  it('testet Verbindungen und meldet falsche Schlüssel', async () => {
    const backend = fast();
    expect(await backend.testConnection(FAKE_PROFILES[0], null)).toEqual({ bucketCount: 5, latencyMs: 142 });
    expect((await backend.testConnection({ ...FAKE_PROFILES[0], defaultBucket: 'b' }, null)).bucketCount).toBeNull();
    await expect(
      backend.testConnection(FAKE_PROFILES[0], { accessKeyId: 'a', secretAccessKey: 'falsch' }),
    ).rejects.toBe(SIGNATURE_ERROR);
  });

  it('listet Ordner seitenweise', async () => {
    const backend = fast();
    const pages: ListPage[] = [];
    const summary = await backend.listFolder('aws-prod', 'prod-logs-eu', 'cloudfront/', 'l', (p) => pages.push(p));
    expect(summary).toEqual({ pages: 3, objects: 2500, prefixes: 0 });
    expect(pages[0].objects).toHaveLength(1000);
    expect(await backend.listFolder('aws-prod', 'unbekannt', '', 'l2', () => {})).toEqual({
      pages: 1,
      objects: 0,
      prefixes: 0,
    });
  });

  it('bricht laufende Listings ab und ignoriert beendete', async () => {
    const backend = createFakeBackend({ pageDelayMs: 1, logObjects: 5000 });
    const listing = backend.listFolder('aws-prod', 'prod-logs-eu', 'cloudfront/', 'l', () => {});
    expect(await backend.cancelListing('l')).toBe(true);
    await expect(listing).rejects.toMatchObject({ kind: 'cancelled' });
    expect(await backend.cancelListing('l')).toBe(false);
  });

  it('nutzt Standardwerte für Verzögerung und Datenmenge', async () => {
    const backend = createFakeBackend();
    const summary = await backend.listFolder('aws-prod', 'prod-exports-eu', '', 'l', () => {});
    expect(summary.pages).toBe(1);
  });
});

describe('Löschen im Fake-Backend', () => {
  it('löscht genau die vorbereiteten Objekte und nur einmal', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX };
    const items = [{ key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null }];
    const preview = await backend.prepareDelete(folder, items);
    expect(preview).toMatchObject({ objects: 1, bytes: Math.round(312.6 * 1024 ** 2), versioned: true });
    const progress: DeleteProgress[] = [];
    const outcome = await backend.deleteObjects(preview.planId, (p) => progress.push(p));
    expect(outcome).toEqual({ deleted: 1, failedCount: 0, failures: [], cancelled: false });
    expect(progress).toEqual([{ processed: 1, total: 1 }]);
    const pages: ListPage[] = [];
    await backend.listFolder('aws-prod', 'prod-backups-eu', BACKUPS_PREFIX, 'l', (p) => pages.push(p));
    expect(pages.flatMap((p) => p.prefixes)).not.toContain(`${BACKUPS_PREFIX}daily/`);
    await expect(backend.deleteObjects(preview.planId, () => {})).rejects.toMatchObject({
      kind: 'deletePlanNotFound',
    });
  });

  it('verwirft vorbereitete Pläne und kennt unversionierte Buckets', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const folder = { profileId: 'aws-prod', bucket: 'prod-exports-eu', prefix: '' };
    const preview = await backend.prepareDelete(folder, [{ key: 'x', isFolder: false, size: 1, etag: null }]);
    expect(preview).toMatchObject({ objects: 0, versioned: false });
    await backend.discardDelete(preview.planId);
    await expect(backend.deleteObjects(preview.planId, () => {})).rejects.toBeDefined();
    expect(await backend.cancelDelete(preview.planId)).toBe(false);
  });
});

describe('Ordner und Namen im Fake-Backend', () => {
  async function listing(backend: ReturnType<typeof createFakeBackend>, prefix: string) {
    const pages: ListPage[] = [];
    await backend.listFolder('aws-prod', 'prod-backups-eu', prefix, 'l', (p) => pages.push(p));
    return { prefixes: pages.flatMap((p) => p.prefixes), keys: pages.flatMap((p) => p.objects.map((o) => o.key)) };
  }

  it('legt Ordner an und lehnt vergebene oder ungültige Namen ab', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX };
    expect(await backend.createFolder(folder, 'neu')).toBe(`${BACKUPS_PREFIX}neu/`);
    expect((await listing(backend, BACKUPS_PREFIX)).prefixes).toContain(`${BACKUPS_PREFIX}neu/`);
    await expect(backend.createFolder(folder, 'daily')).rejects.toMatchObject({ kind: 'nameTaken' });
    await expect(backend.createFolder(folder, 'a/b')).rejects.toMatchObject({ kind: 'invalidName' });
  });

  it('benennt Ordner mit Inhalt und einzelne Dateien um', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX };
    const daily = { key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null };
    const progress: RenameProgress[] = [];
    const outcome = await backend.renameObject(folder, daily, 'täglich', (p) => progress.push(p));
    expect(outcome).toEqual({ newKey: `${BACKUPS_PREFIX}täglich/`, undeleted: 0 });
    expect(progress).toEqual([{ copied: 1, total: 1 }]);
    expect((await listing(backend, `${BACKUPS_PREFIX}täglich/`)).keys).toEqual([
      `${BACKUPS_PREFIX}täglich/db-incr-20261011-0600.tar.zst`,
    ]);
    const file = {
      key: `${BACKUPS_PREFIX}täglich/db-incr-20261011-0600.tar.zst`,
      isFolder: false,
      size: 1,
      etag: null,
    };
    const renamed = await backend.renameObject(folder, file, 'db.tar.zst', () => {});
    expect(renamed.newKey).toBe(`${BACKUPS_PREFIX}täglich/db.tar.zst`);
    expect(await backend.renameObject(folder, { ...file, key: renamed.newKey }, 'db.tar.zst', () => {})).toEqual({
      newKey: renamed.newKey,
      undeleted: 0,
    });
  });
});

describe('Kopieren im Fake-Backend', () => {
  afterEach(() => vi.useRealTimers());

  it('kopiert mit nummerierten Namen, verschiebt und lehnt Ordner in sich selbst ab', async () => {
    vi.useFakeTimers();
    const backend = createFakeBackend({ pageDelayMs: 0, transfers: { tickMs: 10, bytesPerSec: 10 * 1024 ** 3 } });
    const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX };
    const daily = { key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null };
    await backend.enqueueCopies({ folder, items: [daily] }, folder, false);
    expect((await backend.listTransfers())[0]).toMatchObject({
      direction: 'copy',
      key: `${BACKUPS_PREFIX}daily (2)/db-incr-20261011-0600.tar.zst`,
      copySource: { bucket: 'prod-backups-eu', key: `${BACKUPS_PREFIX}daily/db-incr-20261011-0600.tar.zst` },
    });
    expect(await backend.enqueueCopies({ folder, items: [daily] }, folder, true)).toEqual([]);
    const target = { ...folder, bucket: 'prod-exports-eu', prefix: '' };
    await backend.enqueueCopies({ folder, items: [daily] }, target, true);
    vi.advanceTimersByTime(1000);
    const pages: ListPage[] = [];
    await backend.listFolder('aws-prod', 'prod-exports-eu', '', 'l', (p) => pages.push(p));
    expect(pages[0].prefixes).toEqual(['daily/']);
    const source: ListPage[] = [];
    await backend.listFolder('aws-prod', 'prod-backups-eu', BACKUPS_PREFIX, 'l2', (p) => source.push(p));
    expect(source.flatMap((p) => p.prefixes)).toContain(`${BACKUPS_PREFIX}daily (2)/`);
    expect(source.flatMap((p) => p.prefixes)).not.toContain(`${BACKUPS_PREFIX}daily/`);
    const file = { key: `${BACKUPS_PREFIX}x.bin`, isFolder: false, size: 3, etag: null };
    await backend.enqueueCopies({ folder, items: [file] }, target, false);
    const b2 = FAKE_PROFILES.find((p) => p.id === 'b2-archiv')!;
    await backend.saveProfile(b2, null);
    await backend.enqueueCopies({ folder, items: [file] }, { profileId: b2.id, bucket: 'archiv', prefix: '' }, false);
    expect((await backend.listTransfers()).at(-1)).toMatchObject({
      profileId: 'b2-archiv',
      sourceProfileId: 'aws-prod',
    });
    await expect(
      backend.enqueueCopies({ folder, items: [daily] }, { ...folder, prefix: `${BACKUPS_PREFIX}daily/sub/` }, false),
    ).rejects.toMatchObject({ kind: 'copyIntoItself' });
  });
});

describe('Transfers im Fake-Backend', () => {
  afterEach(() => vi.useRealTimers());

  it('legt fertige Uploads im Bucket ab und meldet Stände', async () => {
    vi.useFakeTimers();
    const backend = createFakeBackend({ pageDelayMs: 0, transfers: { tickMs: 10, bytesPerSec: 10 * 1024 ** 3 } });
    const seen: TransferUpdate[] = [];
    const unsubscribe = await backend.onTransfers((update) => seen.push(update));
    const [id] = await backend.enqueueUploads({ profileId: 'aws-prod', bucket: 'prod-exports-eu', prefix: '' }, [
      'C:\\Exporte\\neu.zip',
    ]);
    await backend.pauseTransfer(id);
    await backend.resumeTransfer(id);
    vi.advanceTimersByTime(1000);
    expect((await backend.listTransfers())[0].state).toBe('done');
    const pages: ListPage[] = [];
    await backend.listFolder('aws-prod', 'prod-exports-eu', '', 'l', (p) => pages.push(p));
    expect(pages[0].objects.map((o) => o.key)).toEqual(['neu.zip']);
    await backend.removeFinishedTransfers();
    expect(await backend.listTransfers()).toEqual([]);
    expect(seen.at(-1)).toEqual({ changed: [], removed: [id] });
    await backend.pauseAllTransfers();
    await backend.resumeAllTransfers();
    await backend.cancelTransfer(id);
    await backend.retryTransfer(id);
    unsubscribe();
    expect(seen.length).toBeGreaterThan(3);
  });

  it('lädt Dateien und Ordner mit ihrer Struktur herunter', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX };
    const items = [
      { key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null },
      { key: `${BACKUPS_PREFIX}x.bin`, isFolder: false, size: 5, etag: null },
    ];
    const ids = await backend.enqueueDownloads(folder, items, 'D:\\Ziel');
    const list = await backend.listTransfers();
    expect(ids).toHaveLength(2);
    expect(list.map((t) => [t.direction, t.localPath, t.totalBytes])).toEqual([
      ['download', 'D:\\Ziel\\daily\\db-incr-20261011-0600.tar.zst', Math.round(312.6 * 1024 ** 2)],
      ['download', 'D:\\Ziel\\x.bin', 5],
    ]);
    await expect(backend.enqueueDownloads({ ...folder, profileId: 'b2-archiv' }, items, 'D:\\')).rejects.toBe(
      SIGNATURE_ERROR,
    );
  });
});
