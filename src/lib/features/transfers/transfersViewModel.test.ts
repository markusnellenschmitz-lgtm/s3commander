import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransfersViewModel } from './transfersViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { createFakeFilePicker, FAKE_TARGET_FOLDER } from '../../infrastructure/filePickers';
import type { BackendPort, FolderLocation, TransferSnapshot, TransferUpdate } from '../../core/backend';
import { transfer } from '../../../test/transfers';

const target = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: 'backups/' };
const selection = { folder: target, items: [{ key: 'backups/a.bin', isFolder: false, size: 1, etag: null }] };

let backend: BackendPort;
let listener: (update: TransferUpdate) => void;
const emit = (changed: TransferSnapshot[], removed: number[] = []) => listener({ changed, removed });
let onFolderChanged: ReturnType<typeof vi.fn<(f: FolderLocation) => void>>;
let vm: TransfersViewModel;

beforeEach(async () => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  vi.spyOn(backend, 'onTransfers').mockImplementation(async (l) => {
    listener = l;
    return () => {};
  });
  onFolderChanged = vi.fn<(f: FolderLocation) => void>();
  vm = new TransfersViewModel({ backend, picker: createFakeFilePicker(['C:\\a.bin', 'C:\\b.bin']), onFolderChanged });
  await vm.start();
});

const list = [
  transfer({ id: 1, state: 'active', bytesPerSec: 10, doneBytes: 50, totalBytes: 100 }),
  transfer({ id: 2, state: 'waiting', doneBytes: 0, totalBytes: 100, bytesPerSec: 0 }),
  transfer({ id: 3, state: 'waiting', doneBytes: 0, totalBytes: 100, bytesPerSec: 0 }),
  transfer({ id: 4, state: 'paused', doneBytes: 25, totalBytes: 100, bytesPerSec: 0 }),
  transfer({ id: 5, state: 'done', doneBytes: 0, totalBytes: 100, finishedMs: 1 }),
  transfer({ id: 6, state: 'failed', doneBytes: 50, totalBytes: 100 }),
  transfer({ id: 7, state: 'cancelled', doneBytes: 10, totalBytes: 1000 }),
];

