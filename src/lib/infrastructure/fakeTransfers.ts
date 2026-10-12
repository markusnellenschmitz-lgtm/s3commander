// Simulierte Transfers für das Fake-Backend: dieselbe Zustandsmaschine wie das Rust-Backend
// (UI-SPEC §5), Fortschritt per Timer. Dateien mit "fehler" im Namen scheitern bei der Hälfte.

import type {
  BackendError,
  FolderLocation,
  ObjectAddress,
  TransferSnapshot,
  TransferState,
  TransferUpdate,
} from '../core/backend';

const MiB = 1024 ** 2;
const PART_SIZE = 16 * MiB;
const MULTIPART_THRESHOLD = 64 * MiB;
const FAILING_MARKER = 'fehler';

export const FAKE_UPLOAD_ERROR: BackendError = {
  kind: 'service',
  message: 'RequestTimeout: Der Endpunkt hat 30 s lang keine Daten angenommen (HTTP 400)',
  service: {
    code: 'RequestTimeout',
    message: 'Der Endpunkt hat 30 s lang keine Daten angenommen',
    httpStatus: 400,
    requestId: '4K8P2QX7N1M3W9ZT',
  },
};

export interface FakeTransferOptions {
  tickMs?: number;
  bytesPerSec?: number;
  maxActive?: number;
  /** Wird für jeden fertigen Transfer genau einmal aufgerufen. */
  onFinished?: (transfer: TransferSnapshot) => void;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Größe aus dem Namen, damit die Vorschau bei jedem Start gleich aussieht. */
export function fakeFileSize(path: string): number {
  let hash = 0;
  for (const char of path) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return path.toLowerCase().includes(FAILING_MARKER) ? 8 * MiB : 64 * MiB + (hash % (960 * MiB));
}

/** Lokales Ziel eines Downloads: Ordnerstruktur unterhalb des offenen Präfixes bleibt erhalten. */
export function fakeLocalPath(targetDir: string, prefix: string, key: string): string {
  const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return [targetDir.replace(/[\\/]+$/, ''), ...relative.split('/').filter(Boolean)].join('\\');
}

/** Lokale Datei, die unter `key` hochgeladen wird. */
export interface FakeUploadFile {
  path: string;
  key: string;
  size: number;
}

/** Objekt, das heruntergeladen werden soll, mit seinem lokalen Ziel. */
export interface FakeDownload {
  key: string;
  size: number;
  localPath: string;
}

type NewTransfer = Pick<TransferSnapshot, 'direction' | 'profileId' | 'localPath' | 'bucket' | 'key' | 'totalBytes'> &
  Partial<Pick<TransferSnapshot, 'copySource' | 'sourceProfileId'>>;

/** Serverseitige Kopie von `source` nach `bucket`/`key`. */
export interface FakeCopy {
  source: ObjectAddress;
  bucket: string;
  key: string;
  size: number;
}

export class FakeTransferEngine {
  readonly #transfers: TransferSnapshot[] = [];
  readonly #listeners = new Set<(update: TransferUpdate) => void>();
  /** Seit der letzten Meldung geändert bzw. entfernt, wie im Rust-Backend. */
  readonly #dirty = new Set<number>();
  #removed: number[] = [];
  /** Transfers, die ihren einen simulierten Fehler schon hatten. */
  readonly #failedOnce = new Set<number>();
  readonly #tickMs: number;
  readonly #bytesPerSec: number;
  readonly #maxActive: number;
  readonly #onFinished: FakeTransferOptions['onFinished'];
  #nextId = 1;
  #queuePaused = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: FakeTransferOptions = {}) {
    this.#tickMs = options.tickMs ?? 100;
    this.#bytesPerSec = options.bytesPerSec ?? 40 * MiB;
    this.#maxActive = options.maxActive ?? 2;
    this.#onFinished = options.onFinished;
  }

  enqueue(target: FolderLocation, paths: string[]): number[] {
    const files = paths.map((path) => ({ path, key: target.prefix + fileName(path), size: fakeFileSize(path) }));
    return this.enqueueUploadFiles(target.profileId, target.bucket, files);
  }

