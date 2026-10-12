// Fake-Backend für die Browser-Vorschau (npm run dev ohne Tauri) und Komponenten-Tests.
// Verhält sich wie das echte Backend: Profile, Fehler, seitenweises Listing, Abbruch.

import type {
  AppSettings,
  BackendError,
  BackendPort,
  BucketInfo,
  ConnectionProfile,
  FolderPage,
  ObjectEntryDto,
  ProviderPreset,
} from '../core/backend';
import { CANCELLED_KIND } from '../core/backend';
import type { Platform } from '../core/platform';
import { backupsBucket, logsBucket } from './fixtures/buckets';
import { listFolder, paginate } from './fixtures/s3Listing';
import { FakeTransferEngine, fakeLocalPath, type FakeTransferOptions } from './fakeTransfers';
import { baseName, nameError, numberedName, parentOfKey } from '../core/objectName';
import { FakeObjectDetails } from './fakeDetails';
import { DEFAULT_TRANSFER_PREFERENCES, transferErrors } from '../features/settings/settingsRules';
import { FakeListingCache } from './fakeListingCache';
import { FakeLocalFiles } from './fakeLocalFiles';
import { FakeSync } from './fakeSync';

export const FAKE_PAGE_SIZE = 1000;
export const FAKE_LOG_OBJECTS = 50_000;

export const FAKE_PRESETS: ProviderPreset[] = [
  {
    provider: 'aws',
    label: 'AWS S3',
    endpointTemplate: 'https://s3.{region}.amazonaws.com',
    defaultRegion: 'eu-central-1',
    regions: ['eu-central-1', 'eu-west-1', 'us-east-1'],
    addressing: 'virtual-hosted',
    quirks: { urlEncodedListing: true, crc32cChecksums: true },
    selfHosted: false,
  },
  {
    provider: 'minio',
    label: 'MinIO',
    endpointTemplate: '',
    defaultRegion: 'us-east-1',
    regions: [],
    addressing: 'path-style',
    quirks: { urlEncodedListing: true, crc32cChecksums: true },
    selfHosted: true,
  },
  {
    provider: 'cloudflare-r2',
    label: 'Cloudflare R2',
    endpointTemplate: 'https://{account}.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    regions: ['auto'],
    addressing: 'path-style',
    quirks: { urlEncodedListing: false, crc32cChecksums: false },
    selfHosted: false,
  },
  {
    provider: 'hetzner',
    label: 'Hetzner',
    endpointTemplate: 'https://{region}.your-objectstorage.com',
    defaultRegion: 'fsn1',
    regions: ['fsn1', 'nbg1', 'hel1'],
    addressing: 'virtual-hosted',
    quirks: { urlEncodedListing: false, crc32cChecksums: false },
    selfHosted: false,
  },
  {
    provider: 'custom',
    label: 'Benutzerdefiniert',
    endpointTemplate: '',
    defaultRegion: 'us-east-1',
    regions: [],
    addressing: 'path-style',
    quirks: { urlEncodedListing: false, crc32cChecksums: false },
    selfHosted: true,
  },
];

const base = {
  defaultBucket: null,
  timeoutSecs: 60,
  concurrency: 8,
  verifyTls: true,
  caFile: null,
  proxy: null,
  quirks: { urlEncodedListing: false, crc32cChecksums: false },
} satisfies Partial<ConnectionProfile>;

export const FAKE_PROFILES: ConnectionProfile[] = [
  {
    ...base,
    id: 'aws-prod',
    name: 'AWS Produktion',
    provider: 'aws',
    endpoint: 'https://s3.eu-central-1.amazonaws.com',
    region: 'eu-central-1',
    addressing: 'virtual-hosted',
  },
  {
    ...base,
    id: 'b2-archiv',
    name: 'Backblaze B2 Archiv',
    provider: 'custom',
    endpoint: 'https://s3.eu-central-003.backblazeb2.com',
    region: 'eu-central-003',
    addressing: 'virtual-hosted',
  },
];

export const SIGNATURE_ERROR: BackendError = {
  kind: 'service',
  message: 'SignatureDoesNotMatch: Prüfe Secret Key und Region (HTTP 403)',
  service: {
    code: 'SignatureDoesNotMatch',
    message: 'Prüfe Secret Key und Region',
    httpStatus: 403,
    requestId: '7XQ2M9K4PZ1R8T3B',
  },
};

export interface FakeBackendOptions {
  /** Verzögerung je Seite in ms; 0 liefert ohne Wartezeit. */
  pageDelayMs?: number;
  logObjects?: number;
  transfers?: Omit<FakeTransferOptions, 'onFinished'>;
  /** Vorgegaukeltes Betriebssystem; ohne Angabe Windows. */
  platform?: Platform;
}

