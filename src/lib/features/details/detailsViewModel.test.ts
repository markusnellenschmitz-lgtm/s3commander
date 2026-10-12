import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DetailsViewModel } from './detailsViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';
import type { BackendPort, FolderLocation, ObjectHead } from '../../core/backend';
import type { S3Entry } from '../objects/entry';

const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: `${BACKUPS_PREFIX}daily/` };
const KEY = `${BACKUPS_PREFIX}daily/db-incr-20261011-0600.tar.zst`;
const file: S3Entry = { key: KEY, name: 'db-incr-20261011-0600.tar.zst', isPrefix: false, size: 1 };
const dir: S3Entry = { key: `${BACKUPS_PREFIX}daily/x/`, name: 'x/', isPrefix: true };

let backend: BackendPort;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let onChanged: ReturnType<typeof vi.fn<(f: FolderLocation) => void>>;
let vm: DetailsViewModel;

beforeEach(() => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  onChanged = vi.fn<(f: FolderLocation) => void>();
  vm = new DetailsViewModel({ backend, writeText, onChanged, now: () => 0 });
});

async function showFile() {
  await vm.show([file], folder);
}

describe('Auswahl', () => {
  it('zeigt Hinweise statt Details, wenn nicht genau eine Datei gewählt ist', () => {
    vm.show([], folder);
    expect(vm.placeholder).toMatch(/Wähle eine Datei/);
    vm.show([file, dir], folder);
    expect(vm.placeholder).toBe('2 Einträge ausgewählt. Wähle eine einzelne Datei.');
    vm.show([dir], folder);
    expect(vm.placeholder).toMatch(/Ordner/);
    vm.show([file], null);
    expect([vm.target, vm.entry]).toEqual([null, null]);
  });

  it('lädt alle Abschnitte und lädt dieselbe Datei nicht erneut', async () => {
    const head = vi.spyOn(backend, 'objectHead');
    await showFile();
    expect(vm.placeholder).toBeNull();
    expect(vm.head.value?.contentType).toBe('application/zstd');
    expect(vm.versions.value).toHaveLength(3);
    expect(vm.acl.value?.owner).toBe('ops-team');
    expect(vm.share.url).toContain('X-Amz-Expires=86400');
    expect(vm.metadata.rows.map((r) => r.name)).toEqual(['cache-control']);
    await vm.show([file], folder);
    expect(head).toHaveBeenCalledOnce();
  });

  it('zeigt Ladefehler je Abschnitt und verwirft verspätete Antworten', async () => {
    vi.spyOn(backend, 'objectAcl').mockRejectedValueOnce({ kind: 'service', message: 'AccessDenied' });
    await showFile();
    expect(vm.acl.error?.message).toBe('AccessDenied');
    expect(vm.head.value).not.toBeNull();

    let resolveHead: (head: ObjectHead) => void = () => {};
    vi.spyOn(backend, 'objectHead').mockReturnValueOnce(new Promise((r) => (resolveHead = r)));
    const other = { ...file, key: `${KEY}.alt`, name: 'alt' };
    const pending = vm.show([other], folder);
    void vm.show([], folder);
    resolveHead({
      size: 9,
      contentType: null,
      etag: null,
      storageClass: null,
      lastModifiedMs: null,
      versionId: null,
      metadata: [],
      encryption: null,
    });
    await pending;
    expect(vm.head.value).toBeNull();
    await vm.reload();
  });
});

