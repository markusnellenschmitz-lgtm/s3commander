// Objekt-Einträge eines Präfix (UI-SPEC §7) und ihre fachlichen Regeln.

import type { SelectedItem } from '../../core/backend';
import type { SortState } from '../../core/table/types';
import type { SpriteIconName } from '../../ui/icons/sprite';

export interface S3Entry {
  /** Voller Key */
  key: string;
  /** Letztes Segment, Ordner mit "/" */
  name: string;
  isPrefix: boolean;
  size?: number;
  /** Millisekunden seit Epoch */
  lastModified?: number;
  storageClass?: string;
  etag?: string;
}

export type FileKind = 'folder' | 'archive' | 'text' | 'lock' | 'file';

/** Icon je Dateityp laut DESIGN-SYSTEM.md. */
export const ICON_BY_KIND: Readonly<Record<FileKind, SpriteIconName>> = {
  folder: 'folder',
  archive: 'file-archive',
  text: 'file-text',
  lock: 'file-lock',
  file: 'file',
};

/** Spalten-IDs der Objekttabelle, nach denen sortiert werden kann. */
export type EntrySortColumn = 'name' | 'size' | 'modified' | 'storageClass';
export type EntryColumn = EntrySortColumn | 'etag';

/** Einzige Quelle der Spaltenbeschriftungen (Tabelle, Statusleiste, Einstellungen). */
export const ENTRY_COLUMN_LABELS: Readonly<Record<EntryColumn, string>> = {
  name: 'Name',
  size: 'Größe',
  modified: 'Geändert',
  storageClass: 'Storage Class',
  etag: 'ETag',
};

/** Eintrag als Auswahl für das Backend; Ordner löst das Backend rekursiv auf. */
export function toSelectedItem(entry: S3Entry): SelectedItem {
  return {
    key: entry.key,
    isFolder: entry.isPrefix,
    size: entry.size ?? 0,
    etag: entry.etag ?? null,
    lastModifiedMs: entry.lastModified ?? null,
  };
}

const ARCHIVED_CLASSES = new Set(['GLACIER', 'DEEP_ARCHIVE']);
const ENCRYPTED_SUFFIXES = ['.gpg', '.age'];
const ARCHIVE_PATTERN = /\.(zst|gz|zip|tar|7z|xz|bz2|tgz)$/;
const TEXT_PATTERN = /\.(txt|log|sql|json|csv|md|sha256|yaml|yml|xml|conf)$/;

/** Dateityp für die Icon-Zuordnung laut DESIGN-SYSTEM.md. */
export function kindOf(entry: S3Entry): FileKind {
  if (entry.isPrefix) return 'folder';
  const name = entry.name.toLowerCase();
  if (ENCRYPTED_SUFFIXES.some((s) => name.endsWith(s)) || ARCHIVED_CLASSES.has(entry.storageClass ?? '')) return 'lock';
  if (ARCHIVE_PATTERN.test(name)) return 'archive';
  if (TEXT_PATTERN.test(name)) return 'text';
  return 'file';
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Natürliche Namenssortierung (UI-SPEC §5). */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

function compareByColumn(a: S3Entry, b: S3Entry, column: string): number {
  switch (column as EntrySortColumn) {
    case 'size':
      return (a.size ?? -1) - (b.size ?? -1);
    case 'modified':
      return (a.lastModified ?? 0) - (b.lastModified ?? 0);
    case 'storageClass':
      return compareNames(a.storageClass ?? '', b.storageClass ?? '');
    default:
      return 0;
  }
}

/** Ordner immer zuerst, unabhängig von der Richtung; bei Gleichstand nach Name. */
export function compareEntries(a: S3Entry, b: S3Entry, sort: SortState): number {
  if (a.isPrefix !== b.isPrefix) return a.isPrefix ? -1 : 1;
  const primary = compareByColumn(a, b, sort.column);
  return (primary !== 0 ? primary : compareNames(a.name, b.name)) * sort.dir;
}
