import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserViewModel, FLUSH_INTERVAL_MS, bucketNodeId, connectionNodeId } from './browserViewModel.svelte';
import { createFakeBackend, FAKE_PROFILES, SIGNATURE_ERROR } from '../../infrastructure/fakeBackend';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';
import type { BackendPort } from '../../core/backend';

let backend: BackendPort;
let vm: BrowserViewModel;
let scheduled: (() => void)[];
let ids: number;

/** Wartet, bis alle ausstehenden Promises (Backend-Aufrufe) erledigt sind. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function create(b: BackendPort = createFakeBackend({ pageDelayMs: 0, logObjects: 2500 })) {
  backend = b;
  scheduled = [];
  ids = 0;
  vm = new BrowserViewModel({ backend, newId: () => `id${++ids}`, schedule: (run) => scheduled.push(run) });
}

async function openBackups() {
  await vm.loadProfiles();
  vm.openBucket('aws-prod', 'prod-backups-eu');
  await settle();
  vm.openPrefix(BACKUPS_PREFIX);
  await settle();
}

beforeEach(() => create());

describe('Verbindungen', () => {
  it('lädt Profile, verbindet alle und meldet Fehler je Verbindung', async () => {
    await vm.loadProfiles();
    const [aws, b2] = vm.connections;
    expect(aws.status).toBe('connected');
    expect(aws.expanded).toBe(true);
    expect(aws.buckets.map((b) => b.name)).toContain('prod-backups-eu');
    expect(b2.status).toBe('error');
    expect(b2.error).toEqual(SIGNATURE_ERROR);
  });

  it('meldet getrennte Verbindungen, bis der Empfänger sich abmeldet', async () => {
    await vm.loadProfiles();
    const forgotten: string[] = [];
    const unsubscribe = vm.onForget((id) => forgotten.push(id));
    vm.disconnect('aws-prod');
    unsubscribe();
    vm.disconnect('b2-archiv');
    expect(forgotten).toEqual(['aws-prod']);
  });

  it('lädt Profile auf Wunsch ohne zu verbinden', async () => {
    await vm.loadProfiles({ autoConnect: false });
    expect(vm.connections.map((c) => c.status)).toEqual(['disconnected', 'disconnected']);
  });

  it('meldet Fehler beim Laden der Profile', async () => {
    create({ ...createFakeBackend(), listProfiles: () => Promise.reject(new Error('kaputt')) });
    await vm.loadProfiles();
    expect(vm.profilesError).toEqual({ kind: 'unexpected', message: 'kaputt' });
  });

  it('klappt verbundene Profile zu und verbindet fehlerhafte neu', async () => {
    await vm.loadProfiles();
    await vm.toggleConnection('aws-prod');
    expect(vm.connections[0].expanded).toBe(false);
    const listBuckets = vi.spyOn(backend, 'listBuckets');
    await vm.toggleConnection('b2-archiv');
    expect(listBuckets).toHaveBeenCalledWith('b2-archiv');
    await vm.toggleConnection('unbekannt');
    await vm.connect('unbekannt');
  });

  it('übernimmt gespeicherte Profile sortiert und verbindet sie', async () => {
    await vm.loadProfiles();
    const added = { ...FAKE_PROFILES[0], id: 'neu', name: 'Aaa Test' };
    await backend.saveProfile(added, null);
    await vm.upsertProfile(added);
    expect(vm.connections[0].profile.name).toBe('Aaa Test');
    expect(vm.connections[0].status).toBe('connected');
    await vm.upsertProfile({ ...added, name: 'Zzz Test' });
    expect(vm.connections.at(-1)?.profile.name).toBe('Zzz Test');
  });

  it('trennt eine Verbindung und schließt ihren offenen Ordner und Verlauf', async () => {
    await openBackups();
    vm.disconnect('b2-archiv');
    expect(vm.location).not.toBeNull();
    vm.disconnect('aws-prod');
    const aws = vm.connections[0];
    expect([aws.status, aws.expanded, aws.buckets]).toEqual(['disconnected', false, []]);
    expect(vm.location).toBeNull();
    expect([vm.source.length, vm.listingState, vm.activeTreeId, vm.canGoBack]).toEqual([0, 'idle', null, false]);
    vm.disconnect('unbekannt');
  });

  it('löscht ein Profil, behält andere Ordner offen und meldet Fehler weiter', async () => {
    await openBackups();
    const remove = vi.spyOn(backend, 'deleteProfile');
    await vm.deleteProfile('b2-archiv');
    expect(remove).toHaveBeenCalledWith('b2-archiv');
    expect(vm.connections.map((c) => c.profile.id)).toEqual(['aws-prod']);
    expect(vm.location?.bucket).toBe('prod-backups-eu');
    await vm.deleteProfile('aws-prod');
    expect(vm.connections).toEqual([]);
    expect(vm.location).toBeNull();
    remove.mockRejectedValueOnce({ kind: 'credential', message: 'Speicher gesperrt' });
    await expect(vm.deleteProfile('x')).rejects.toMatchObject({ kind: 'credential' });
  });
});

describe('Navigation und Listing', () => {
  it('lädt einen Ordner seitenweise und übernimmt Seiten gebündelt', async () => {
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-logs-eu');
    expect(vm.listingState).toBe('loading');
    expect(vm.listingText).toMatch(/Objekte geladen, Listing läuft$/);
    await settle();
    expect(vm.listingState).toBe('done');
    expect(vm.source.length).toBe(1);
    vm.openPrefix('cloudfront/');
    await settle();
    expect(vm.loadedCount).toBe(2500);
    expect(vm.source.length).toBe(2500);
    expect(scheduled.length).toBeGreaterThan(0);
    scheduled.forEach((run) => run());
    expect(vm.source.length).toBe(2500);
  });

  it('zeigt Ordner und Dateien mit Statusleisten-Texten', async () => {
    await openBackups();
    expect(vm.countText).toBe('17 Objekte · 4 Ordner');
    expect(vm.selectionText).toBe('Keine Auswahl');
    expect(vm.sortText).toBe('Sortiert nach Name, aufsteigend');
    expect(vm.crumbs.map((c) => c.label)).toEqual(['backups', '2026', '10']);
    expect(vm.tableLabel).toBe('Objekte in prod-backups-eu/backups/2026/10/');
    expect(vm.currentConnection?.profile.id).toBe('aws-prod');
  });

  it('öffnet Ordner, geht hoch, zurück und vor', async () => {
    await openBackups();
    vm.open(vm.source.get(0)!);
    await settle();
    expect(vm.location?.prefix).toBe(`${BACKUPS_PREFIX}daily/`);
    vm.open(vm.source.get(0)!); // Datei: keine Navigation
    expect(vm.location?.prefix).toBe(`${BACKUPS_PREFIX}daily/`);

    vm.goUp();
    expect(vm.location?.prefix).toBe(BACKUPS_PREFIX);
    vm.goBack();
    expect(vm.location?.prefix).toBe(`${BACKUPS_PREFIX}daily/`);
    expect(vm.canGoForward).toBe(true);
    vm.goForward();
    expect(vm.location?.prefix).toBe(BACKUPS_PREFIX);
    expect(vm.canGoForward).toBe(false);
    await settle();
  });

  it('ignoriert Navigation ohne Ziel', () => {
    vm.goBack();
    vm.goForward();
    vm.goUp();
    vm.refresh();
    vm.openPrefix('x/');
    expect(vm.location).toBeNull();
    expect(vm.canGoUp).toBe(false);
    expect(vm.crumbs).toEqual([]);
    expect(vm.tableLabel).toBe('Objekte');
  });

  it('sortiert, lädt neu und erkennt leere Ordner', async () => {
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-exports-eu');
    await settle();
    expect(vm.isEmptyFolder).toBe(true);
    await openBackups();
    vm.changeSort({ column: 'size', dir: -1 });
    expect(vm.sortText).toBe('Sortiert nach Größe, absteigend');
    expect(vm.source.get(0)?.isPrefix).toBe(true);
    vm.refresh();
    await settle();
    expect(vm.source.length).toBe(21);
  });

  it('bricht ein laufendes Listing ab und behält das Teilergebnis', async () => {
    create(createFakeBackend({ pageDelayMs: 2, logObjects: 5000 }));
    await vm.loadProfiles();
    vm.location = { profileId: 'aws-prod', bucket: 'prod-logs-eu', prefix: 'cloudfront/' };
    vm.refresh();
    await new Promise((r) => setTimeout(r, 5));
    vm.cancelListing();
    await new Promise((r) => setTimeout(r, 20));
    expect(vm.listingState).toBe('cancelled');
    expect(vm.listingError).toBeNull();
    expect(vm.listingText).toMatch(/^Listing abgebrochen nach/);
    expect(vm.listingText).not.toBe('');
  });

  it('verwirft Seiten eines abgelösten Listings', async () => {
    create(createFakeBackend({ pageDelayMs: 2, logObjects: 3000 }));
    await vm.loadProfiles();
    vm.location = { profileId: 'aws-prod', bucket: 'prod-logs-eu', prefix: 'cloudfront/' };
    vm.refresh();
    vm.openPrefix('');
    await new Promise((r) => setTimeout(r, 30));
    expect(vm.location?.prefix).toBe('');
    expect(vm.source.length).toBe(1);
  });

  it('zeigt Listing-Fehler und Verbindungsfehler in der Fehlerleiste', async () => {
    await vm.loadProfiles();
    vm.openBucket('b2-archiv', 'x');
    await settle();
    expect(vm.listingState).toBe('error');
    expect(vm.visibleError).toEqual(SIGNATURE_ERROR);
    vm.listingError = null;
    expect(vm.visibleError).toEqual(SIGNATURE_ERROR);
    expect(vm.listingText).toBe('');
  });

  it('lädt beim Wiederholen neu und verbindet fehlerhafte Verbindungen neu', async () => {
    await vm.loadProfiles();
    const listBuckets = vi.spyOn(backend, 'listBuckets');
    const listFolder = vi.spyOn(backend, 'listFolder');
    vm.retry();
    expect(listFolder).not.toHaveBeenCalled();

    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.retry();
    expect(listBuckets).not.toHaveBeenCalled();
    expect(listFolder).toHaveBeenCalledTimes(2);

    vm.openBucket('b2-archiv', 'x');
    vm.retry();
    expect(listBuckets).toHaveBeenCalledWith('b2-archiv');
    await settle();
  });
});

describe('Tastenkürzel', () => {
  it('ordnet F5, Alt+Pfeile und Rücktaste zu', async () => {
    await openBackups();
    expect(vm.handleShortcut('Backspace', false, false)).toBe(false);
    expect(vm.handleShortcut('Backspace', false, true)).toBe(true);
    expect(vm.location?.prefix).toBe('backups/2026/');
    expect(vm.handleShortcut('ArrowLeft', true, false)).toBe(true);
    expect(vm.location?.prefix).toBe(BACKUPS_PREFIX);
    expect(vm.handleShortcut('ArrowRight', true, false)).toBe(true);
    expect(vm.handleShortcut('ArrowUp', true, false)).toBe(true);
    expect(vm.handleShortcut('F5', false, false)).toBe(true);
    expect(vm.handleShortcut('x', false, false)).toBe(false);
    await settle();
  });
});

describe('Baum', () => {
  it('liefert sichtbare Knoten und markiert den offenen Bucket', async () => {
    await vm.loadProfiles();
    const ids = vm.treeNodes.map((n) => n.id);
    expect(ids[0]).toBe(connectionNodeId('aws-prod'));
    expect(ids).toContain(bucketNodeId('aws-prod', 'prod-logs-eu'));
    expect(ids.at(-1)).toBe(connectionNodeId('b2-archiv'));
    vm.openBucket('aws-prod', 'prod-logs-eu');
    expect(vm.isActiveBucket('aws-prod', 'prod-logs-eu')).toBe(true);
    expect(vm.activeTreeId).toBe(bucketNodeId('aws-prod', 'prod-logs-eu'));
    await settle();
  });

  it('bedient den Baum per Tastatur', async () => {
    await vm.loadProfiles();
    expect(vm.treeKeyDown('x')).toBe(false);
    expect(vm.treeKeyDown('ArrowDown')).toBe(true);
    expect(vm.activeTreeId).toBe(connectionNodeId('aws-prod'));
    vm.treeKeyDown('ArrowLeft');
    await settle();
    expect(vm.connections[0].expanded).toBe(false);
    vm.treeKeyDown('ArrowRight');
    await settle();
    expect(vm.connections[0].expanded).toBe(true);
    vm.treeKeyDown('ArrowDown');
    vm.treeKeyDown('Enter');
    await settle();
    expect(vm.location?.bucket).toBe('prod-backups-eu');
  });

  it('verbindet beim Aufklappen einer fehlerhaften Verbindung neu', async () => {
    await vm.loadProfiles();
    const listBuckets = vi.spyOn(backend, 'listBuckets');
    await vm.activateTreeNode(connectionNodeId('b2-archiv'), 'expand');
    expect(listBuckets).toHaveBeenCalledWith('b2-archiv');
    await vm.activateTreeNode('unbekannt');
  });
});

it('übernimmt Seiten nach dem Planungsintervall', () => {
  expect(FLUSH_INTERVAL_MS).toBeGreaterThan(0);
  const real = new BrowserViewModel({ backend: createFakeBackend() });
  expect(real.listingState).toBe('idle');
});

describe('Uploads', () => {
  it('liefert den offenen Ordner als Upload-Ziel', async () => {
    expect(vm.uploadTarget).toBeNull();
    await openBackups();
    expect(vm.uploadTarget).toEqual({ profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX });
  });

  it('lädt neu, wenn der geänderte Ordner oder ein Unterordner betroffen ist, und fasst zusammen', async () => {
    await openBackups();
    const refresh = vi.spyOn(vm, 'refresh');
    vm.refreshIfShowing('aws-prod', 'prod-backups-eu', 'anderer/');
    vm.refreshIfShowing('b2-archiv', 'prod-backups-eu', BACKUPS_PREFIX);
    vm.refreshIfShowing('aws-prod', 'prod-backups-eu', 'backups/');
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    vm.refreshIfShowing('aws-prod', 'prod-backups-eu', BACKUPS_PREFIX);
    vm.refreshIfShowing('aws-prod', 'prod-backups-eu', `${BACKUPS_PREFIX}neu/`);
    expect(refresh).not.toHaveBeenCalled();
    await settle();
    expect(refresh).toHaveBeenCalledOnce();
    vm.refreshIfShowing('aws-prod', 'prod-backups-eu', `${BACKUPS_PREFIX}neu/tief/`);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('ignoriert Änderungen ohne offenen Ordner', async () => {
    const refresh = vi.spyOn(vm, 'refresh');
    vm.refreshIfShowing('aws-prod', 'prod-backups-eu', '');
    await settle();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Downloads', () => {
  it('liefert die Auswahl im offenen Ordner zum Herunterladen', async () => {
    expect([vm.hasSelection, vm.selectedObjects]).toEqual([false, null]);
    await openBackups();
    scheduled.forEach((run) => run());
    expect(vm.hasSelection).toBe(false);
    const daily = vm.source.get(0)!;
    const file = vm.source.get(5)!;
    vm.selection.set(daily.key, true);
    vm.selection.set(file.key, true);
    expect(vm.hasSelection).toBe(true);
    expect(vm.selectedObjects).toEqual({
      folder: { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX },
      items: [
        { key: daily.key, isFolder: true, size: 0, etag: null, lastModifiedMs: null },
        {
          key: file.key,
          isFolder: false,
          size: file.size,
          etag: file.etag ?? null,
          lastModifiedMs: file.lastModified ?? null,
        },
      ],
    });
  });

  it('liefert nichts, wenn die gewählten Einträge nicht mehr geladen sind', async () => {
    await openBackups();
    vm.selection.set('weg', true);
    expect(vm.hasSelection).toBe(true);
    expect(vm.selectedObjects).toBeNull();
  });
});

describe('Listing-Cache', () => {
  const object = (key: string) => ({ key, size: 1, lastModifiedMs: null, etag: null, storageClass: null });
  const page = (keys: string[], cachedMs: number | null) => ({
    objects: keys.map(object),
    prefixes: [],
    nextToken: null,
    cachedMs,
  });

  /** Liefert erst eine Seite aus dem Cache, dann auf Kommando die frische Seite oder einen Fehler. */
  async function cachedThenLive() {
    let finish: (live: string[] | Error) => void = () => {};
    const listFolder = vi.spyOn(backend, 'listFolder').mockImplementation(async (_p, _b, _x, _id, onPage) => {
      onPage(page(['a.bin', 'alt.bin'], Date.UTC(2026, 9, 12, 8, 0)));
      const live = await new Promise<string[] | Error>((resolve) => (finish = resolve));
      if (live instanceof Error) throw live;
      onPage(page(live, null));
      return { pages: 2, objects: live.length, prefixes: 0 };
    });
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    await settle();
    scheduled.splice(0).forEach((run) => run());
    return { listFolder, finish: (live: string[] | Error) => finish(live) };
  }

  it('zeigt den gespeicherten Stand sofort und ersetzt ihn durch das fertige Listing', async () => {
    const { listFolder, finish } = await cachedThenLive();
    expect(listFolder.mock.calls[0][5]).toEqual({ fresh: false });
    expect(vm.source.length).toBe(2);
    expect(vm.cachedAtMs).not.toBeNull();
    expect(vm.listingText).toMatch(/^Stand .* aus dem Cache, wird aktualisiert \(0 Objekte geladen\)$/);
    vm.selection.set('a.bin', true);
    vm.selection.set('alt.bin', true);

    finish(['a.bin', 'neu.bin']);
    await settle();
    scheduled.splice(0).forEach((run) => run());
    expect([vm.source.keyAt(0), vm.source.keyAt(1)]).toEqual(['a.bin', 'neu.bin']);
    expect([...vm.selection.rawKeys]).toEqual(['a.bin']);
    expect(vm.cachedAtMs).toBeNull();
    expect(vm.listingState).toBe('done');
    expect(vm.listingText).toBe('');
  });

  it('behält den gespeicherten Stand, wenn das Aktualisieren scheitert', async () => {
    const { finish } = await cachedThenLive();
    finish(new Error('offline'));
    await settle();
    expect(vm.source.length).toBe(2);
    expect(vm.visibleError?.message).toBe('offline');
    expect(vm.listingText).toMatch(/aus dem Cache, Aktualisieren fehlgeschlagen$/);
    vm.listingState = 'cancelled';
    expect(vm.listingText).toMatch(/Aktualisieren abgebrochen$/);
  });

  it('lädt mit F5 frisch vom Server', async () => {
    await openBackups();
    const listFolder = vi.spyOn(backend, 'listFolder');
    vm.refresh();
    expect(listFolder.mock.calls[0][5]).toEqual({ fresh: true });
  });
});
