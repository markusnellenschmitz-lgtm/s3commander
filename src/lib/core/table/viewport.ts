// Viewport-Berechnung für virtuelle Listen mit fester Zeilenhöhe.
//
// Chromium begrenzt die Höhe eines Elements auf etwa 33 Mio. px. Über MAX_SCROLL_PX
// wird der Scrollbereich gedeckelt und die Scrollposition proportional auf Zeilen
// abgebildet ("skaliert"). Darunter entspricht 1 px Scrollen genau 1 px Inhalt.

/** Zeilenhöhen laut Tokens row-height / row-height-compact und Höhe des Tabellenkopfs. */
export const ROW_HEIGHT = 28;
export const ROW_HEIGHT_COMPACT = 24;
export const HEADER_HEIGHT = 28;

export const MAX_SCROLL_PX = 15_000_000;
export const DEFAULT_OVERSCAN = 10;

export interface ViewportInput {
  scrollTop: number;
  /** Sichtbare Höhe des Scroll-Containers inklusive Kopfzeile. */
  clientHeight: number;
  headerHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan?: number;
  maxScrollPx?: number;
}

export interface Viewport {
  /** Höhe des Platzhalters für den Scrollbereich. */
  spacerPx: number;
  scaled: boolean;
  /** Erste sichtbare Zeile als Gleitkommazahl. */
  firstExact: number;
  /** Erste gerenderte Zeile (inklusive Overscan). */
  start: number;
  /** Erste nicht mehr gerenderte Zeile. */
  end: number;
  /** Verschiebung des gerenderten Fensters relativ zum Platzhalter. */
  offsetPx: number;
  /** Anzahl sichtbarer Zeilen als Gleitkommazahl. */
  visibleRows: number;
  /** Höchster Wert für firstExact. */
  maxFirst: number;
  /** Scrollbare Strecke in px. */
  scrollable: number;
}

export function computeViewport(input: ViewportInput): Viewport {
  const { rowHeight, rowCount } = input;
  const overscan = input.overscan ?? DEFAULT_OVERSCAN;
  const maxScrollPx = input.maxScrollPx ?? MAX_SCROLL_PX;

  const viewportPx = Math.max(0, input.clientHeight - input.headerHeight);
  const visibleRows = viewportPx / rowHeight;
  const totalPx = rowCount * rowHeight;
  const spacerPx = Math.min(totalPx, maxScrollPx);
  const scaled = totalPx > maxScrollPx;
  const scrollable = Math.max(1, spacerPx - viewportPx);
  const maxFirst = Math.max(0, rowCount - visibleRows);
  const scrollTop = Math.max(0, Math.min(input.scrollTop, scrollable));

  const firstExact = scaled ? (scrollTop / scrollable) * maxFirst : Math.min(scrollTop / rowHeight, maxFirst);
  const start = Math.max(0, Math.floor(firstExact) - overscan);
  const end = Math.min(rowCount, Math.ceil(firstExact + visibleRows) + overscan);
  const offsetPx = scaled ? scrollTop - (firstExact - start) * rowHeight : start * rowHeight;

  return { spacerPx, scaled, firstExact, start, end, offsetPx, visibleRows, maxFirst, scrollable };
}

/**
 * Scrollposition, bei der die Zeile index vollständig sichtbar ist.
 * null, wenn sie bereits sichtbar ist.
 */
export function scrollTopToReveal(vp: Viewport, index: number, rowHeight: number): number | null {
  const fullRows = Math.max(1, Math.floor(vp.visibleRows));
  let first: number;
  if (index < vp.firstExact) first = index;
  else if (index + 1 > vp.firstExact + fullRows) first = index + 1 - fullRows;
  else return null;
  return vp.scaled ? (first / Math.max(1, vp.maxFirst)) * vp.scrollable : first * rowHeight;
}

/** Erste sichtbare Zeile beim Wechsel der Zeilenhöhe halten (nur unskaliert sinnvoll). */
export function scrollTopForRowHeightChange(scrollTop: number, oldHeight: number, newHeight: number): number {
  return (scrollTop / oldHeight) * newHeight;
}
