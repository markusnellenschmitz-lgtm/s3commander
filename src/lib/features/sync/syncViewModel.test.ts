import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncViewModel } from './syncViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import type { BackendPort, ObjectSelection, SyncPreview } from '../../core/backend';

const folder = { profileId: 'aws-prod', bucket: 'prod-exports-eu', prefix: '' };
const DB_PROD = 'D:\\Backups\\db-prod';

let backend: BackendPort;
let deleteExtras: ReturnType<typeof vi.fn<(selection: ObjectSelection) => void>>;
let vm: SyncViewModel;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  deleteExtras = vi.fn<(selection: ObjectSelection) => void>();
  vm = new SyncViewModel({ backend, deleteExtras });
});

describe('SyncViewModel', () => {
  it('vergleicht beim Öffnen und zeigt, was übertragen wird', async () => {
    vm.open(folder, DB_PROD);
    expect(vm.comparing).toBe(true);
    await settle();
    expect(vm.preview?.transfers).toBe(4);
    expect(vm.summaryText).toBe('4 Dateien (5,30 GiB) · 4 neu · 0 unverändert');
    expect(vm.preview?.items.find((i) => i.relative === 'alt/db-full-20261001.tar.zst')?.reason).toBe('new');
    expect([vm.canStart, vm.hiddenCount]).toEqual([true, 0]);
  });

  it('startet den Abgleich, schließt und lädt danach nichts doppelt', async () => {
    const start = vi.spyOn(backend, 'startSync');
    vm.open(folder, DB_PROD);
    await settle();
    await vm.start();
    expect(start).toHaveBeenCalledOnce();
    expect(vm.isOpen).toBe(false);
    expect((await backend.listTransfers()).map((t) => t.key)).toContain('alt/db-full-20261001.tar.zst');
    vm.open(folder, DB_PROD);
    await settle();
    expect(vm.summaryText).toBe('4 Dateien (5,30 GiB) · 4 neu · 0 unverändert');
  });

  it('meldet „alles aktuell“ und lässt dann nur das Löschen zu', async () => {
    const preview: SyncPreview = {
      planId: 'p',
      direction: 'upload',
      transfers: 0,
      bytes: 0,
      unchanged: 3,
      items: [],
      remoteExtras: [{ key: 'alt.bin', size: 5 }],
      localExtras: 0,
    };
    vi.spyOn(backend, 'planSync').mockResolvedValue(preview);
    const start = vi.spyOn(backend, 'startSync');
    vm.open(folder, DB_PROD);
    await settle();
    expect(vm.summaryText).toBe('Alles aktuell · 3 Dateien unverändert');
    expect(vm.canStart).toBe(false);
    vm.deleteRemoteExtras = true;
    expect(vm.canStart).toBe(true);
    await vm.start();
    expect(start).not.toHaveBeenCalled();
    expect(deleteExtras).toHaveBeenCalledWith({
      folder,
      items: [{ key: 'alt.bin', isFolder: false, size: 5, etag: null }],
    });
  });

  it('vergleicht beim Wechsel der Richtung neu und zählt nur lokale Dateien', async () => {
    vm.open({ ...folder, bucket: 'prod-backups-eu', prefix: 'gibt-es-nicht/' }, DB_PROD);
    await settle();
    vm.deleteRemoteExtras = true;
    vm.setDirection('download');
    expect(vm.deleteRemoteExtras).toBe(false);
    await settle();
    expect(vm.preview).toMatchObject({ direction: 'download', transfers: 0, localExtras: 4 });
    vm.setDirection('download');
    expect(vm.comparing).toBe(false);
  });

  it('zeigt Fehler, verwirft veraltete Antworten und ignoriert Doppelklicks', async () => {
    vi.spyOn(backend, 'planSync').mockRejectedValueOnce({ kind: 'localFile', message: 'nicht lesbar' });
    vm.open(folder, DB_PROD);
    await settle();
    expect(vm.error?.message).toBe('nicht lesbar');
    await vm.start();
    await vm.compare();
    expect(vm.preview?.transfers).toBe(4);

    let finish: (p: SyncPreview) => void = () => {};
    vi.spyOn(backend, 'planSync').mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const slow = vm.compare();
    const fresh = vm.compare();
    finish({ ...(vm.preview as SyncPreview), planId: 'alt', transfers: 99 });
    await slow;
    await fresh;
    expect(vm.preview?.planId).not.toBe('alt');

    vi.spyOn(backend, 'startSync').mockRejectedValueOnce({ kind: 'syncPlanNotFound', message: 'abgelaufen' });
    vm.open(folder, DB_PROD);
    await settle();
    await vm.start();
    expect([vm.error?.message, vm.isOpen, vm.starting]).toEqual(['abgelaufen', true, false]);
    vm.starting = true;
    vm.close();
    expect(vm.isOpen).toBe(true);
  });

  it('kennt die Gründe und Mengen auch bei langen Listen', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ relative: `f${i}`, size: 1, reason: 'newer' as const }));
    vi.spyOn(backend, 'planSync').mockResolvedValue({
      planId: 'p',
      direction: 'upload',
      transfers: 250,
      bytes: 250,
      unchanged: 0,
      items,
      remoteExtras: [],
      localExtras: 0,
    });
    vm.open(folder, DB_PROD);
    await settle();
    expect(vm.hiddenCount).toBe(50);
    expect(vm.summaryText).toBe('250 Dateien (250 B) · 0 unverändert');
    await vm.compare();
    vm.close();
    await vm.compare();
  });
});
