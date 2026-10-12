// Spaltenlogik der Datentabelle: Sichtbarkeit nach Fensterbreite und Grid-Spuren.

import type { Column } from './types';

/** Breite der festen Auswahlspalte (Checkbox). */
export const CHECKBOX_COLUMN = '28px';
export const DEFAULT_MIN_COLUMN_WIDTH = 48;

export type WidthOverrides = Readonly<Record<string, number>>;

export function visibleColumns<T>(columns: readonly Column<T>[], windowWidth: number): Column<T>[] {
  return columns.filter((c) => !c.minWindowWidth || windowWidth >= c.minWindowWidth);
}

/** Flexible Spuren (mit fr) passen sich an und sind nicht verstellbar. */
export function isResizable<T>(column: Column<T>): boolean {
  return !column.width.includes('fr');
}

export function gridTemplate<T>(columns: readonly Column<T>[], overrides: WidthOverrides): string {
  const tracks = columns.map((c) => (overrides[c.id] !== undefined ? `${overrides[c.id]}px` : c.width));
  return [CHECKBOX_COLUMN, ...tracks].join(' ');
}

export function clampColumnWidth<T>(column: Column<T>, width: number): number {
  return Math.max(column.minWidth ?? DEFAULT_MIN_COLUMN_WIDTH, Math.round(width));
}