/** Beispiel für den Hinweis auf erhaltene ältere Versionen im Löschdialog. */
const VERSIONED_BUCKETS: ReadonlySet<string> = new Set(['prod-backups-eu']);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFakeBackend(options: FakeBackendOptions = {}): BackendPort {
  const pageDelayMs = options.pageDelayMs ?? 30;
  const profiles = FAKE_PROFILES.map((p) => ({ ...p }));
  const failingProfiles = new Set(['b2-archiv']);
  const bucketSources = new Map<string, () => ObjectEntryDto[]>([
    ['prod-backups-eu', backupsBucket],
    ['prod-exports-eu', () => []],
    ['prod-logs-eu', () => logsBucket(options.logObjects ?? FAKE_LOG_OBJECTS)],
    ['prod-media-eu', () => []],
    ['terraform-state-eu', () => []],
  ]);
  /** Inhalte werden beim ersten Zugriff erzeugt und nehmen danach Uploads auf. */
  const bucketObjects = new Map<string, ObjectEntryDto[]>();
  const objectsOf = (bucket: string): ObjectEntryDto[] => {
    if (!bucketObjects.has(bucket)) bucketObjects.set(bucket, bucketSources.get(bucket)?.() ?? []);
    return bucketObjects.get(bucket) ?? [];
  };
  const details = new FakeObjectDetails(objectsOf, (bucket) => VERSIONED_BUCKETS.has(bucket));
  /** Kopien, deren Original nach dem Kopieren verschwindet (Verschieben). */
  const moves = new Set<number>();
  const transfers = new FakeTransferEngine({
    ...options.transfers,
    onFinished(transfer) {
      if (transfer.direction === 'download') {
        localFiles.addFile(transfer.localPath, transfer.totalBytes);
        return;
      }
      objectsOf(transfer.bucket).push({
        key: transfer.key,
        size: transfer.totalBytes,
        lastModifiedMs: Date.now(),
        etag: '"fake-upload"',
        storageClass: 'STANDARD',
      });
      const source = transfer.copySource;
      if (source && moves.delete(transfer.id)) {
        const objects = objectsOf(source.bucket);
        objects.splice(
          objects.findIndex((o) => o.key === source.key),
          1,
        );
      }
    },
  });
  const running = new Set<string>();
  let settings: AppSettings = { transfers: { ...DEFAULT_TRANSFER_PREFERENCES }, cache: { enabled: true } };
  const listingCache = new FakeListingCache();
  const localFiles = new FakeLocalFiles();
  const syncs = new FakeSync();
  /** Vorbereitete Löschaufträge: genau diese Keys werden gelöscht. */
  const deletePlans = new Map<string, { bucket: string; keys: Set<string> }>();
  let nextDeletePlan = 1;
  const cancelled = new Set<string>();

  const isTaken = (bucket: string, key: string) =>
    objectsOf(bucket).some((o) => (key.endsWith('/') ? o.key.startsWith(key) : o.key === key));

  /** Erster freier Key für `name` im Ordner wie im Backend: `name`, sonst `name (2)` … */
  function freeKey(bucket: string, prefix: string, name: string, isFolder: boolean): string {
    const suffix = isFolder ? '/' : '';
    for (let n = 1; ; n++) {
      const key = `${prefix}${n === 1 ? name : numberedName(name, n)}${suffix}`;
      if (!isTaken(bucket, key)) return key;
    }
  }

  /** Wirft wie das Backend, wenn der Name ungültig ist oder unter dem Key schon etwas liegt. */
  function ensureFreeName(bucket: string, prefix: string, name: string, isFolder: boolean): string {
    const error = nameError(name, prefix, isFolder);
    if (error) throw { kind: 'invalidName', message: error };
    const key = `${prefix}${name}${isFolder ? '/' : ''}`;
    if (isTaken(bucket, key)) throw { kind: 'nameTaken', message: `„${name}“ gibt es in diesem Ordner schon` };
    return key;
  }

  /** Wie das Rust-Backend: gespeicherte Seiten vor den frischen, mit dem Zeitpunkt des Listings. */
  function sendCachedPages(profileId: string, bucket: string, prefix: string, onPage: (page: FolderPage) => void) {
    const cached = listingCache.load(profileId, bucket, prefix);
    for (const page of cached?.pages ?? []) onPage({ ...page, cachedMs: cached?.fetchedMs ?? null });
  }

  function ensureProfile(id: string): ConnectionProfile {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) throw { kind: 'profileNotFound', message: `Verbindungsprofil ${id} gibt es nicht mehr` };
    if (failingProfiles.has(id)) throw SIGNATURE_ERROR;
    return profile;
  }

  return {
    platform: options.platform ?? 'windows',
    listPresets: async () => FAKE_PRESETS,
    getSettings: async () => structuredClone(settings),
    async saveSettings(value) {
      const [error] = Object.values(transferErrors(value.transfers));
      if (error) throw { kind: 'invalidSettings', message: error };
      settings = structuredClone(value);
      return structuredClone(settings);
    },
    listProfiles: async () => profiles.map((p) => ({ ...p })),
    async saveProfile(profile) {
      const index = profiles.findIndex((p) => p.id === profile.id);
      if (index >= 0) profiles[index] = { ...profile };
      else profiles.push({ ...profile });
      failingProfiles.delete(profile.id);
    },
    async deleteProfile(id) {
      const index = profiles.findIndex((p) => p.id === id);
      if (index >= 0) profiles.splice(index, 1);
      listingCache.forgetProfile(id);
    },
    async testConnection(profile, credentials) {
      if (credentials?.secretAccessKey === 'falsch') throw SIGNATURE_ERROR;
      return { bucketCount: profile.defaultBucket ? null : bucketSources.size, latencyMs: 142 };
    },
    async listBuckets(profileId): Promise<BucketInfo[]> {
      const profile = ensureProfile(profileId);
      if (profile.defaultBucket) return [{ name: profile.defaultBucket, createdMs: null }];
      return [...bucketSources.keys()].map((name) => ({ name, createdMs: null }));
    },
    async listFolder(profileId, bucket, prefix, listingId, onPage, options = {}) {
      ensureProfile(profileId);
      const useCache = settings.cache.enabled;
      if (useCache && !options.fresh) sendCachedPages(profileId, bucket, prefix, onPage);
      const objects = objectsOf(bucket);
      const pages = paginate(listFolder(objects, prefix), FAKE_PAGE_SIZE);
      const summary = { pages: 0, objects: 0, prefixes: 0 };
      running.add(listingId);
      try {
        for (const page of pages) {
          if (pageDelayMs > 0) await wait(pageDelayMs);
          if (cancelled.delete(listingId)) throw { kind: CANCELLED_KIND, message: 'Vorgang abgebrochen' };
          onPage({ ...page, cachedMs: null });
          summary.pages++;
          summary.objects += page.objects.length;
          summary.prefixes += page.prefixes.length;
        }
        if (useCache) listingCache.store(profileId, bucket, prefix, pages, Date.now());
        return summary;
      } finally {
        running.delete(listingId);
      }
    },
    listLocalDir: async (path) => (path ? localFiles.list(path) : localFiles.roots()),
    async planSync(folder, localDir, direction) {
      ensureProfile(folder.profileId);
      const remote = objectsOf(folder.bucket)
        .filter((o) => o.key.startsWith(folder.prefix) && !o.key.endsWith('/'))
        .map((o) => ({
          key: o.key,
          relative: o.key.slice(folder.prefix.length),
          size: o.size,
          modifiedMs: o.lastModifiedMs,
        }));
      return syncs.plan(folder, localDir, direction, localFiles.walk(localDir), remote);
    },
    async startSync(planId) {
      const { folder, uploads, downloads } = syncs.take(planId);
      return [
        ...transfers.enqueueUploadFiles(folder.profileId, folder.bucket, uploads),
        ...(downloads.length > 0 ? transfers.enqueueDownloads(folder, downloads) : []),
      ];
    },
    cacheStats: async () => listingCache.stats(),
    clearListingCache: async () => listingCache.clear(),
    async cancelListing(listingId) {
      if (!running.has(listingId)) return false;
      cancelled.add(listingId);
      return true;
    },
    async prepareDelete(folder, items) {
      ensureProfile(folder.profileId);
      const selected = objectsOf(folder.bucket).filter((o) =>
        items.some((item) => (item.isFolder ? o.key.startsWith(item.key) : o.key === item.key)),
      );
      const planId = `delete-${nextDeletePlan++}`;
      deletePlans.set(planId, { bucket: folder.bucket, keys: new Set(selected.map((o) => o.key)) });
      const bytes = selected.reduce((sum, o) => sum + o.size, 0);
      return { planId, objects: selected.length, bytes, versioned: VERSIONED_BUCKETS.has(folder.bucket) };
    },
    async deleteObjects(planId, onProgress) {
      const plan = deletePlans.get(planId);
      if (!plan) throw { kind: 'deletePlanNotFound', message: `Der Löschauftrag ${planId} ist nicht mehr gültig` };
      deletePlans.delete(planId);
      const objects = objectsOf(plan.bucket);
      const kept = objects.filter((o) => !plan.keys.has(o.key));
      const deleted = objects.length - kept.length;
      // Schleife statt splice(...kept): bei Millionen Objekten würde der Stack überlaufen.
      objects.length = 0;
      for (const object of kept) objects.push(object);
      onProgress({ processed: deleted, total: deleted });
      return { deleted, failedCount: 0, failures: [], cancelled: false };
    },
    cancelDelete: async () => false,
    async discardDelete(planId) {
      deletePlans.delete(planId);
    },
    objectHead: async (at) => details.head(at),
    saveObjectMetadata: async (at, metadata) => details.saveMetadata(at, metadata),
    objectTags: async (at) => details.tags(at),
    saveObjectTags: async (at, tags) => details.saveTags(at, tags),
    objectVersions: async (at) => details.versions(at),
    restoreObjectVersion: async (at, versionId) => details.restoreVersion(at, versionId),
    deleteObjectVersion: async (at, versionId) => details.deleteVersion(at, versionId),
    objectAcl: async (at) => details.acl(at),
    presignObject: async (at, expiresSecs) => details.presign(at, expiresSecs),
    // Ohne Windows gibt es keinen Teilen-Dialog; die Vorschau nimmt den Link stillschweigend an.
    shareLink: async () => {},
    async createFolder(folder, name) {
      ensureProfile(folder.profileId);
      const key = ensureFreeName(folder.bucket, folder.prefix, name, true);
      objectsOf(folder.bucket).push({ key, size: 0, lastModifiedMs: Date.now(), etag: null, storageClass: 'STANDARD' });
      return key;
    },
    async renameObject(folder, item, newName, onProgress) {
      ensureProfile(folder.profileId);
      const parent = parentOfKey(item.key);
      if (newName === baseName(item.key)) return { newKey: item.key, undeleted: 0 };
      const newKey = ensureFreeName(folder.bucket, parent, newName, item.isFolder);
      const moving = objectsOf(folder.bucket).filter((o) =>
        item.isFolder ? o.key.startsWith(item.key) : o.key === item.key,
      );
      moving.forEach((object, index) => {
        object.key = newKey + object.key.slice(item.key.length);
        onProgress({ copied: index + 1, total: moving.length });
      });
      return { newKey, undeleted: 0 };
    },
    async enqueueCopies(source, target, move) {
      ensureProfile(source.folder.profileId);
      ensureProfile(target.profileId);
      const sameConnection = source.folder.profileId === target.profileId;
      const sameBucket = sameConnection && source.folder.bucket === target.bucket;
      const copies = source.items.flatMap((item) => {
        if (sameBucket && move && parentOfKey(item.key) === target.prefix) return [];
        if (sameBucket && item.isFolder && target.prefix.startsWith(item.key)) {
          throw {
            kind: 'copyIntoItself',
            message: `„${baseName(item.key)}“ kann nicht in sich selbst eingefügt werden`,
          };
        }
        const top = freeKey(target.bucket, target.prefix, baseName(item.key), item.isFolder);
        const objects = item.isFolder
          ? objectsOf(source.folder.bucket).filter((o) => o.key.startsWith(item.key))
          : [{ key: item.key, size: item.size }];
        return objects.map((o) => ({
          source: { bucket: source.folder.bucket, key: o.key },
          bucket: target.bucket,
          key: top + o.key.slice(item.key.length),
          size: o.size,
        }));
      });
      const ids = transfers.enqueueCopies(target.profileId, copies, sameConnection ? null : source.folder.profileId);
      if (move) for (const id of ids) moves.add(id);
      return ids;
    },
    enqueueUploads: async (target, paths) => transfers.enqueue(target, paths),
    async enqueueDownloads(folder, items, targetDir) {
      ensureProfile(folder.profileId);
      const objects = items.flatMap((item) =>
        item.isFolder
          ? objectsOf(folder.bucket).filter((o) => o.key.startsWith(item.key) && !o.key.endsWith('/'))
          : [{ key: item.key, size: item.size }],
      );
      const downloads = objects.map((o) => ({
        key: o.key,
        size: o.size,
        localPath: fakeLocalPath(targetDir, folder.prefix, o.key),
      }));
      return transfers.enqueueDownloads(folder, downloads);
    },
    listTransfers: async () => transfers.list(),
    pauseTransfer: async (id) => transfers.pause(id),
    resumeTransfer: async (id) => transfers.resume(id),
    cancelTransfer: async (id) => transfers.cancel(id),
    retryTransfer: async (id) => transfers.retry(id),
    pauseAllTransfers: async () => transfers.pauseAll(),
    resumeAllTransfers: async () => transfers.resumeAll(),
    removeFinishedTransfers: async () => transfers.removeFinished(),
    onTransfers: async (listener) => transfers.subscribe(listener),
  };
}
