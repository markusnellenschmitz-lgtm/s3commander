// Gemeinsame Regeln für Drop-Ziele in Objekttabellen (Explorer-Drop und Ziehen zwischen den
// Panels): Ziel ist die Ordnerzeile unter dem Mauszeiger, sonst der offene Ordner.

import type { S3Entry } from './entry';
import type { ObjectSource } from './objectSource';

/** CSS-Klasse der Ordnerzeile, auf die abgelegt wird (fixes.css). */
export const DROP_ROW_CLASS = 'is-drop';

/** Ordnerzeile unter dem Mauszeiger; Dateizeilen und leere Flächen ergeben undefined. */
export function folderAt(source: ObjectSource, rowIndex: number | null): S3Entry | undefined {
  void source.version;
  const entry = rowIndex === null ? undefined : source.get(rowIndex);
  return entry?.isPrefix ? entry : undefined;
}

/** Klasse für eine Tabellenzeile: nur die Zielordner-Zeile wird hervorgehoben. */
export function dropRowClass(folder: S3Entry | undefined, entry: S3Entry): string {
  return folder?.key === entry.key ? DROP_ROW_CLASS : '';
}
