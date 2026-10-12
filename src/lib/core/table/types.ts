import type { Snippet } from 'svelte';

/**
 * Datenquelle der virtuellen Tabelle. Die Tabelle fragt nur sichtbare Indizes ab,
 * daher kann eine Quelle Millionen Einträge halten oder sie seitenweise aus dem
 * Backend nachladen (get liefert dann undefined, die Zeile erscheint als Skeleton).
 */
export interface RowSource<T> {
  /** Anzahl Zeilen, inklusive noch nicht geladener. */
  readonly length: number;
  /** Reaktiver Zähler; jede Änderung an Daten oder Reihenfolge erhöht ihn. */
  readonly version: number;
  get(index: number): T | undefined;
  /** Schlüssel ohne Objekt-Erzeugung, für Bereichsauswahl über viele Zeilen. */
  keyAt(index: number): string | undefined;
  /** Position eines Schlüssels in der aktuellen Sortierung, -1 wenn unbekannt. */
  indexOfKey(key: string): number;
  /** Optional: Bereich wird gleich angezeigt, bitte laden. */
  ensureRange?(start: number, end: number): void;
}

export interface Column<T> {
  id: string;
  label: string;
  /** Grid-Spur, z. B. "104px" oder "minmax(260px, 1fr)". Spuren mit fr sind nicht verstellbar. */
  width: string;
  minWidth?: number;
  align?: 'start' | 'end';
  /** Sekundärfarbe (Größen, Zeiten, Metadaten). */
  meta?: boolean;
  mono?: boolean;
  /** 12 px statt 13 px (Storage Class, ETag). */
  small?: boolean;
  sortable?: boolean;
  /** Spalte erst ab dieser Fensterbreite zeigen (ETag unter 1440 px aus). */
  minWindowWidth?: number;
  /** Einfache Textzelle. Ohne text wird das cell-Snippet der Tabelle aufgerufen. */
  text?: (row: T) => string;
  cell?: Snippet<[T]>;
}

export type SortDir = 1 | -1;
export interface SortState {
  column: string;
  dir: SortDir;
}
