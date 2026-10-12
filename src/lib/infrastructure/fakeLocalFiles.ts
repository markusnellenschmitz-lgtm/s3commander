// Lokales Dateisystem des Fake-Backends für die Zwei-Panel-Ansicht (Screen 3, UI-SPEC:
// „D: › Backups › db-prod“). Fertige Downloads legen hier ihre Dateien ab.

import type { LocalEntry } from '../core/backend';
import { localName as nameOf, localParent as parentOf } from '../core/localPath';

const MiB = 1024 ** 2;
const NOW = new Date(2026, 9, 12, 6, 0).getTime();

interface FakeFile {
  size: number;
  modifiedMs: number;
}

const SEED: Record<string, number> = {
  'D:\\Backups\\db-prod\\db-incr-20261012-0600.tar.zst': 305 * MiB,
  'D:\\Backups\\db-prod\\db-incr-20261012-1200.tar.zst': 305.7 * MiB,
  'D:\\Backups\\db-prod\\checksums.sha256': 412,
  'D:\\Backups\\db-prod\\alt\\db-full-20261001.tar.zst': 4_812 * MiB,
  'D:\\Backups\\fotos\\urlaub-2026.zip': 1_210 * MiB,
  'C:\\Daten\\Projekte\\angebot.pdf': 2.4 * MiB,
  'C:\\Daten\\notizen.txt': 3_120,
};

export class FakeLocalFiles {
  readonly #files = new Map<string, FakeFile>();
  readonly #dirs = new Set<string>(['C:\\', 'D:\\']);

  constructor() {
    for (const [path, size] of Object.entries(SEED)) this.addFile(path, Math.round(size), NOW);
  }

  roots(): LocalEntry[] {
    return [...this.#dirs]
      .filter((dir) => parentOf(dir) === null)
      .sort()
      .map((path) => ({ name: path.slice(0, -1), path, isDir: true, size: 0, modifiedMs: null }));
  }

  list(dir: string): LocalEntry[] {
    if (!this.#dirs.has(dir)) throw { kind: 'localFile', message: `Lokale Datei: ${dir}: Pfad nicht gefunden` };
    const folders = [...this.#dirs]
      .filter((path) => parentOf(path) === dir)
      .map((path) => ({ name: nameOf(path), path, isDir: true, size: 0, modifiedMs: NOW }));
    const files = [...this.#files]
      .filter(([path]) => parentOf(path) === dir)
      .map(([path, file]) => ({ name: nameOf(path), path, isDir: false, ...file }));
    return [...folders, ...files];
  }

  /** Alle Dateien unter `dir`, mit Pfad relativ zu `dir` (`/` getrennt). */
  walk(dir: string): { path: string; relative: string; size: number; modifiedMs: number }[] {
    if (!this.#dirs.has(dir)) throw { kind: 'localFile', message: `Lokale Datei: ${dir}: Pfad nicht gefunden` };
    const base = dir.endsWith('\\') ? dir : `${dir}\\`;
    return [...this.#files]
      .filter(([path]) => path.startsWith(base))
      .map(([path, file]) => ({ path, relative: path.slice(base.length).replaceAll('\\', '/'), ...file }));
  }

  /** Legt eine Datei samt fehlender Ordner an, z. B. nach einem Download. */
  addFile(path: string, size: number, modifiedMs = Date.now()): void {
    this.#files.set(path, { size, modifiedMs });
    for (let dir = parentOf(path); dir !== null; dir = parentOf(dir)) this.#dirs.add(dir);
  }
}
