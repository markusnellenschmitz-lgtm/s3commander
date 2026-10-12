import type { SortState } from './types';

/** Klick auf Spaltenkopf: gleiche Spalte kehrt die Richtung um, neue Spalte beginnt aufsteigend. */
export function nextSort(current: SortState | undefined, column: string): SortState {
  if (current?.column === column) return { column, dir: current.dir === 1 ? -1 : 1 };
  return { column, dir: 1 };
}
