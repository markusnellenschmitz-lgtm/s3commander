// Port zum Backend. Die Typen spiegeln die serialisierten Rust-Typen (camelCase).
// Implementierungen: infrastructure/tauriBackend (echt), infrastructure/fakeBackend (Browser, Tests).

import type { Platform } from './platform';

export type Provider =
  'aws' | 'minio' | 'backblaze-b2' | 'cloudflare-r2' | 'wasabi' | 'hetzner' | 'ceph' | 'garage' | 'custom';

export type Addressing = 'virtual-hosted' | 'path-style';

export interface Quirks {
  urlEncodedListing: boolean;
  crc32cChecksums: boolean;
}

export interface ProviderPreset {
  provider: Provider;
  label: string;
  /** Platzhalter {region} und {account}; leer bei selbst gehosteten Diensten. */
  endpointTemplate: string;
  defaultRegion: string;
  regions: string[];
  addressing: Addressing;
  quirks: Quirks;
  selfHosted: boolean;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  provider: Provider;
  endpoint: string;
  region: string;
  defaultBucket: string | null;
  addressing: Addressing;
  quirks: Quirks;
  timeoutSecs: number;
  concurrency: number;
  verifyTls: boolean;
  caFile: string | null;
  proxy: string | null;
}

export interface CredentialsInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
}

export interface ConnectionTest {
  /** null, wenn nur ein einzelner Bucket geprüft wurde. */
  bucketCount: number | null;
  latencyMs: number;
}

export interface BucketInfo {
  name: string;
  createdMs: number | null;
}

export interface ObjectEntryDto {
  key: string;
  size: number;
  lastModifiedMs: number | null;
  etag: string | null;
  storageClass: string | null;
}

export interface ListPage {
  objects: ObjectEntryDto[];
  prefixes: string[];
  nextToken: string | null;
}

/** Seite eines Ordner-Listings; `cachedMs` ist gesetzt, wenn sie aus dem Listing-Cache stammt. */
export interface FolderPage extends ListPage {
  cachedMs: number | null;
}

/** Eintrag eines lokalen Ordners (Zwei-Panel-Ansicht); bei Laufwerken Name „D:“, Pfad „D:\“. */
export interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number | null;
}

/** Abgleich: Lokal → Bucket (`upload`) oder Bucket → Lokal (`download`). */
export type SyncDirection = 'upload' | 'download';

/** Warum eine Datei übertragen wird: fehlt im Ziel, andere Größe, in der Quelle neuer. */
export type SyncReason = 'new' | 'sizeDiffers' | 'newer';

export interface SyncItem {
  relative: string;
  size: number;
  reason: SyncReason;
}

/** Vorschau eines Abgleichs; `planId` startet ihn. */
export interface SyncPreview {
  planId: string;
  direction: SyncDirection;
  transfers: number;
  bytes: number;
  unchanged: number;
  /** Die ersten 200 Übertragungen. */
  items: SyncItem[];
  /** Lokal → Bucket: Objekte, die lokal fehlen. */
  remoteExtras: { key: string; size: number }[];
  /** Bucket → Lokal: Dateien, die nur lokal liegen und bleiben. */
  localExtras: number;
}

/** Umfang des Listing-Caches. */
export interface CacheStats {
  folders: number;
  entries: number;
  bytes: number;
}

export interface ListingSummary {
  pages: number;
  objects: number;
  prefixes: number;
}

export interface ServiceErrorDto {
  code: string;
  message: string;
  httpStatus: number;
  requestId: string | null;
}

export interface BackendError {
  kind: string;
  message: string;
  service?: ServiceErrorDto;
}

/** skipped: Download nach der Konfliktregel nicht ausgeführt, weil die lokale Datei bleibt. */
export type TransferState = 'waiting' | 'active' | 'paused' | 'done' | 'skipped' | 'failed' | 'cancelled';

export type TransferDirection = 'upload' | 'download' | 'copy';

/** Bucket und Key eines Objekts. */
export interface ObjectAddress {
  bucket: string;
  key: string;
}

