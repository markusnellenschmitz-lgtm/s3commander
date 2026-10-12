// Gemeinsame Schnittstelle aller Quellen der Objekttabelle.

import type { RowSource, SortState } from '../../core/table/types';
import type { Selection } from '../../core/table/selection.svelte';
import type { S3Entry } from './entry';

export interface ObjectSource extends RowSource<S3Entry> {
  setSort(sort: SortState): void;
  /** Zeigt nur passende Einträge; null zeigt alle. Länge und Zugriffe beziehen sich auf die Treffer. */
  setFilter(filter: ((entry: S3Entry) => boolean) | null): void;
  /** Alle geladenen Einträge, auch ausgeblendete. */
  readonly totalCount: number;
  readonly isFiltered: boolean;
  /** Größe des Objekts zum Auswahlschlüssel, 0 für Ordner oder Unbekanntes. */
  sizeOfKey(key: string): number;
  readonly totalBytes: number;
  readonly folderCount: number;
}

/** Alle ausgewählten und bereits geladenen Einträge in Anzeigereihenfolge, auch im invertierten Modus. */
export function selectedEntries(selection: Selection, source: ObjectSource): S3Entry[] {
  if (selection.isInverted) {
    const entries: S3Entry[] = [];
    for (let i = 0; i < source.length; i++) {
      const entry = source.get(i);
      if (entry && selection.has(entry.key)) entries.push(entry);
    }
    return entries;
  }
  return [...selection.rawKeys]
    .map((key) => source.indexOfKey(key))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
    .map((index) => source.get(index))
    .filter((entry): entry is S3Entry => entry !== undefined);
}

/** Summe der Bytes aller ausgewählten Objekte, auch im invertierten Auswahlmodus. */
export function selectedBytes(selection: Selection, source: ObjectSource): number {
  let sum = 0;
  for (const key of selection.rawKeys) sum += source.sizeOfKey(key);
  return selection.isInverted ? source.totalBytes - sum : sum;
}
