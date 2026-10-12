// Adapter: Backend über Tauri-Befehle. Befehlsnamen und Argumente entsprechen
// src-tauri/src/adapters/commands.rs (Tauri wandelt camelCase-Argumente in snake_case).

import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { BackendPort, DeleteProgress, FolderPage, RenameProgress, TransferUpdate } from '../core/backend';

type Invoke = typeof invoke;
type Listen = typeof listen;
type ChannelFactory = <T>() => Channel<T>;

/** Event-Name aus src-tauri/src/adapters/tauri_runtime.rs. */
export const TRANSFERS_EVENT = 'transfers';

export function createTauriBackend(
  call: Invoke = invoke,
  makeChannel: ChannelFactory = () => new Channel(),
  subscribe: Listen = listen,
): BackendPort {
  return {
    listPresets: () => call('list_presets'),
    getSettings: () => call('get_settings'),
    saveSettings: (value) => call('save_settings', { value }),
    listProfiles: () => call('list_profiles'),
    saveProfile: (profile, credentials) => call('save_profile', { profile, credentials }),
    deleteProfile: (id) => call('delete_profile', { id }),
    testConnection: (profile, credentials) => call('test_connection', { profile, credentials }),
    listBuckets: (profileId) => call('list_buckets', { profileId }),
    listFolder(profileId, bucket, prefix, listingId, onPage, options = {}) {
      const channel = makeChannel<FolderPage>();
      channel.onmessage = onPage;
      const fresh = options.fresh ?? false;
      return call('list_folder', { profileId, bucket, prefix, listingId, fresh, onPage: channel });
    },
    cacheStats: () => call('cache_stats'),
    clearListingCache: () => call('clear_listing_cache'),
    listLocalDir: (path) => call('list_local_dir', { path }),
    planSync: (folder, localDir, direction) =>
      call('plan_sync', {
        profileId: folder.profileId,
        bucket: folder.bucket,
        prefix: folder.prefix,
        localDir,
        direction,
      }),
    startSync: (planId) => call('start_sync', { planId }),
    cancelListing: (listingId) => call('cancel_listing', { listingId }),
    prepareDelete: (folder, items) =>
      call('prepare_delete', { profileId: folder.profileId, bucket: folder.bucket, items }),
    deleteObjects(planId, onProgress) {
      const channel = makeChannel<DeleteProgress>();
      channel.onmessage = onProgress;
      return call('delete_objects', { planId, onProgress: channel });
    },
    cancelDelete: (planId) => call('cancel_delete', { planId }),
    discardDelete: (planId) => call('discard_delete', { planId }),
    objectHead: (at) => call('object_head', { ...at }),
    saveObjectMetadata: (at, metadata) => call('save_object_metadata', { ...at, metadata }),
    objectTags: (at) => call('object_tags', { ...at }),
    saveObjectTags: (at, tags) => call('save_object_tags', { ...at, tags }),
    objectVersions: (at) => call('object_versions', { ...at }),
    restoreObjectVersion: (at, versionId) => call('restore_object_version', { ...at, versionId }),
    deleteObjectVersion: (at, versionId) => call('delete_object_version', { ...at, versionId }),
    objectAcl: (at) => call('object_acl', { ...at }),
    presignObject: (at, expiresSecs) => call('presign_object', { ...at, expiresSecs }),
    shareLink: (title, url) => call('share_link', { title, url }),
    createFolder: (folder, name) => call('create_folder', { ...folder, name }),
    renameObject(folder, item, newName, onProgress) {
      const channel = makeChannel<RenameProgress>();
      channel.onmessage = onProgress;
      return call('rename_object', {
        profileId: folder.profileId,
        bucket: folder.bucket,
        item,
        newName,
        onProgress: channel,
      });
    },
    enqueueUploads: (target, paths) => call('enqueue_uploads', { ...target, paths }),
    enqueueDownloads: (folder, items, targetDir) => call('enqueue_downloads', { ...folder, items, targetDir }),
    enqueueCopies: (source, target, move) =>
      call('enqueue_copies', {
        profileId: source.folder.profileId,
        sourceBucket: source.folder.bucket,
        items: source.items,
        targetProfileId: target.profileId,
        targetBucket: target.bucket,
        targetPrefix: target.prefix,
        moveItems: move,
      }),
    listTransfers: () => call('list_transfers'),
    pauseTransfer: (id) => call('pause_transfer', { id }),
    resumeTransfer: (id) => call('resume_transfer', { id }),
    cancelTransfer: (id) => call('cancel_transfer', { id }),
    retryTransfer: (id) => call('retry_transfer', { id }),
    pauseAllTransfers: () => call('pause_all_transfers'),
    resumeAllTransfers: () => call('resume_all_transfers'),
    removeFinishedTransfers: () => call('remove_finished_transfers'),
    onTransfers: (listener) => subscribe<TransferUpdate>(TRANSFERS_EVENT, (event) => listener(event.payload)),
  };
}

/** true, wenn die Seite in der Tauri-WebView läuft und nicht im normalen Browser. */
export function isTauri(win: Window = window): boolean {
  return '__TAURI_INTERNALS__' in win;
}