/** Stand eines Transfers (Screen 4). */
export interface TransferSnapshot {
  id: number;
  direction: TransferDirection;
  profileId: string;
  name: string;
  /** Lokale Datei: Quelle eines Uploads, Ziel eines Downloads; leer beim Kopieren. */
  localPath: string;
  /** Quelle einer Kopie. */
  copySource: ObjectAddress | null;
  /** Verbindung der Quelle, wenn eine Kopie aus einer anderen Verbindung kommt. */
  sourceProfileId: string | null;
  bucket: string;
  key: string;
  totalBytes: number;
  doneBytes: number;
  state: TransferState;
  bytesPerSec: number;
  partCount: number;
  partsDone: number;
  error: BackendError | null;
  finishedMs: number | null;
}

/** Event "transfers": nur seit der letzten Meldung geänderte und entfernte Transfers. */
export interface TransferUpdate {
  changed: TransferSnapshot[];
  removed: number[];
}

/** Ordner (Präfix) in einem Bucket: Ziel eines Uploads, Ausgangspunkt eines Downloads. */
export interface FolderLocation {
  profileId: string;
  bucket: string;
  prefix: string;
}

/** Im Objektbrowser gewählter Eintrag, z. B. zum Herunterladen oder Löschen; Ordner gelten rekursiv. */
export interface SelectedItem {
  key: string;
  isFolder: boolean;
  size: number;
  etag: string | null;
  /** Für „Überschreiben, wenn neuer“ beim Herunterladen. */
  lastModifiedMs?: number | null;
}

/** Was beim Herunterladen mit einer vorhandenen lokalen Datei geschieht. */
export type ConflictPolicy = 'skip' | 'overwriteIfNewer' | 'overwrite' | 'rename';

/** Einstellungen › Transfers; Limits in MiB/s, 0 = unbegrenzt. */
export interface TransferPreferences {
  maxTransfers: number;
  partsParallel: number;
  partSizeMib: number;
  multipartThresholdMib: number;
  retries: number;
  uploadLimitMibps: number;
  downloadLimitMibps: number;
  conflict: ConflictPolicy;
  /** Uploads vom Dienst prüfen lassen (CRC32C, sonst MD5), Downloads mit MD5-ETags vergleichen. */
  verifyChecksums: boolean;
}

/** Einstellungen › Cache. */
export interface CachePreferences {
  enabled: boolean;
}

/** Einstellungen, die das Backend speichert und anwendet. */
export interface AppSettings {
  transfers: TransferPreferences;
  cache: CachePreferences;
}

/** Gewählte Einträge aus einem offenen Ordner. */
export interface ObjectSelection {
  folder: FolderLocation;
  items: SelectedItem[];
}

/** Was gelöscht würde; Grundlage des Bestätigungsdialogs („Ziel und Menge“). */
export interface DeletePreview {
  /** Nur genau die Keys dieses Plans werden gelöscht. */
  planId: string;
  objects: number;
  bytes: number;
  /** Versionierung aktiv oder ausgesetzt; null, wenn unbekannt. */
  versioned: boolean | null;
}

export interface DeleteProgress {
  /** Gelöschte und abgelehnte Keys zusammen */
  processed: number;
  total: number;
}

export interface DeleteFailure {
  key: string;
  code: string;
  message: string;
}

export interface DeleteOutcome {
  deleted: number;
  /** Alle Fehlschläge; einzeln aufgeführt sind höchstens 100. */
  failedCount: number;
  failures: DeleteFailure[];
  cancelled: boolean;
}

/** Fortschritt beim Umbenennen: kopierte Objekte von allen. */
export interface RenameProgress {
  copied: number;
  total: number;
}

export interface RenameOutcome {
  newKey: string;
  /** Originale, die nach dem Kopieren nicht gelöscht werden konnten. */
  undeleted: number;
}

/** Ein Objekt einer gespeicherten Verbindung. */
export interface ObjectAt {
  profileId: string;
  bucket: string;
  key: string;
}

/** Metadaten-Eintrag; Namen klein geschrieben (x-amz-meta-… oder System-Header wie cache-control). */
export interface MetadataEntry {
  name: string;
  value: string;
}

export interface ObjectTag {
  key: string;
  value: string;
}

