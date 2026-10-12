// Texte der Statusleiste für den Objekt-Browser (UI-SPEC §3, Screen 2).

import { countText, formatBytes, formatCount } from '../../core/format';
import type { SortState } from '../../core/table/types';
import { ENTRY_COLUMN_LABELS, type EntryColumn } from './entry';

/** "17 Objekte · 4 Ordner" */
export function objectCountText(objects: number, folders: number): string {
  const base = countText(objects, 'Objekt', 'Objekte');
  return folders > 0 ? `${base} · ${formatCount(folders)} Ordner` : base;
}

/** "3 ausgewählt · 14,2 GiB" oder "Keine Auswahl" */
export function selectionText(count: number, bytes: number): string {
  if (count === 0) return 'Keine Auswahl';
  const base = `${formatCount(count)} ausgewählt`;
  return bytes > 0 ? `${base} · ${formatBytes(bytes)}` : base;
}

/** "Sortiert nach Name, aufsteigend" */
export function sortText(sort: SortState): string {
  const label = ENTRY_COLUMN_LABELS[sort.column as EntryColumn] ?? sort.column;
  return `Sortiert nach ${label}, ${sort.dir === 1 ? 'aufsteigend' : 'absteigend'}`;
}
