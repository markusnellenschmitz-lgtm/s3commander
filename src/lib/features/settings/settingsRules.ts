// Grenzen, Standardwerte und Auswahllisten der Einstellungen. Dieselben Werte wie
// src-tauri/src/domain/settings.rs; das Backend prüft verbindlich.

import type { ConflictPolicy, TransferPreferences } from '../../core/backend';
import { formatCount } from '../../core/format';

export const DEFAULT_TRANSFER_PREFERENCES: Readonly<TransferPreferences> = {
  maxTransfers: 8,
  partsParallel: 4,
  partSizeMib: 16,
  multipartThresholdMib: 64,
  retries: 3,
  uploadLimitMibps: 0,
  downloadLimitMibps: 0,
  conflict: 'rename',
  verifyChecksums: true,
};

/** Zahlenfelder der Transfer-Einstellungen. */
export type NumericField = Exclude<keyof TransferPreferences, 'conflict' | 'verifyChecksums'>;

export const RANGES: Readonly<Record<NumericField, { min: number; max: number; label: string }>> = {
  maxTransfers: { min: 1, max: 32, label: 'Gleichzeitige Transfers' },
  partsParallel: { min: 1, max: 16, label: 'Teile pro Datei' },
  partSizeMib: { min: 5, max: 512, label: 'Teilgröße (MiB)' },
  multipartThresholdMib: { min: 5, max: 5 * 1024, label: 'Multipart ab (MiB)' },
  retries: { min: 0, max: 10, label: 'Wiederholungen' },
  uploadLimitMibps: { min: 0, max: 10_000, label: 'Upload-Limit (MiB/s)' },
  downloadLimitMibps: { min: 0, max: 10_000, label: 'Download-Limit (MiB/s)' },
};

export const PART_SIZES_MIB: readonly number[] = [5, 8, 16, 32, 64, 128, 256, 512];

export const CONFLICT_OPTIONS: readonly { id: ConflictPolicy; label: string }[] = [
  { id: 'skip', label: 'Überspringen' },
  { id: 'overwriteIfNewer', label: 'Überschreiben, wenn das Objekt neuer ist' },
  { id: 'overwrite', label: 'Immer überschreiben' },
  { id: 'rename', label: 'Umbenennen' },
];

/** S3 erlaubt höchstens 10.000 Teile. */
const MAX_PARTS = 10_000;

/** Fehlertext eines Zahlenfelds; null, wenn der Wert passt. */
export function rangeError(field: NumericField, value: number): string | null {
  const range = RANGES[field];
  if (Number.isInteger(value) && value >= range.min && value <= range.max) return null;
  return `${range.label} muss zwischen ${formatCount(range.min)} und ${formatCount(range.max)} liegen`;
}

/** Alle Fehler der Transfer-Einstellungen, je Feld. */
export function transferErrors(prefs: TransferPreferences): Partial<Record<NumericField, string>> {
  const errors: Partial<Record<NumericField, string>> = {};
  for (const field of Object.keys(RANGES) as NumericField[]) {
    const error = rangeError(field, prefs[field]);
    if (error) errors[field] = error;
  }
  return errors;
}

/** "Bei 10.000 Teilen höchstens 156 GiB pro Objekt." */
export function partLimitText(partSizeMib: number): string {
  const gib = (partSizeMib * MAX_PARTS) / 1024;
  return `Bei 10.000 Teilen höchstens ${formatCount(Math.floor(gib))} GiB pro Objekt. Größere Dateien erhöhen die Teilgröße automatisch.`;
}
