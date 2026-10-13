// Filter für die Objektliste (UI-SPEC §3: Suchfeld, Typ, Größe, Datum). Reine Logik ohne DOM.
// Die Auswahl im Filtermenü wird zu einer Abfrage mit absoluten Grenzen (`EntryQuery`); dieselbe
// Abfrage filtert die Liste in der Oberfläche und, bei sehr großen Ordnern, im Backend.

import type { EntryQuery } from '../../core/backend';
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

const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** Abfrage mit absoluten Grenzen; null, wenn nichts gefiltert wird. */
export function filterQuery(filter: ObjectFilter, nowMs: number): EntryQuery | null {
  if (!isActive(filter)) return null;
  const size = SIZE_OPTIONS.find((o) => o.id === filter.size) ?? SIZE_OPTIONS[0];
  const date = DATE_OPTIONS.find((o) => o.id === filter.date) ?? DATE_OPTIONS[0];
  const bySize = filter.size !== 'all';
  const byDate = filter.date !== 'all';
  return {
    text: filter.text.trim(),
    kind: filter.kind === 'all' ? null : filter.kind,
    minSize: bySize ? size.min : null,
    maxSize: bySize ? finiteOrNull(size.max) : null,
    modifiedFrom: byDate ? finiteOrNull(nowMs - date.oldestDays * DAY_MS) : null,
    modifiedTo: byDate ? nowMs - date.newestDays * DAY_MS : null,
  };
}

/** Prüft-Funktion zu einer Abfrage, für Listen in der Oberfläche. */
export function entryMatcher(query: EntryQuery): (entry: S3Entry) => boolean {
  const pattern = namePattern(query.text);
  const bySize = query.minSize !== null || query.maxSize !== null;
  const byDate = query.modifiedFrom !== null || query.modifiedTo !== null;
  return (entry) => {
    if (pattern && !pattern.test(entry.name)) return false;
    if (query.kind !== null && kindOf(entry) !== query.kind) return false;
    if (bySize && !within(entry.size, query.minSize, query.maxSize, false)) return false;
    return !byDate || within(entry.lastModified, query.modifiedFrom, query.modifiedTo, true);
  };
}

/** Wert zwischen den Grenzen; ohne Wert (Ordner haben keine Größe und kein Datum) nie. */
function within(value: number | undefined, min: number | null, max: number | null, maxIncluded: boolean): boolean {
  if (value === undefined) return false;
  if (min !== null && value < min) return false;
  if (max === null) return true;
  return maxIncluded ? value <= max : value < max;
}
