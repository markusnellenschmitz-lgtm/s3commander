// Windows-Pfade der lokalen Seite: Zwei-Panel-Ansicht und Ziele von Downloads.

const BACKSLASH = String.fromCharCode(92);

export interface LocalCrumb {
  label: string;
  path: string;
}

/** Ordner einer lokalen Datei ohne abschließenden Trenner, für Anzeigen wie „nach D:\Ziel“. */
export function localFolder(path: string): string {
  const end = Math.max(path.lastIndexOf('/'), path.lastIndexOf(BACKSLASH));
  return end > 0 ? path.slice(0, end) : path;
}

/** Elternordner zum Weiternavigieren; Laufwerke (`D:\`) haben keinen. */
export function localParent(path: string): string | null {
  const trimmed = path.endsWith(BACKSLASH) ? path.slice(0, -1) : path;
  const end = trimmed.lastIndexOf(BACKSLASH);
  if (end < 0) return null;
  const parent = trimmed.slice(0, end);
  return parent.includes(BACKSLASH) ? parent : `${parent}${BACKSLASH}`;
}

/** Letztes Segment eines Pfads. */
export function localName(path: string): string {
  return path.slice(path.lastIndexOf(BACKSLASH) + 1);
}

/** Pfadleiste: Laufwerk, dann jeder Ordner bis `path`. */
export function localCrumbs(path: string): LocalCrumb[] {
  const [drive, ...folders] = path.split(BACKSLASH).filter(Boolean);
  if (drive === undefined) return [];
  const crumbs: LocalCrumb[] = [{ label: drive, path: `${drive}${BACKSLASH}` }];
  let current = drive;
  for (const folder of folders) {
    current = `${current}${BACKSLASH}${folder}`;
    crumbs.push({ label: folder, path: current });
  }
  return crumbs;
}

/** Ob `path` gleich `dir` ist oder darin liegt; Windows unterscheidet keine Groß- und Kleinschreibung. */
export function isInsideLocal(path: string, dir: string): boolean {
  const normalize = (p: string) => (p.endsWith(BACKSLASH) ? p : `${p}${BACKSLASH}`).toLowerCase();
  return normalize(path).startsWith(normalize(dir));
}
