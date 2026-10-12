import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteViewModel } from './deleteViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';
import type { BackendPort, DeleteOutcome, FolderLocation, ObjectSelection } from '../../core/backend';

const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX };
const selection: ObjectSelection = {
  folder,
  items: [{ key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null }],
};

let backend: BackendPort;
let onDeleted: ReturnType<typeof vi.fn<(f: FolderLocation) => void>>;
let vm: DeleteViewModel;

beforeEach(() => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  onDeleted = vi.fn<(f: FolderLocation) => void>();
  vm = new DeleteViewModel({ backend, onDeleted });
});

/** Promise, die der Test von außen auflöst. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('DeleteViewModel', () => {
  it('ermittelt die Vorschau, löscht nach Bestätigung und schließt', async () => {
    const opening = vm.open(selection);
    expect(vm.phase).toBe('preparing');
    expect(vm.canConfirm).toBe(false);
    await opening;
    expect(vm.phase).toBe('confirm');
    expect(vm.preview?.objects).toBe(1);
    expect(vm.canConfirm).toBe(true);
    await vm.open(selection);
    expect(vm.phase).toBe('confirm');

    await vm.confirm();
    expect(vm.phase).toBe('closed');
    expect(vm.selection).toBeNull();
    expect(onDeleted).toHaveBeenCalledWith(folder);
  });

  it('zeigt Fortschritt während des Löschens und hält auf Wunsch an', async () => {
    await vm.open(selection);
    const done = deferred<DeleteOutcome>();
    let report: (p: { processed: number; total: number }) => void = () => {};
    vi.spyOn(backend, 'deleteObjects').mockImplementation((_, onProgress) => {
      report = onProgress;
      return done.promise;
    });
    const cancel = vi.spyOn(backend, 'cancelDelete');
    const confirming = vm.confirm();
    expect(vm.phase).toBe('deleting');
    expect(vm.progress).toEqual({ processed: 0, total: 1 });
    report({ processed: 1, total: 1 });
    expect(vm.progress).toEqual({ processed: 1, total: 1 });
    vm.cancel();
    expect(cancel).toHaveBeenCalledWith(vm.preview?.planId);
    expect(vm.phase).toBe('deleting');
    done.resolve({ deleted: 0, failedCount: 0, failures: [], cancelled: true });
    await confirming;
    expect(vm.phase).toBe('result');
    expect(vm.outcome?.cancelled).toBe(true);
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('zeigt abgelehnte Objekte und Fehler als Ergebnis', async () => {
    await vm.open(selection);
    const failures = [{ key: 'k', code: 'AccessDenied', message: '' }];
    vi.spyOn(backend, 'deleteObjects').mockResolvedValueOnce({
      deleted: 0,
      failedCount: 1,
      failures,
      cancelled: false,
    });
    await vm.confirm();
    expect(vm.phase).toBe('result');
    expect(vm.outcome?.failures).toEqual(failures);
    vm.cancel();
    expect(vm.phase).toBe('closed');

    await vm.open(selection);
    vi.spyOn(backend, 'deleteObjects').mockRejectedValueOnce({ kind: 'network', message: 'weg' });
    await vm.confirm();
    expect(vm.error?.message).toBe('weg');
    expect(onDeleted).toHaveBeenCalledTimes(2);
  });

  it('zeigt Fehler der Vorschau und verwirft abgebrochene Vorschauen', async () => {
    vi.spyOn(backend, 'prepareDelete').mockRejectedValueOnce({ kind: 'timeout', message: 'zu langsam' });
    await vm.open(selection);
    expect(vm.phase).toBe('result');
    expect(vm.error?.message).toBe('zu langsam');
    vm.cancel();

    const discard = vi.spyOn(backend, 'discardDelete');
    const opening = vm.open(selection);
    vm.cancel();
    expect(vm.phase).toBe('closed');
    await opening;
    expect(vm.phase).toBe('closed');
    expect(discard).toHaveBeenCalledOnce();

    await vm.open(selection);
    vm.cancel();
    expect(discard).toHaveBeenCalledTimes(2);
  });

  it('lehnt die Bestätigung ohne Objekte oder außerhalb der Bestätigung ab', async () => {
    const remove = vi.spyOn(backend, 'deleteObjects');
    await vm.confirm();
    await vm.open({ folder, items: [{ key: 'gibt-es-nicht', isFolder: false, size: 0, etag: null }] });
    expect(vm.canConfirm).toBe(false);
    await vm.confirm();
    expect(remove).not.toHaveBeenCalled();
  });

  it('öffnet mit Entf nur bei Auswahl und geschlossenem Dialog', async () => {
    const open = vi.spyOn(vm, 'open');
    expect(vm.handleShortcut('Backspace', () => selection)).toBe(false);
    expect(vm.handleShortcut('Delete', () => null)).toBe(false);
    expect(vm.handleShortcut('Delete', () => selection)).toBe(true);
    expect(open).toHaveBeenCalledWith(selection);
    expect(vm.handleShortcut('Delete', () => selection)).toBe(false);
  });
});