  /** Uploads unter genau diesen Keys (Abgleich). */
  enqueueUploadFiles(profileId: string, bucket: string, files: FakeUploadFile[]): number[] {
    return this.#addAll(
      files.map((file) => ({
        direction: 'upload',
        profileId,
        localPath: file.path,
        bucket,
        key: file.key,
        totalBytes: file.size,
      })),
    );
  }

  enqueueDownloads(folder: FolderLocation, downloads: FakeDownload[]): number[] {
    return this.#addAll(
      downloads.map((d) => ({
        direction: 'download',
        profileId: folder.profileId,
        localPath: d.localPath,
        bucket: folder.bucket,
        key: d.key,
        totalBytes: d.size,
      })),
    );
  }

  /** Kopien nach `profileId`; `sourceProfileId` nur bei Kopien aus einer anderen Verbindung. */
  enqueueCopies(profileId: string, copies: FakeCopy[], sourceProfileId: string | null = null): number[] {
    return this.#addAll(
      copies.map((c) => ({
        direction: 'copy',
        profileId,
        localPath: '',
        bucket: c.bucket,
        key: c.key,
        totalBytes: c.size,
        copySource: c.source,
        sourceProfileId,
      })),
    );
  }

  #addAll(transfers: NewTransfer[]): number[] {
    const ids = transfers.map((fields) => {
      const transfer: TransferSnapshot = {
        copySource: null,
        sourceProfileId: null,
        ...fields,
        id: this.#nextId++,
        name: fileName(fields.key),
        doneBytes: 0,
        state: 'waiting',
        bytesPerSec: 0,
        partCount: fields.totalBytes >= MULTIPART_THRESHOLD ? Math.ceil(fields.totalBytes / PART_SIZE) : 1,
        partsDone: 0,
        error: null,
        finishedMs: null,
      };
      this.#transfers.push(transfer);
      this.#dirty.add(transfer.id);
      return transfer.id;
    });
    this.#changed();
    return ids;
  }

  list(): TransferSnapshot[] {
    return this.#transfers.map((t) => ({ ...t }));
  }

  subscribe(listener: (update: TransferUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pause(id: number): void {
    this.#update(id, ['waiting', 'active'], 'paused');
  }

  resume(id: number): void {
    this.#queuePaused = false;
    this.#update(id, ['paused'], 'waiting');
  }

  cancel(id: number): void {
    this.#update(id, ['waiting', 'active', 'paused', 'failed'], 'cancelled');
  }

  retry(id: number): void {
    this.#update(id, ['failed'], 'waiting');
  }

  pauseAll(): void {
    this.#queuePaused = true;
    this.#setAll(['waiting', 'active'], 'paused');
  }

  resumeAll(): void {
    this.#queuePaused = false;
    this.#setAll(['paused'], 'waiting');
  }

  removeFinished(): void {
    for (let i = this.#transfers.length - 1; i >= 0; i--) {
      const { id, state } = this.#transfers[i];
      if (['done', 'skipped', 'cancelled'].includes(state)) {
        this.#transfers.splice(i, 1);
        this.#dirty.delete(id);
        this.#removed.unshift(id);
      }
    }
    this.#changed();
  }

  #update(id: number, from: TransferState[], to: TransferState): void {
    const transfer = this.#transfers.find((t) => t.id === id);
    if (transfer && from.includes(transfer.state)) this.#set(transfer, to);
    this.#changed();
  }

  #setAll(from: TransferState[], to: TransferState): void {
    for (const transfer of this.#transfers.filter((t) => from.includes(t.state))) this.#set(transfer, to);
    this.#changed();
  }

  #set(transfer: TransferSnapshot, state: TransferState): void {
    this.#dirty.add(transfer.id);
    transfer.state = state;
    transfer.bytesPerSec = 0;
    if (state === 'waiting') transfer.error = null;
  }

  #changed(): void {
    this.#pump();
    this.#syncTimer();
    const update = this.#takeUpdate();
    if (update.changed.length === 0 && update.removed.length === 0) return;
    for (const listener of this.#listeners) listener(update);
  }

  #takeUpdate(): TransferUpdate {
    const changed = this.#transfers.filter((t) => this.#dirty.has(t.id)).map((t) => ({ ...t }));
    const update = { changed, removed: this.#removed };
    this.#dirty.clear();
    this.#removed = [];
    return update;
  }

  #pump(): void {
    if (this.#queuePaused) return;
    let free = this.#maxActive - this.#transfers.filter((t) => t.state === 'active').length;
    for (const transfer of this.#transfers) {
      if (free <= 0) break;
      if (transfer.state === 'waiting') {
        this.#set(transfer, 'active');
        free--;
      }
    }
  }

  #syncTimer(): void {
    const active = this.#transfers.some((t) => t.state === 'active');
    if (active && !this.#timer) this.#timer = setInterval(() => this.#tick(), this.#tickMs);
    if (!active && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #tick(): void {
    const step = (this.#bytesPerSec * this.#tickMs) / 1000;
    for (const transfer of this.#transfers.filter((t) => t.state === 'active')) this.#advance(transfer, step);
    this.#changed();
  }

  #advance(transfer: TransferSnapshot, step: number): void {
    this.#dirty.add(transfer.id);
    transfer.bytesPerSec = this.#bytesPerSec;
    transfer.doneBytes = Math.min(transfer.totalBytes, transfer.doneBytes + step);
    transfer.partsDone =
      transfer.totalBytes > 0 ? Math.floor((transfer.doneBytes / transfer.totalBytes) * transfer.partCount) : 0;
    const failing = transfer.name.toLowerCase().includes(FAILING_MARKER) && !this.#failedOnce.has(transfer.id);
    if (failing && transfer.doneBytes >= transfer.totalBytes / 2) {
      transfer.state = 'failed';
      transfer.bytesPerSec = 0;
      transfer.error = FAKE_UPLOAD_ERROR;
      this.#failedOnce.add(transfer.id);
    } else if (transfer.doneBytes >= transfer.totalBytes) {
      transfer.state = 'done';
      transfer.bytesPerSec = 0;
      transfer.finishedMs = Date.now();
      this.#onFinished?.({ ...transfer });
    }
  }
}