describe('Stand', () => {
  it('übernimmt gemeldete Stände und zählt je Filter', () => {
    emit(list);
    expect(vm.counts).toEqual({ all: 7, active: 1, waiting: 3, done: 1, failed: 1 });
    vm.filter = 'waiting';
    expect(vm.visible.map((t) => t.id)).toEqual([2, 3, 4]);
    vm.filter = 'all';
    expect(vm.visible).toHaveLength(7);
    expect(vm.summaryText).toBe('1 aktiv · 3 wartend · 1 Fehler');
  });

  it('summiert Fortschritt, Tempo und Restzeit ohne abgebrochene', () => {
    emit(list);
    expect(vm.totals).toEqual({
      doneBytes: 225,
      totalBytes: 600,
      percent: 37,
      bytesPerSec: 10,
      speeds: { upload: 10 },
      restSeconds: 37.5,
    });
    expect(vm.current?.id).toBe(1);
    expect(vm.waitingPosition(3)).toBe(2);
    expect(vm.waitingPosition(1)).toBe(0);
  });

  it('meldet erlaubte Sammelaktionen', () => {
    expect([vm.canPauseAll, vm.canResumeAll, vm.canRemoveFinished]).toEqual([false, false, false]);
    expect(vm.totals.percent).toBe(0);
    emit(list);
    expect([vm.canPauseAll, vm.canResumeAll, vm.canRemoveFinished]).toEqual([true, true, true]);
    expect(vm.summaryText).not.toBe('');
    vm.transfers = [transfer({ state: 'done' })];
    expect(vm.summaryText).toBe('');
  });

  it('meldet geänderte Ordner jedes fertigen Transfers genau einmal', () => {
    emit([transfer({ id: 9, state: 'active' })]);
    emit([transfer({ id: 9, state: 'done' }), transfer({ id: 10, state: 'done', direction: 'download' })]);
    emit([transfer({ id: 9, state: 'done' })]);
    expect(onFolderChanged).toHaveBeenCalledOnce();
    expect(onFolderChanged).toHaveBeenCalledWith({
      profileId: 'aws-prod',
      bucket: 'prod-backups-eu',
      prefix: 'backups/2026/10/',
    });
  });

  it('führt Änderungen zusammen und entfernt gemeldete Transfers', () => {
    emit(list);
    emit([transfer({ id: 2, state: 'active', bytesPerSec: 0 })], [5, 7]);
    expect(vm.transfers.map((t) => t.id)).toEqual([1, 2, 3, 4, 6]);
    expect(vm.counts).toEqual({ all: 5, active: 2, waiting: 2, done: 0, failed: 1 });
    expect(vm.waitingPosition(3)).toBe(1);
    expect(vm.rows).toEqual([0, 2, 4, 6, 8]);
    vm.filter = 'failed';
    expect(vm.rows).toEqual([0]);
    expect(vm.visible.map((t) => t.id)).toEqual([6]);
  });

  it('übernimmt beim Start den Stand des Backends', async () => {
    vi.spyOn(backend, 'listTransfers').mockResolvedValue([transfer({ id: 4 }), transfer({ id: 2, state: 'done' })]);
    const other = new TransfersViewModel({ backend, picker: createFakeFilePicker(), onFolderChanged });
    await other.start();
    expect(other.transfers.map((t) => t.id)).toEqual([2, 4]);
    expect(onFolderChanged).toHaveBeenCalledOnce();
  });

  it('summiert das Tempo je Richtung', () => {
    emit([
      transfer({ id: 1, bytesPerSec: 10 }),
      transfer({ id: 2, bytesPerSec: 5, direction: 'download' }),
      transfer({ id: 3, bytesPerSec: 7, direction: 'download' }),
      transfer({ id: 4, bytesPerSec: 99, direction: 'download', state: 'paused' }),
    ]);
    expect(vm.totals.speeds).toEqual({ upload: 10, download: 12 });
    expect(vm.totals.bytesPerSec).toBe(22);
  });

  it('meldet sich ab', async () => {
    const unsubscribe = vi.fn();
    vi.spyOn(backend, 'onTransfers').mockResolvedValue(unsubscribe);
    const other = new TransfersViewModel({ backend, picker: createFakeFilePicker() });
    other.dispose();
    await other.start();
    other.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('Aktionen', () => {
  it('lädt gewählte Dateien in den Zielordner und ignoriert abgebrochene Auswahl', async () => {
    const enqueue = vi.spyOn(backend, 'enqueueUploads');
    await vm.upload(target);
    expect(enqueue).toHaveBeenCalledWith(target, ['C:\\a.bin', 'C:\\b.bin']);
    const empty = new TransfersViewModel({ backend, picker: createFakeFilePicker([]) });
    await empty.upload(target);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('reicht Einzel- und Sammelaktionen an das Backend weiter', async () => {
    const calls = [
      vi.spyOn(backend, 'pauseTransfer'),
      vi.spyOn(backend, 'resumeTransfer'),
      vi.spyOn(backend, 'cancelTransfer'),
      vi.spyOn(backend, 'retryTransfer'),
      vi.spyOn(backend, 'pauseAllTransfers'),
      vi.spyOn(backend, 'resumeAllTransfers'),
      vi.spyOn(backend, 'removeFinishedTransfers'),
    ];
    await vm.pause(1);
    await vm.resume(1);
    await vm.cancel(1);
    await vm.retry(1);
    await vm.pauseAll();
    await vm.resumeAll();
    await vm.removeFinished();
    expect(calls.every((spy) => spy.mock.calls.length === 1)).toBe(true);
  });

  it('zeigt Fehler des Backends an', async () => {
    vi.spyOn(backend, 'enqueueUploads').mockRejectedValue({ kind: 'localFile', message: 'Lokale Datei: fehlt' });
    await vm.uploadPaths(target, ['X:\\fehlt']);
    expect(vm.error?.message).toBe('Lokale Datei: fehlt');
    await vm.pause(1);
    expect(vm.error).toBeNull();
  });

  it('bedient Strg+J, Strg+U und Strg+D', () => {
    const upload = vi.spyOn(vm, 'upload').mockResolvedValue();
    const download = vi.spyOn(vm, 'download').mockResolvedValue();
    const none = { uploadTarget: null, selectedObjects: () => null };
    const full = { uploadTarget: target, selectedObjects: () => selection };
    expect(vm.handleShortcut('j', false, full)).toBe(false);
    expect(vm.handleShortcut('J', true, full)).toBe(true);
    expect(vm.expanded).toBe(true);
    expect(vm.handleShortcut('u', true, none)).toBe(false);
    expect(vm.handleShortcut('d', true, none)).toBe(false);
    expect(vm.handleShortcut('u', true, full)).toBe(true);
    expect(upload).toHaveBeenCalledWith(target);
    expect(vm.handleShortcut('D', true, full)).toBe(true);
    expect(download).toHaveBeenCalledWith(selection);
    expect(vm.handleShortcut('x', true, full)).toBe(false);
    vm.toggle();
    expect(vm.expanded).toBe(false);
  });

  it('lädt die Auswahl in den gewählten Zielordner herunter', async () => {
    const enqueue = vi.spyOn(backend, 'enqueueDownloads');
    await vm.download(selection);
    expect(enqueue).toHaveBeenCalledWith(target, selection.items, FAKE_TARGET_FOLDER);
    const cancelled = new TransfersViewModel({ backend, picker: createFakeFilePicker([], null) });
    await cancelled.download(selection);
    expect(enqueue).toHaveBeenCalledOnce();
    await vm.downloadTo(selection, 'D:\\Backups');
    expect(enqueue).toHaveBeenLastCalledWith(target, selection.items, 'D:\\Backups');
  });

  it('meldet den lokalen Zielordner fertiger Downloads', async () => {
    const onLocalChanged = vi.fn<(dir: string) => void>();
    const other = new TransfersViewModel({ backend, picker: createFakeFilePicker(), onLocalChanged });
    await other.start();
    emit([transfer({ id: 3, state: 'done', direction: 'download', localPath: 'D:\\Ziel\\a.bin' })]);
    emit([transfer({ id: 4, state: 'done' })]);
    expect(onLocalChanged).toHaveBeenCalledExactlyOnceWith('D:\\Ziel');
  });

  it('kopiert innerhalb einer Verbindung und in andere Verbindungen', async () => {
    const enqueue = vi.spyOn(backend, 'enqueueCopies');
    const destination = { ...target, prefix: 'neu/' };
    await vm.copy(selection, destination, true);
    expect(enqueue).toHaveBeenCalledWith(selection, destination, true);
    const other = { ...destination, profileId: 'b2-archiv', bucket: 'archiv' };
    enqueue.mockResolvedValueOnce([7]);
    await vm.copy(selection, other, false);
    expect(enqueue).toHaveBeenLastCalledWith(selection, other, false);
    expect(vm.error).toBeNull();
    await vm.copy(selection, { ...destination, profileId: 'gibt-es-nicht' }, false);
    expect(vm.error?.kind).toBe('profileNotFound');
  });

  it('zeigt Fehler beim Herunterladen an', async () => {
    vi.spyOn(backend, 'enqueueDownloads').mockRejectedValue({ kind: 'network', message: 'weg' });
    await vm.download(selection);
    expect(vm.error?.message).toBe('weg');
  });
});
