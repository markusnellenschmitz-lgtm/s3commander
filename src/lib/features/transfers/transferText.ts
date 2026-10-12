// Texte und Kennzahlen einer Transfer-Zeile (Screen 4).

import type {
  BackendError,
  FolderLocation,
  TransferDirection,
  TransferSnapshot,
  TransferState,
} from '../../core/backend';
import type { SpriteIconName } from '../../ui/icons/sprite';
import { errorDetail } from '../../core/backend';
import { formatTime } from '../../core/format';
import { parentOfKey } from '../../core/objectName';
import { localFolder } from '../../core/localPath';

/** Ganzzahliger Fortschritt in Prozent; fertige Transfers immer 100. */
export function percent(t: TransferSnapshot): number {
  if (t.state === 'done') return 100;
  return t.totalBytes > 0 ? Math.floor((t.doneBytes / t.totalBytes) * 100) : 0;
}

/** Restzeit in Sekunden; ohne Tempo unendlich. */
export function restSeconds(t: Pick<TransferSnapshot, 'totalBytes' | 'doneBytes' | 'bytesPerSec'>): number {
  return t.bytesPerSec > 0 ? (t.totalBytes - t.doneBytes) / t.bytesPerSec : Number.POSITIVE_INFINITY;
}

/**
 * Upload "→ prod-backups-eu/backups/2026/10/", Download "← prod-media-eu/exports/ nach D:/Exporte",
 * Kopie "prod-media-eu/alt/ → prod-media-eu/neu/".
 */
export function routeText(t: TransferSnapshot): string {
  const remote = `${t.bucket}/${parentOfKey(t.key)}`;
  if (t.copySource) return `${t.copySource.bucket}/${parentOfKey(t.copySource.key)} → ${remote}`;
  return t.direction === 'upload' ? `→ ${remote}` : `← ${remote} nach ${localFolder(t.localPath)}`;
}

/** Ordner, die nach einem fertigen Transfer anders aussehen: Ziel von Uploads und Kopien,
 * bei Kopien auch die Quelle (Verschieben), auch in einer anderen Verbindung. Downloads ändern
 * keinen Ordner im Bucket. */
export function changedFolders(t: TransferSnapshot): FolderLocation[] {
  if (t.direction === 'download') return [];
  const folder = (profileId: string, bucket: string, key: string) => ({ profileId, bucket, prefix: parentOfKey(key) });
  const target = folder(t.profileId, t.bucket, t.key);
  if (!t.copySource) return [target];
  return [target, folder(t.sourceProfileId ?? t.profileId, t.copySource.bucket, t.copySource.key)];
}

/** Icon und Beschriftung der Richtungsspalte (DESIGN-SYSTEM.md: arrow-up / arrow-down). */
export const DIRECTION_ICONS: Readonly<Record<TransferDirection, { icon: SpriteIconName; label: string }>> = {
  upload: { icon: 'arrow-up', label: 'Upload' },
  download: { icon: 'arrow-down', label: 'Download' },
  copy: { icon: 'copy', label: 'Kopie' },
};

const SINGLE_PART_TEXT: Record<TransferDirection, string> = {
  upload: 'Lädt hoch',
  download: 'Lädt herunter',
  copy: 'Kopiert',
};

/**
 * Statustext: "Teil 101 / 152", "Lädt hoch" bzw. "Lädt herunter", "Wartend · Platz 1", "Pausiert", "Fertig · 15:09",
 * "Fehlgeschlagen", "Abgebrochen". `waitingPosition` zählt ab 1.
 */
export function stateText(t: TransferSnapshot, waitingPosition: number): string {
  switch (t.state) {
    case 'active':
      return t.partCount > 1
        ? `Teil ${Math.min(t.partsDone + 1, t.partCount)} / ${t.partCount}`
        : SINGLE_PART_TEXT[t.direction];
    case 'waiting':
      return `Wartend · Platz ${waitingPosition}`;
    case 'paused':
      return 'Pausiert';
    case 'done':
      return t.finishedMs === null ? 'Fertig' : `Fertig · ${formatTime(t.finishedMs)}`;
    case 'skipped':
      return 'Übersprungen · Datei vorhanden';
    case 'failed':
      return 'Fehlgeschlagen';
    case 'cancelled':
      return 'Abgebrochen';
  }
}

const PROGRESS_VARIANT: Record<TransferState, string> = {
  active: '',
  waiting: 's3-progress-muted',
  paused: 's3-progress-warning',
  done: 's3-progress-success',
  skipped: 's3-progress-muted',
  failed: 's3-progress-error',
  cancelled: 's3-progress-muted',
};

/** Text für "Fehlerdetails kopieren": Meldung plus Code, HTTP-Status und Request-ID. */
export function errorClipboardText(error: BackendError): string {
  const detail = errorDetail(error);
  return detail ? `${error.message} · ${detail}` : error.message;
}

/** CSS-Klasse des Fortschrittsbalkens je Zustand (components.css). */
export function progressClass(state: TransferState): string {
  return PROGRESS_VARIANT[state];
}
