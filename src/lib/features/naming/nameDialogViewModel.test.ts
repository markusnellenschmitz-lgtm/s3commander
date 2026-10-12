import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NameDialogViewModel } from './nameDialogViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';
import type { BackendPort, FolderLocation, ObjectSelection, RenameOutcome } from '../../core/backend';

const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX };
const daily = { key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null };
const file = { key: `${BACKUPS_PREFIX}db.tar.zst`, isFolder: false, size: 5, etag: null };
const select = (...items: (typeof daily)[]): ObjectSelection => ({ folder, items });

let backend: BackendPort;
let onChanged: ReturnType<typeof vi.fn<(f: FolderLocation) => void>>;
let vm: NameDialogViewModel;

beforeEach(() => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  onChanged = vi.fn<(f: FolderLocation) => void>();
  vm = new NameDialogViewModel({ backend, onChanged });
});

describe('Neuer Ordner', () => {
  it('prüft den Namen erst nach der ersten Eingabe und legt den Ordner an', async () => {
    vm.openCreateFolder(folder);
    expect([vm.title, vm.submitLabel, vm.locationText]).toEqual([
      'Neuer Ordner',
      'Anlegen',
      `in prod-backups-eu/${BACKUPS_PREFIX}`,
    ]);
    expect(vm.fieldError).toBeNull();
    expect(vm.canSubmit).toBe(false);
    vm.input('a/b');
    expect(vm.fieldError).toBe('Der Name darf keinen Schrägstrich enthalten');
    vm.input('  neu  ');
    expect(vm.canSubmit).toBe(true);
    const create = vi.spyOn(backend, 'createFolder');
    await vm.submit();
    expect(create).toHaveBeenCalledWith(folder, 'neu');
    expect(onChanged).toHaveBeenCalledWith(folder);
    expect(vm.isOpen).toBe(false);
  });

  it('zeigt leere Namen erst nach einem Versuch und Fehler des Backends am Feld', async () => {
    vm.openCreateFolder(folder);
    await vm.submit();
    expect(vm.fieldError).toBe('Bitte einen Namen eingeben');
    vm.input('daily');
    await vm.submit();
    expect(vm.phase).toBe('editing');
    expect(vm.fieldError).toBe('„daily“ gibt es in diesem Ordner schon');
    vm.input('daily2');
    expect(vm.fieldError).toBeNull();
    vm.openCreateFolder(folder);
    expect(vm.name).toBe('daily2');
  });
});

describe('Umbenennen', () => {
  it('übernimmt den alten Namen und benennt Ordner mit Fortschritt um', async () => {
    vm.openRename(select(daily));
    expect([vm.title, vm.name, vm.locationText]).toEqual([
      '„daily“ umbenennen',
      'daily',
      `in prod-backups-eu/${BACKUPS_PREFIX}`,
    ]);
    let finish: (outcome: RenameOutcome) => void = () => {};
    vi.spyOn(backend, 'renameObject').mockImplementation((_, __, ___, onProgress) => {
      onProgress({ copied: 1, total: 3 });
      return new Promise((resolve) => (finish = resolve));
    });
    vm.input('täglich');
    const submitting = vm.submit();
    expect(vm.phase).toBe('working');
    expect(vm.progressText).toBe('1 von 3 kopiert');
    vm.close();
    expect(vm.isOpen).toBe(true);
    finish({ newKey: `${BACKUPS_PREFIX}täglich/`, undeleted: 0 });
    await submitting;
    expect(vm.isOpen).toBe(false);
  });

  it('warnt, wenn Originale nicht gelöscht werden konnten', async () => {
    vm.openRename(select(file));
    vi.spyOn(backend, 'renameObject').mockResolvedValueOnce({ newKey: 'x', undeleted: 2 });
    vm.input('neu.tar.zst');
    await vm.submit();
    expect(vm.phase).toBe('warning');
    expect(vm.warning).toBe('Kopiert, aber 2 Originale ließen sich nicht löschen.');
    expect(onChanged).toHaveBeenCalled();
    vm.close();
    expect(vm.isOpen).toBe(false);
  });

  it('öffnet mit F2 nur für genau einen Eintrag', () => {
    expect(vm.handleShortcut('F3', () => select(file))).toBe(false);
    expect(vm.handleShortcut('F2', () => null)).toBe(false);
    expect(vm.handleShortcut('F2', () => select(file, daily))).toBe(false);
    vm.openRename(select(file, daily));
    expect(vm.isOpen).toBe(false);
    expect(vm.handleShortcut('F2', () => select(file))).toBe(true);
    expect(vm.mode).toBe('rename');
    expect(vm.handleShortcut('F2', () => select(daily))).toBe(false);
    expect(vm.progressText).toBe('');
  });
});
