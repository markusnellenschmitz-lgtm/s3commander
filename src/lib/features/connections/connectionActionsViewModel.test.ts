import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionActionsViewModel } from './connectionActionsViewModel.svelte';
import { BrowserViewModel, bucketNodeId, connectionNodeId } from '../browser/browserViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { isMenuItem } from '../../core/menu';
import type { BackendPort, ConnectionProfile } from '../../core/backend';

let backend: BackendPort;
let browser: BrowserViewModel;
let edit: ReturnType<typeof vi.fn<(profile: ConnectionProfile) => void>>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let vm: ConnectionActionsViewModel;
let openInNewTab: ReturnType<typeof vi.fn<(profileId: string, bucket: string) => void>>;

beforeEach(async () => {
  backend = createFakeBackend({ pageDelayMs: 0 });
  browser = new BrowserViewModel({ backend, schedule: (run) => run() });
  edit = vi.fn<(profile: ConnectionProfile) => void>();
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  openInNewTab = vi.fn<(profileId: string, bucket: string) => void>();
  vm = new ConnectionActionsViewModel({ browser, edit, writeText, openInNewTab });
  await browser.loadProfiles();
});

const ids = () => vm.menu.state?.entries.map((e) => (isMenuItem(e) ? `${e.id}${e.disabled ? '-' : ''}` : '|'));

describe('Kontextmenü im Verbindungsbaum', () => {
  it('bietet für verbundene Verbindungen Trennen und Neu verbinden', () => {
    vm.openForNode(connectionNodeId('aws-prod'), 10, 20);
    expect(browser.activeTreeId).toBe(connectionNodeId('aws-prod'));
    expect(ids()).toEqual(['disconnect', 'reconnect', '|', 'edit', '|', 'delete']);
    vm.menu.run('disconnect');
    expect(browser.connections[0].status).toBe('disconnected');
    vm.openForNode(connectionNodeId('aws-prod'), 10, 20);
    expect(ids()).toEqual(['connect', '|', 'edit', '|', 'delete']);
  });

  it('verbindet, verbindet neu und bearbeitet', async () => {
    const connect = vi.spyOn(browser, 'connect');
    vm.openForNode(connectionNodeId('b2-archiv'), 0, 0);
    vm.menu.run('connect');
    vm.openForNode(connectionNodeId('aws-prod'), 0, 0);
    vm.menu.run('reconnect');
    expect(connect.mock.calls.map(([id]) => id)).toEqual(['b2-archiv', 'aws-prod']);
    vm.openForNode(connectionNodeId('aws-prod'), 0, 0);
    vm.menu.run('edit');
    expect(edit).toHaveBeenCalledWith(browser.connections[0].profile);
  });

  it('sperrt Verbinden, solange eine Verbindung aufgebaut wird', () => {
    browser.connections[1].status = 'connecting';
    vm.openForNode(connectionNodeId('b2-archiv'), 0, 0);
    expect(ids()?.[0]).toBe('connect-');
  });

  it('öffnet Buckets und kopiert ihren Pfad', () => {
    const node = bucketNodeId('aws-prod', 'prod-logs-eu');
    vm.openForNode(node, 0, 0);
    expect(ids()).toEqual(['openBucket', 'openBucketInNewTab', 'copyBucketPath']);
    vm.menu.run('openBucketInNewTab');
    expect(openInNewTab).toHaveBeenCalledWith('aws-prod', 'prod-logs-eu');
    vm.openForNode(node, 0, 0);
    vm.menu.run('copyBucketPath');
    expect(writeText).toHaveBeenCalledWith('s3://prod-logs-eu');
    vm.openForNode(node, 0, 0);
    vm.menu.run('openBucket');
    expect(browser.location?.bucket).toBe('prod-logs-eu');
  });

  it('ignoriert unbekannte Knoten und Aktionen ohne passendes Ziel', () => {
    vm.openForNode('gibt-es-nicht', 0, 0);
    expect(vm.menu.state).toBeNull();
    vm.menu.run('disconnect');
    vm.menu.run('openBucket');
    vm.openForNode(connectionNodeId('aws-prod'), 0, 0);
    vm.menu.run('openBucket');
    expect(browser.location).toBeNull();
    vm.edit('unbekannt');
    expect(edit).not.toHaveBeenCalled();
  });
});

describe('Verbindung löschen', () => {
  it('fragt nach und löscht erst nach Bestätigung', async () => {
    vm.openForNode(connectionNodeId('b2-archiv'), 0, 0);
    vm.menu.run('delete');
    expect(vm.pendingDelete).toEqual({ profileId: 'b2-archiv', name: 'Backblaze B2 Archiv' });
    vm.cancelDelete();
    expect(vm.pendingDelete).toBeNull();
    expect(browser.connections).toHaveLength(2);

    vm.requestDelete('b2-archiv');
    const deleting = vm.confirmDelete();
    expect(vm.deleting).toBe(true);
    vm.cancelDelete();
    expect(vm.pendingDelete).not.toBeNull();
    await deleting;
    expect(vm.pendingDelete).toBeNull();
    expect(browser.connections.map((c) => c.profile.id)).toEqual(['aws-prod']);
  });

  it('zeigt Fehler und ignoriert unbekannte Profile', async () => {
    vi.spyOn(backend, 'deleteProfile').mockRejectedValueOnce({ kind: 'credential', message: 'Speicher gesperrt' });
    vm.requestDelete('aws-prod');
    await vm.confirmDelete();
    expect(vm.deleteError?.message).toBe('Speicher gesperrt');
    expect(vm.pendingDelete).not.toBeNull();
    vm.requestDelete('unbekannt');
    expect(vm.pendingDelete?.profileId).toBe('aws-prod');
    vm.cancelDelete();
    await vm.confirmDelete();
    expect(browser.connections).toHaveLength(2);
  });
});
