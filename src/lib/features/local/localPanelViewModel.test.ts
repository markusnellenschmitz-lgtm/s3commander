import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalPanelViewModel, THIS_PC, toEntry } from './localPanelViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import type { BackendPort } from '../../core/backend';

let backend: BackendPort;
let vm: LocalPanelViewModel;

const names = () => Array.from({ length: vm.source.length }, (_, i) => vm.source.get(i)?.name);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  vm = new LocalPanelViewModel({ backend });
});

describe('LocalPanelViewModel', () => {
  it('zeigt erst die Laufwerke und öffnet Ordner bis hinunter zu Dateien', async () => {
    vm.ensureStarted();
    await settle();
    expect(names()).toEqual(['C:', 'D:']);
    expect([vm.tableLabel, vm.canGoUp, vm.crumbs]).toEqual([THIS_PC, false, []]);
    vm.openEntry(vm.source.get(1)!);
    await settle();
    expect(names()).toEqual(['Backups']);
    await vm.open('D:\\Backups\\db-prod');
    expect(names()).toEqual([
      'alt',
      'checksums.sha256',
      'db-incr-20261012-0600.tar.zst',
      'db-incr-20261012-1200.tar.zst',
    ]);
    expect(vm.crumbs.map((c) => c.label)).toEqual(['D:', 'Backups', 'db-prod']);
    expect(vm.tableLabel).toBe('Lokal: D:\\Backups\\db-prod');
    vm.openEntry(vm.source.get(1)!);
    vm.ensureStarted();
    expect(vm.path).toBe('D:\\Backups\\db-prod');
  });

  it('geht hoch, lädt neu und sortiert', async () => {
    await vm.open('D:\\Backups\\db-prod');
    vm.goUp();
    await settle();
    expect(vm.path).toBe('D:\\Backups');
    expect(vm.handleShortcut('ArrowUp', true)).toBe(true);
    await settle();
    expect(vm.path).toBe('D:\\');
    expect(vm.handleShortcut('Backspace', false)).toBe(true);
    await settle();
    expect(vm.path).toBeNull();
    vm.goUp();
    const list = vi.spyOn(backend, 'listLocalDir');
    expect(vm.handleShortcut('F5', false)).toBe(true);
    expect(list).toHaveBeenCalledWith(null);
    expect(vm.handleShortcut('x', false)).toBe(false);
    await vm.open('D:\\Backups\\db-prod');
    vm.changeSort({ column: 'size', dir: -1 });
    expect(vm.source.get(0)?.name).toBe('alt');
    expect(vm.source.get(1)?.name).toBe('db-incr-20261012-1200.tar.zst');
  });

  it('liefert die Auswahl als Pfade, nur innerhalb eines Ordners', async () => {
    vm.ensureStarted();
    await settle();
    vm.selection.set('D:\\', true);
    expect(vm.selectedPaths).toEqual([]);
    await vm.open('D:\\Backups\\db-prod');
    vm.selection.set('D:\\Backups\\db-prod\\checksums.sha256', true);
    expect(vm.selectedPaths).toEqual(['D:\\Backups\\db-prod\\checksums.sha256']);
    expect(vm.selectedBytes).toBe(412);
  });

  it('meldet nicht lesbare Ordner und verwirft veraltete Antworten', async () => {
    await vm.open('Q:\\gibt-es-nicht');
    expect(vm.error?.message).toContain('Q:\\gibt-es-nicht');
    expect(vm.source.length).toBe(0);
    let finish: () => void = () => {};
    vi.spyOn(backend, 'listLocalDir').mockImplementationOnce(
      () => new Promise((_, reject) => (finish = () => reject(new Error('zu spät')))),
    );
    const slow = vm.open('D:\\');
    await vm.open('C:\\');
    finish();
    await slow;
    expect([vm.path, vm.error]).toEqual(['C:\\', null]);
    expect(names()).toEqual(['Daten']);
  });

  it('lädt nach Downloads nur neu, wenn der Ordner betroffen ist, und nur einmal', async () => {
    await vm.open('D:\\Backups');
    const list = vi.spyOn(backend, 'listLocalDir');
    vm.refreshIfShowing('C:\\Daten');
    vm.refreshIfShowing('D:\\Backups\\neu');
    vm.refreshIfShowing('D:\\Backups');
    await settle();
    expect(list).toHaveBeenCalledOnce();
    await vm.open(null);
    vm.refreshIfShowing('D:\\Backups');
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('stellt lokale Einträge wie Objekte dar', () => {
    expect(toEntry({ name: 'a.txt', path: 'C:\\a.txt', isDir: false, size: 3, modifiedMs: null })).toEqual({
      key: 'C:\\a.txt',
      name: 'a.txt',
      isPrefix: false,
      size: 3,
      lastModified: undefined,
    });
    expect(toEntry({ name: 'C:', path: 'C:\\', isDir: true, size: 0, modifiedMs: 5 }).size).toBeUndefined();
  });
});
