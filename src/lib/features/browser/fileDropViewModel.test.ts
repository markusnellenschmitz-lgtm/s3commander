import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FolderLocation } from '../../core/backend';
import { FileDropViewModel, type DropPoint } from './fileDropViewModel.svelte';
import { BrowserViewModel } from './browserViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';
import { controlledDrops, type ControlledDrops } from '../../../test/drops';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let drops: ControlledDrops;
let browser: BrowserViewModel;
type Upload = (target: FolderLocation, paths: string[]) => Promise<void>;
let upload: Mock<Upload>;
let vm: FileDropViewModel;
let point: DropPoint;

beforeEach(async () => {
  drops = controlledDrops();
  browser = new BrowserViewModel({ backend: createFakeBackend({ pageDelayMs: 0 }), schedule: (run) => run() });
  upload = vi.fn<Upload>().mockResolvedValue(undefined);
  vm = new FileDropViewModel({ drops, browser, upload });
  point = { inTable: true, rowIndex: null };
  vm.setHitTest(() => point);
  await vm.start();
});

async function openBackups() {
  await browser.loadProfiles();
  browser.openBucket('aws-prod', 'prod-backups-eu');
  browser.openPrefix(BACKUPS_PREFIX);
  await settle();
}

const enter = (paths = ['C:\\a.bin', 'C:\\Fotos']) => drops.emit({ type: 'enter', paths, x: 10, y: 20 });

describe('FileDropViewModel', () => {
  it('zeigt beim Hineinziehen Anzahl und Position und verwirft beim Verlassen', () => {
    enter();
    expect(vm.active).toBe(true);
    expect(vm.countText).toBe('2 Elemente');
    expect([vm.x, vm.y]).toEqual([10, 20]);
    drops.emit({ type: 'over', paths: [], x: 30, y: 40 });
    expect([vm.x, vm.y]).toEqual([30, 40]);
    drops.emit({ type: 'leave', paths: [], x: 0, y: 0 });
    expect(vm.active).toBe(false);
    enter(['C:\\eins.txt']);
    expect(vm.countText).toBe('1 Element');
  });

  it('verlangt einen offenen Ordner', () => {
    enter();
    expect(vm.target).toBeNull();
    expect(vm.targetText).toBe('Zuerst einen Bucket oder Ordner öffnen');
    drops.emit({ type: 'drop', paths: ['C:\\a.bin'], x: 1, y: 1 });
    expect(upload).not.toHaveBeenCalled();
    expect(vm.active).toBe(false);
  });

  it('lädt über der Liste in den offenen Ordner hoch und hebt die Tabelle hervor', async () => {
    await openBackups();
    enter();
    expect(vm.highlightsTable).toBe(true);
    expect(vm.targetText).toBe(`Hochladen nach prod-backups-eu/${BACKUPS_PREFIX}`);
    drops.emit({ type: 'drop', paths: ['C:\\a.bin'], x: 1, y: 1 });
    expect(upload).toHaveBeenCalledWith({ profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX }, [
      'C:\\a.bin',
    ]);
  });

  it('lädt über einer Ordnerzeile in diesen Ordner hoch und markiert nur die Zeile', async () => {
    await openBackups();
    point = { inTable: true, rowIndex: 0 };
    enter();
    const daily = browser.source.get(0)!;
    expect(vm.folder?.key).toBe(`${BACKUPS_PREFIX}daily/`);
    expect(vm.rowClass(daily)).toBe('is-drop');
    expect(vm.rowClass(browser.source.get(1)!)).toBe('');
    expect(vm.highlightsTable).toBe(false);
    drops.emit({ type: 'drop', paths: ['C:\\x'], x: 1, y: 1 });
    expect(upload.mock.calls[0][0].prefix).toBe(`${BACKUPS_PREFIX}daily/`);
    expect(vm.rowClass(daily)).toBe('');
  });

  it('behandelt Dateizeilen wie den offenen Ordner', async () => {
    await openBackups();
    point = { inTable: true, rowIndex: 5 };
    enter();
    expect(vm.folder).toBeUndefined();
    expect(vm.target?.prefix).toBe(BACKUPS_PREFIX);
  });

  it('lädt außerhalb der Liste nichts hoch', async () => {
    await openBackups();
    point = { inTable: false, rowIndex: null };
    enter();
    expect(vm.targetText).toBe('Zum Hochladen über der Liste ablegen');
    drops.emit({ type: 'drop', paths: ['C:\\a'], x: 1, y: 1 });
    expect(upload).not.toHaveBeenCalled();
  });

  it('ignoriert Drops ohne Pfade und meldet sich ab', async () => {
    await openBackups();
    drops.emit({ type: 'drop', paths: [], x: 1, y: 1 });
    expect(upload).not.toHaveBeenCalled();
    vm.dispose();
    expect(drops.subscribed).toBe(false);
    vm.dispose();
  });

  it('kommt ohne gemeldeten Hit-Test aus', async () => {
    const plain = new FileDropViewModel({ drops: controlledDrops(), browser, upload });
    plain.handle({ type: 'over', paths: [], x: 1, y: 1 });
    expect(plain.point).toEqual({ inTable: false, rowIndex: null });
  });
});
