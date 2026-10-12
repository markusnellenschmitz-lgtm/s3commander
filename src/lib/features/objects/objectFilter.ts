// Filter für die Objektliste (UI-SPEC §3: Suchfeld, Typ, Größe, Datum). Reine Logik ohne DOM.

import { kindOf, type FileKind, type S3Entry } from './entry';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type KindFilter = 'all' | FileKind;
export type SizeFilter = 'all' | 'small' | 'medium' | 'large' | 'huge';
export type DateFilter = 'all' | 'today' | 'week' | 'month' | 'older';

export interface ObjectFilter {
  text: string;
  kind: KindFilter;
  size: SizeFilter;
  date: DateFilter;
}

export const NO_FILTER: ObjectFilter = { text: '', kind: 'all', size: 'all', date: 'all' };

export const KIND_OPTIONS: readonly { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'Alle Typen' },
  { id: 'folder', label: 'Ordner' },
  { id: 'archive', label: 'Archive' },
  { id: 'text', label: 'Text' },
  { id: 'lock', label: 'Verschlüsselt oder archiviert' },
  { id: 'file', label: 'Sonstige Dateien' },
];

export const SIZE_OPTIONS: readonly { id: SizeFilter; label: string; min: number; max: number }[] = [
  { id: 'all', label: 'Alle Größen', min: 0, max: Number.POSITIVE_INFINITY },
  { id: 'small', label: 'Unter 1 MiB', min: 0, max: MiB },
  { id: 'medium', label: '1 MiB bis 100 MiB', min: MiB, max: 100 * MiB },
  { id: 'large', label: '100 MiB bis 1 GiB', min: 100 * MiB, max: GiB },
  { id: 'huge', label: 'Über 1 GiB', min: GiB, max: Number.POSITIVE_INFINITY },
];

/** Zeitraum relativ zu jetzt: [frühestens, spätestens] in Tagen zurück. */
export const DATE_OPTIONS: readonly { id: DateFilter; label: string; newestDays: number; oldestDays: number }[] = [
  { id: 'all', label: 'Jedes Datum', newestDays: 0, oldestDays: Number.POSITIVE_INFINITY },
  { id: 'today', label: 'Letzte 24 Stunden', newestDays: 0, oldestDays: 1 },
  { id: 'week', label: 'Letzte 7 Tage', newestDays: 0, oldestDays: 7 },
  { id: 'month', label: 'Letzte 30 Tage', newestDays: 0, oldestDays: 30 },
  { id: 'older', label: 'Älter als 1 Jahr', newestDays: 365, oldestDays: Number.POSITIVE_INFINITY },
];

export function isActive(filter: ObjectFilter): boolean {
  return filter.text.trim() !== '' || filter.kind !== 'all' || filter.size !== 'all' || filter.date !== 'all';
}

/** Suchtext als Muster: Teil des Namens, `*` steht für beliebig viele Zeichen, ohne Groß/klein. */
export function namePattern(text: string): RegExp | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const escaped = trimmed
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(escaped, 'i');
}

/** Prüft-Funktion für die Datenquelle; null, wenn nichts gefiltert wird. */
export function filterPredicate(filter: ObjectFilter, nowMs: number): ((entry: S3Entry) => boolean) | null {
  if (!isActive(filter)) return null;
  const pattern = namePattern(filter.text);
  const size = SIZE_OPTIONS.find((o) => o.id === filter.size) ?? SIZE_OPTIONS[0];
  const date = DATE_OPTIONS.find((o) => o.id === filter.date) ?? DATE_OPTIONS[0];
  return (entry) => {
    if (pattern && !pattern.test(entry.name)) return false;
    if (filter.kind !== 'all' && kindOf(entry) !== filter.kind) return false;
    if (filter.size !== 'all' && !inRange(entry.size, size.min, size.max)) return false;
    if (filter.date === 'all') return true;
    if (entry.lastModified === undefined) return false;
    const ageDays = (nowMs - entry.lastModified) / DAY_MS;
    return ageDays >= date.newestDays && ageDays <= date.oldestDays;
  };
}

/** Ordner haben keine Größe und fallen bei einem Größenfilter heraus. */
function inRange(size: number | undefined, min: number, max: number): boolean {
  return size !== undefined && size >= min && size < max;
}
