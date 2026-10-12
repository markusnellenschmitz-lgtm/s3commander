import { describe, expect, it, vi } from 'vitest';
import { FakeSync } from './fakeSync';
import { createFakeBackend } from './fakeBackend';
import { createTauriBackend } from './tauriBackend';
import { BACKUPS_PREFIX } from './fixtures/buckets';

const folder = { profileId: 'p', bucket: 'b', prefix: 'sicherung/' };
const local = (relative: string, size: number, modifiedMs: number) => ({
  path: `C:\\daten\\${relative}`,
  relative,
  size,
  modifiedMs,
});
const remote = (relative: string, size: number, modifiedMs: number | null) => ({
  key: `sicherung/${relative}`,
  relative,
  size,
  modifiedMs,
});

describe('FakeSync', () => {
  it('plant Downloads mit lokalen Zielpfaden nach denselben Regeln wie das Backend', () => {
    const sync = new FakeSync();
    const preview = sync.plan(
      folder,
      'C:\\daten',
      'download',
      [local('gleich.txt', 1, 10_000), local('nur-lokal.txt', 1, 0)],
      [remote('gleich.txt', 1, 11_000), remote('neuer.txt', 2, 9), remote('unter/datei.txt', 3, null)],
    );
    expect(preview).toMatchObject({ transfers: 2, unchanged: 1, localExtras: 1, remoteExtras: [] });
    expect(sync.take(preview.planId).downloads.map((d) => d.localPath)).toEqual([
      'C:\\daten\\neuer.txt',
      'C:\\daten\\unter\\datei.txt',
    ]);
    expect(() => sync.take(preview.planId)).toThrow();
  });

  it('erkennt geänderte Größen und neuere Quellen beim Hochladen', () => {
    const sync = new FakeSync();
    const preview = sync.plan(
      folder,
      'C:\\daten\\',
      'upload',
      [local('a.txt', 1, 50_000), local('b.txt', 2, 0)],
      [remote('a.txt', 1, 10_000), remote('b.txt', 9, 0), remote('weg.txt', 4, 0)],
    );
    expect(preview.items.map((i) => i.reason)).toEqual(['newer', 'sizeDiffers']);
    expect(preview.remoteExtras).toEqual([{ key: 'sicherung/weg.txt', size: 4 }]);
    expect(sync.take(preview.planId).uploads[0]).toEqual({ path: 'C:\\daten\\a.txt', key: 'sicherung/a.txt', size: 1 });
  });

  it('lädt im Fake-Backend Objekte in einen lokalen Ordner herunter', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const backups = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: `${BACKUPS_PREFIX}daily/` };
    const preview = await backend.planSync(backups, 'C:\\Daten', 'download');
    expect(preview.transfers).toBeGreaterThan(0);
    const ids = await backend.startSync(preview.planId);
    expect(ids).toHaveLength(preview.transfers);
    expect((await backend.listTransfers())[0].localPath).toMatch(/^C:\\Daten\\/);
  });

  it('ruft die Tauri-Befehle des Abgleichs auf', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const backend = createTauriBackend(call as never);
    await backend.planSync(folder, 'C:\\daten', 'upload');
    await backend.startSync('sync-1');
    expect(call.mock.calls).toEqual([
      ['plan_sync', { profileId: 'p', bucket: 'b', prefix: 'sicherung/', localDir: 'C:\\daten', direction: 'upload' }],
      ['start_sync', { planId: 'sync-1' }],
    ]);
  });
});