describe('Bedienung', () => {
  it('öffnet und schließt per Alt+Enter und klappt Abschnitte', () => {
    expect(vm.handleShortcut('Enter', false)).toBe(false);
    expect(vm.handleShortcut('Enter', true)).toBe(true);
    expect(vm.isOpen).toBe(true);
    vm.close();
    expect(vm.isOpen).toBe(false);
    vm.toggleSection('permissions');
    expect(vm.collapsed.permissions).toBe(false);
  });

  it('speichert Metadaten, lädt neu und meldet die Änderung', async () => {
    await showFile();
    await vm.saveMetadata();
    const save = vi.spyOn(backend, 'saveObjectMetadata');
    expect(save).not.toHaveBeenCalled();
    vm.metadata.add();
    vm.metadata.setName(vm.metadata.rows.at(-1)!.id, 'x-amz-meta-retention');
    vm.metadata.setValue(vm.metadata.rows.at(-1)!.id, '90d');
    await vm.saveMetadata();
    expect(save).toHaveBeenCalledWith({ profileId: 'aws-prod', bucket: 'prod-backups-eu', key: KEY }, [
      { name: 'cache-control', value: 'no-store' },
      { name: 'x-amz-meta-retention', value: '90d' },
    ]);
    expect(onChanged).toHaveBeenCalledWith(folder);
    expect(vm.metadata.changeCount).toBe(0);
    expect(vm.versions.value?.[0].isLatest).toBe(true);
  });

  it('zeigt Fehler beim Speichern im Abschnitt', async () => {
    await showFile();
    vi.spyOn(backend, 'saveObjectMetadata').mockRejectedValueOnce({ kind: 'service', message: 'kaputt' });
    vm.metadata.edit(vm.metadata.rows[0].id);
    vm.metadata.setValue(vm.metadata.rows[0].id, 'max-age=1');
    await vm.saveMetadata();
    expect(vm.errorFor('metadata')?.message).toBe('kaputt');
    expect(vm.errorFor('tags')).toBeNull();
  });

  it('fügt Tags hinzu und entfernt sie', async () => {
    await showFile();
    await vm.addTag();
    vm.startTag();
    expect(vm.tagDraftError).not.toBeNull();
    vm.tagDraft = { key: ' env ', value: ' prod ' };
    await vm.addTag();
    expect(vm.tags.value).toEqual([{ key: 'env', value: 'prod' }]);
    expect(vm.tagDraft).toBeNull();
    vm.startTag();
    vm.cancelTag();
    expect(vm.tagDraftError).toBeNull();
    await vm.removeTag('env');
    expect(vm.tags.value).toEqual([]);
  });

  it('stellt Versionen wieder her und löscht sie nach Rückfrage', async () => {
    await showFile();
    await vm.restoreVersion('p7Kd2sVb9QeR1aXc');
    expect(vm.versions.value).toHaveLength(4);
    const marker = vm.versions.value!.find((v) => v.isDeleteMarker)!;
    vm.requestVersionDelete(marker);
    vm.cancelVersionDelete();
    expect(vm.pendingVersionDelete).toBeNull();
    vm.requestVersionDelete(marker);
    await vm.confirmVersionDelete();
    expect(vm.pendingVersionDelete).toBeNull();
    expect(vm.versions.value!.some((v) => v.isDeleteMarker)).toBe(false);
    await vm.confirmVersionDelete();
  });

  it('erzeugt Links mit gewählter Gültigkeit, teilt sie mit dem Dateinamen und kopiert Texte', async () => {
    await vm.share.setDuration(60);
    await showFile();
    await vm.share.setDuration(3600);
    expect(vm.share.url).toContain('X-Amz-Expires=3600');
    const shareLink = vi.spyOn(backend, 'shareLink');
    await vm.shareWithWindows();
    expect(shareLink).toHaveBeenCalledWith('db-incr-20261011-0600.tar.zst', vm.share.url);
    await vm.copy('k');
    expect(writeText).toHaveBeenLastCalledWith('k');
    await vm.copyPresignedUrl({ ...folder, key: KEY });
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('X-Amz-Expires=86400'));
    vi.spyOn(backend, 'presignObject').mockRejectedValueOnce({ kind: 'unexpected', message: 'nein' });
    await vm.copyPresignedUrl({ ...folder, key: KEY });
    expect(vm.errorFor('share')?.message).toBe('nein');
  });

  it('teilt und kopiert ohne Link nichts und arbeitet ohne Ziel nicht', async () => {
    const shareLink = vi.spyOn(backend, 'shareLink');
    await vm.shareWithWindows();
    await vm.share.copy();
    await vm.restoreVersion('x');
    expect(shareLink).not.toHaveBeenCalled();
    await vm.reload();
    expect(writeText).not.toHaveBeenCalled();
  });
});