/** Kopfdaten eines Objekts (HeadObject). */
export interface ObjectHead {
  size: number;
  contentType: string | null;
  etag: string | null;
  storageClass: string | null;
  lastModifiedMs: number | null;
  versionId: string | null;
  metadata: MetadataEntry[];
  /** Serverseitige Verschlüsselung: `AES256`, `aws:kms`, `aws:kms:dsse` oder `SSE-C`. */
  encryption: string | null;
}

export interface ObjectVersion {
  versionId: string;
  isLatest: boolean;
  isDeleteMarker: boolean;
  lastModifiedMs: number | null;
  size: number;
}

export interface AclGrant {
  grantee: string;
  isPublic: boolean;
  permission: string;
}

export interface ObjectAcl {
  owner: string | null;
  grants: AclGrant[];
}

/** Auswahl lokaler Dateien und Ordner (Windows-Dialoge). */
export interface FilePickerPort {
  /** Leere Liste, wenn der Dialog abgebrochen wurde. */
  pickFiles(): Promise<string[]>;
  /** Zielordner für Downloads; null, wenn der Dialog abgebrochen wurde. */
  pickFolder(): Promise<string | null>;
}

/** Datei-Drop aus dem Windows-Explorer; Koordinaten in CSS-Pixeln relativ zum Fenster. */
export interface FileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave';
  /** Gezogene Dateien und Ordner; nur bei enter und drop gefüllt. */
  paths: string[];
  x: number;
  y: number;
}

export interface FileDropPort {
  /** Meldet Drag-and-Drop-Ereignisse; liefert die Abmeldung. */
  onFileDrop(listener: (event: FileDropEvent) => void): Promise<() => void>;
}

