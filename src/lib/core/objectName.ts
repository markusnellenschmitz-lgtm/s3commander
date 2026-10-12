// Regeln für neue Namen von Ordnern und Objekten. Gleiche Regeln und Texte wie
// src-tauri/src/domain/naming.rs; das Backend prüft verbindlich, hier gibt es sofortige Rückmeldung.

/** S3 erlaubt Keys bis 1.024 Bytes (UTF-8). */
export const MAX_KEY_BYTES = 1024;

const CONTROL = /\p{Cc}/u;

/** Fehlertext für einen Namen im Ordner `prefix`; null, wenn er verwendbar ist. */
export function nameError(name: string, prefix: string, isFolder: boolean): string | null {
  if (name.trim() === '') return 'Bitte einen Namen eingeben';
  if (name.includes('/')) return 'Der Name darf keinen Schrägstrich enthalten';
  if (name === '.' || name === '..') return '„.“ und „..“ sind als Name nicht erlaubt';
  if (CONTROL.test(name)) return 'Der Name darf keine Steuerzeichen enthalten';
  const key = `${prefix}${name}${isFolder ? '/' : ''}`;
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) {
    return 'Der vollständige Key darf höchstens 1.024 Bytes lang sein';
  }
  return null;
}

/** Ordner, in dem ein Key liegt: "a/b/c.txt" → "a/b/", "a/b/" → "a/", "c.txt" → "". */
export function parentOfKey(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
}

/** Freier Name bei Konflikten wie im Backend: "bild.jpg" → "bild (2).jpg", ".env" → ".env (2)". */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** Letztes Segment ohne abschließenden Schrägstrich: "a/b/" → "b", "a/c.txt" → "c.txt". */
export function baseName(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}
