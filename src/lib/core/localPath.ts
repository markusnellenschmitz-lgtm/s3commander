// Lokale Pfade der Zwei-Panel-Ansicht und Ziele von Downloads, unter Windows (`D:\Ziel`) wie unter
// Linux (`/home/anna`). Welche Schreibweise gilt, ergibt sich aus dem Pfad selbst.

const BACKSLASH = String.fromCharCode(92);
const SLASH = '/';

export interface LocalCrumb {
  label: string;
  path: string;
}

/** Linux-Pfade beginnen mit `/`, Windows-Pfade mit dem Laufwerk. */
function isPosix(path: string): boolean {
  return path.startsWith(SLASH);
}

function separatorOf(path: string): string {
  return isPosix(path) ? SLASH : BACKSLASH;
}

/** Ordner einer lokalen Datei ohne abschließenden Trenner, für Anzeigen wie „nach D:\Ziel“. */
export function localFolder(path: string): string {
  const end = Math.max(path.lastIndexOf(SLASH), path.lastIndexOf(BACKSLASH));
  return end > 0 ? path.slice(0, end) : path;
}

/** Elternordner zum Weiternavigieren; Laufwerke (`D:\`) und die Wurzel `/` haben keinen. */
export function localParent(path: string): string | null {
  const separator = separatorOf(path);
  const trimmed = path.length > 1 && path.endsWith(separator) ? path.slice(0, -1) : path;
  const end = trimmed.lastIndexOf(separator);
  if (end < 0 || trimmed === SLASH) return null;
  const parent = trimmed.slice(0, end);
  if (isPosix(path)) return parent || SLASH;
  return parent.includes(BACKSLASH) ? parent : `${parent}${BACKSLASH}`;
}

/** Letztes Segment eines Pfads. */
export function localName(path: string): string {
  return path.slice(path.lastIndexOf(separatorOf(path)) + 1);
}

/** Pfadleiste: Laufwerk oder `/`, dann jeder Ordner bis `path`. */
export function localCrumbs(path: string): LocalCrumb[] {
  const separator = separatorOf(path);
  const folders = path.split(separator).filter(Boolean);
  const drive = isPosix(path) ? '' : folders.shift();
  if (drive === undefined) return [];
  const crumbs: LocalCrumb[] = [{ label: drive || SLASH, path: `${drive}${separator}` }];
  let current = drive;
  for (const folder of folders) {
    current = `${current}${separator}${folder}`;
    crumbs.push({ label: folder, path: current });
  }
  return crumbs;
}

/** Ob `path` gleich `dir` ist oder darin liegt; Windows unterscheidet keine Groß- und Kleinschreibung, Linux schon. */
export function isInsideLocal(path: string, dir: string): boolean {
  const separator = separatorOf(dir);
  const normalize = (p: string) => {
    const withSeparator = p.endsWith(separator) ? p : `${p}${separator}`;
    return isPosix(dir) ? withSeparator : withSeparator.toLowerCase();
  };
  return normalize(path).startsWith(normalize(dir));
}