export interface BackendPort {
  /** Betriebssystem, auf dem das Backend läuft. */
  readonly platform: Platform;
  listPresets(): Promise<ProviderPreset[]>;
  getSettings(): Promise<AppSettings>;
  /** Prüft und speichert; Transfers übernehmen die Werte sofort. Liefert den gespeicherten Stand. */
  saveSettings(value: AppSettings): Promise<AppSettings>;
  listProfiles(): Promise<ConnectionProfile[]>;
  saveProfile(profile: ConnectionProfile, credentials: CredentialsInput | null): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  testConnection(profile: ConnectionProfile, credentials: CredentialsInput | null): Promise<ConnectionTest>;
  listBuckets(profileId: string): Promise<BucketInfo[]>;
  /**
   * Listet einen Ordner; jede Seite kommt sofort über onPage. Ohne `fresh` kommen zuerst die
   * gespeicherten Seiten aus dem Listing-Cache, danach die frischen vom Server.
   */
  listFolder(
    profileId: string,
    bucket: string,
    prefix: string,
    listingId: string,
    onPage: (page: FolderPage) => void,
    options?: { fresh?: boolean },
  ): Promise<ListingSummary>;
  cancelListing(listingId: string): Promise<boolean>;
  cacheStats(): Promise<CacheStats>;
  clearListingCache(): Promise<void>;
  /** Laufwerke (ohne Pfad) oder Inhalt eines lokalen Ordners. */
  listLocalDir(path: string | null): Promise<LocalEntry[]>;
  /** Vergleicht einen lokalen Ordner mit einem Ordner im Bucket. */
  planSync(folder: FolderLocation, localDir: string, direction: SyncDirection): Promise<SyncPreview>;
  /** Reiht die Transfers eines verglichenen Abgleichs ein. */
  startSync(planId: string): Promise<number[]>;
  /** Ermittelt, was die Auswahl löschen würde, und merkt sich den Plan bis zur Bestätigung. */
  prepareDelete(folder: FolderLocation, items: SelectedItem[]): Promise<DeletePreview>;
  /** Löscht genau die Keys des Plans; der Fortschritt kommt über onProgress. */
  deleteObjects(planId: string, onProgress: (progress: DeleteProgress) => void): Promise<DeleteOutcome>;
  cancelDelete(planId: string): Promise<boolean>;
  discardDelete(planId: string): Promise<void>;
  objectHead(at: ObjectAt): Promise<ObjectHead>;
  /** Ersetzt die Metadaten; das Objekt wird dafür auf sich selbst kopiert. */
  saveObjectMetadata(at: ObjectAt, metadata: MetadataEntry[]): Promise<void>;
  objectTags(at: ObjectAt): Promise<ObjectTag[]>;
  /** Ersetzt alle Tags. */
  saveObjectTags(at: ObjectAt, tags: ObjectTag[]): Promise<void>;
  /** Versionen und Delete Marker, neueste zuerst. */
  objectVersions(at: ObjectAt): Promise<ObjectVersion[]>;
  restoreObjectVersion(at: ObjectAt, versionId: string): Promise<void>;
  /** Löscht eine Version oder einen Delete Marker endgültig. */
  deleteObjectVersion(at: ObjectAt, versionId: string): Promise<void>;
  objectAcl(at: ObjectAt): Promise<ObjectAcl>;
  /** Vorsignierter Link zum Herunterladen, höchstens sieben Tage gültig. */
  presignObject(at: ObjectAt, expiresSecs: number): Promise<string>;
  /** Gibt einen Link an den Teilen-Dialog von Windows (Mail, Messenger, Umgebungsfreigabe, QR-Code); nur mit `hasShareSheet`. */
  shareLink(title: string, url: string): Promise<void>;
  /** Legt im Ordner einen neuen Ordner an und liefert seinen Key. */
  createFolder(folder: FolderLocation, name: string): Promise<string>;
  /** Benennt eine Datei oder einen Ordner um: kopieren, dann Originale löschen. */
  renameObject(
    folder: FolderLocation,
    item: SelectedItem,
    newName: string,
    onProgress: (progress: RenameProgress) => void,
  ): Promise<RenameOutcome>;
  enqueueUploads(target: FolderLocation, paths: string[]): Promise<number[]>;
  /** Lädt die Auswahl aus dem Ordner `folder` nach `targetDir`; die Ordnerstruktur bleibt erhalten. */
  enqueueDownloads(folder: FolderLocation, items: SelectedItem[], targetDir: string): Promise<number[]>;
  /** Kopiert die Auswahl auf dem Server in den Ordner `target`; `move` löscht danach die Originale. */
  enqueueCopies(source: ObjectSelection, target: FolderLocation, move: boolean): Promise<number[]>;
  listTransfers(): Promise<TransferSnapshot[]>;
  pauseTransfer(id: number): Promise<void>;
  resumeTransfer(id: number): Promise<void>;
  cancelTransfer(id: number): Promise<void>;
  retryTransfer(id: number): Promise<void>;
  pauseAllTransfers(): Promise<void>;
  resumeAllTransfers(): Promise<void>;
  removeFinishedTransfers(): Promise<void>;
  /** Meldet geänderte und entfernte Transfers; liefert die Abmeldung. */
  onTransfers(listener: (update: TransferUpdate) => void): Promise<() => void>;
}

export const CANCELLED_KIND = 'cancelled';

const SELF_HOSTED: ReadonlySet<Provider> = new Set(['minio', 'ceph', 'garage', 'custom']);

/** Selbst gehostete Dienste zeigen das Icon server, gehostete Anbieter cloud. */
export function isSelfHosted(provider: Provider): boolean {
  return SELF_HOSTED.has(provider);
}

function isBackendError(value: unknown): value is BackendError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BackendError).kind === 'string' &&
    typeof (value as BackendError).message === 'string'
  );
}

/** Wandelt beliebige Fehler (auch JS-Fehler) in die Form, die die Oberfläche anzeigt. */
export function toBackendError(error: unknown): BackendError {
  if (isBackendError(error)) return error;
  return { kind: 'unexpected', message: error instanceof Error ? error.message : String(error) };
}

/** Kurzform für Fehlerleisten: "AccessDenied · HTTP 403 · Request-ID …" */
export function errorDetail(error: BackendError): string | null {
  const s = error.service;
  if (!s) return null;
  return [s.code, `HTTP ${s.httpStatus}`, s.requestId ? `Request-ID ${s.requestId}` : null].filter(Boolean).join(' · ');
}
