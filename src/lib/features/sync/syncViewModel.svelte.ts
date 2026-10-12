// Abgleich lokal ↔ Bucket: vergleichen, Vorschau zeigen, Transfers einreihen. Objekte, die lokal
// fehlen, löscht auf Wunsch der gewohnte Löschdialog mit Rückfrage; lokal wird nie gelöscht.

import type {
  BackendError,
  BackendPort,
  FolderLocation,
  ObjectSelection,
  SyncDirection,
  SyncPreview,
  SyncReason,
} from '../../core/backend';
import { toBackendError } from '../../core/backend';
import { countText, formatBytes, formatCount } from '../../core/format';

export const SYNC_REASON_LABELS: Readonly<Record<SyncReason, string>> = {
  new: 'Neu',
  sizeDiffers: 'Größe geändert',
  newer: 'Neuer',
};

export interface SyncDeps {
  backend: BackendPort;
  /** Öffnet den Löschdialog für Objekte, die lokal fehlen. */
  deleteExtras: (selection: ObjectSelection) => void;
}

interface SyncPlace {
  folder: FolderLocation;
  localDir: string;
}

export class SyncViewModel {
  isOpen = $state(false);
  direction = $state<SyncDirection>('upload');
  preview = $state<SyncPreview | null>(null);
  comparing = $state(false);
  starting = $state(false);
  /** Lokal → Bucket: anschließend löschen, was lokal fehlt. */
  deleteRemoteExtras = $state(false);
  error = $state<BackendError | null>(null);
  place = $state<SyncPlace | null>(null);

  readonly #deps: SyncDeps;
  #request = 0;

  constructor(deps: SyncDeps) {
    this.#deps = deps;
  }

  open(folder: FolderLocation, localDir: string): void {
    this.place = { folder, localDir };
    this.isOpen = true;
    this.deleteRemoteExtras = false;
    void this.compare();
  }

  close(): void {
    if (this.starting) return;
    this.isOpen = false;
    this.preview = null;
  }

  setDirection(direction: SyncDirection): void {
    if (direction === this.direction) return;
    this.direction = direction;
    this.deleteRemoteExtras = false;
    void this.compare();
  }

  async compare(): Promise<void> {
    const place = this.place;
    if (!place) return;
    const request = ++this.#request;
    this.comparing = true;
    this.preview = null;
    this.error = null;
    try {
      const preview = await this.#deps.backend.planSync(place.folder, place.localDir, this.direction);
      if (request === this.#request) this.preview = preview;
    } catch (error) {
      if (request === this.#request) this.error = toBackendError(error);
    } finally {
      if (request === this.#request) this.comparing = false;
    }
  }

  async start(): Promise<void> {
    const preview = this.preview;
    const place = this.place;
    if (!preview || !place || !this.canStart) return;
    this.starting = true;
    this.error = null;
    try {
      if (preview.transfers > 0) await this.#deps.backend.startSync(preview.planId);
      if (this.#deletesExtras) this.#deps.deleteExtras(this.#extrasSelection(place.folder, preview));
      this.starting = false;
      this.close();
    } catch (error) {
      this.error = toBackendError(error);
      this.starting = false;
    }
  }

  get canStart(): boolean {
    const preview = this.preview;
    return preview !== null && !this.starting && (preview.transfers > 0 || this.#deletesExtras);
  }

  /** „2 neu · 3 geändert (1,2 GiB) · 840 unverändert“ */
  get summaryText(): string {
    const preview = this.preview;
    if (!preview) return '';
    if (preview.transfers === 0)
      return `Alles aktuell · ${countText(preview.unchanged, 'Datei', 'Dateien')} unverändert`;
    const fresh = preview.items.filter((i) => i.reason === 'new').length;
    const parts = [
      `${countText(preview.transfers, 'Datei', 'Dateien')} (${formatBytes(preview.bytes)})`,
      preview.transfers <= preview.items.length ? `${formatCount(fresh)} neu` : null,
      `${formatCount(preview.unchanged)} unverändert`,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  /** Mehr Übertragungen, als die Vorschau zeigt. */
  get hiddenCount(): number {
    const preview = this.preview;
    return preview ? preview.transfers - preview.items.length : 0;
  }

  get #deletesExtras(): boolean {
    return this.direction === 'upload' && this.deleteRemoteExtras && (this.preview?.remoteExtras.length ?? 0) > 0;
  }

  #extrasSelection(folder: FolderLocation, preview: SyncPreview): ObjectSelection {
    return {
      folder,
      items: preview.remoteExtras.map(({ key, size }) => ({ key, isFolder: false, size, etag: null })),
    };
  }
}
