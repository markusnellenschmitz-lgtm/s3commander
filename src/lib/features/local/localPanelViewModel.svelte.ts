// Linke Seite der Zwei-Panel-Ansicht (Screen 3): lokale Laufwerke und Ordner durchsuchen.
// Einträge werden wie Objekte dargestellt (Pfad als Key), damit Tabelle, Sortierung und Auswahl
// dieselben bleiben wie auf der Bucket-Seite.

import type { BackendError, BackendPort, LocalEntry } from '../../core/backend';
import { toBackendError } from '../../core/backend';
import { isInsideLocal, localCrumbs, localParent, type LocalCrumb } from '../../core/localPath';
import { Selection } from '../../core/table/selection.svelte';
import type { SortState } from '../../core/table/types';
import { ArraySource } from '../objects/arraySource.svelte';
import type { S3Entry } from '../objects/entry';
import { selectedBytes, selectedEntries } from '../objects/objectSource';
import { DEFAULT_SORT } from '../browser/browserViewModel.svelte';

/** Oberste Ebene: die Laufwerke. */
export const THIS_PC = 'Dieser PC';

/** Spalten, die es lokal nicht gibt. */
export const LOCAL_HIDDEN_COLUMNS = ['storageClass', 'etag'] as const;

export interface LocalPanelDeps {
  backend: BackendPort;
}

export function toEntry(entry: LocalEntry): S3Entry {
  return {
    key: entry.path,
    name: entry.name,
    isPrefix: entry.isDir,
    size: entry.isDir ? undefined : entry.size,
    lastModified: entry.modifiedMs ?? undefined,
  };
}

export class LocalPanelViewModel {
  /** Offener Ordner; null zeigt die Laufwerke. */
  path = $state<string | null>(null);
  sort = $state<SortState>(DEFAULT_SORT);
  loading = $state(false);
  error = $state<BackendError | null>(null);
  /** Ob schon einmal etwas geladen wurde; die Ansicht lädt beim ersten Zeigen. */
  started = $state(false);
  readonly source = new ArraySource([], DEFAULT_SORT);
  readonly selection = new Selection();

  readonly #backend: BackendPort;
  #request = 0;
  #refreshQueued = false;

  constructor(deps: LocalPanelDeps) {
    this.#backend = deps.backend;
  }

  /** Öffnet einen Ordner oder mit null die Laufwerke. */
  async open(path: string | null): Promise<void> {
    const request = ++this.#request;
    this.started = true;
    this.path = path;
    this.loading = true;
    this.error = null;
    this.selection.clear();
    try {
      const entries = await this.#backend.listLocalDir(path);
      if (request !== this.#request) return;
      this.source.replace(entries.map(toEntry));
    } catch (error) {
      if (request !== this.#request) return;
      this.source.replace([]);
      this.error = toBackendError(error);
    } finally {
      if (request === this.#request) this.loading = false;
    }
  }

  /** Beim ersten Zeigen der Zwei-Panel-Ansicht. */
  ensureStarted(): void {
    if (!this.started) void this.open(null);
  }

  /** Enter oder Doppelklick: Ordner und Laufwerke öffnen. */
  openEntry(entry: S3Entry): void {
    if (entry.isPrefix) void this.open(entry.key);
  }

  goUp(): void {
    if (this.path !== null) void this.open(localParent(this.path));
  }

  refresh(): void {
    void this.open(this.path);
  }

  /** Nach Downloads: neu laden, wenn der geänderte Ordner im offenen liegt; mehrere Meldungen ergeben ein Neuladen. */
  refreshIfShowing(dir: string): void {
    const path = this.path;
    if (path === null || !isInsideLocal(dir, path) || this.#refreshQueued) return;
    this.#refreshQueued = true;
    queueMicrotask(() => {
      this.#refreshQueued = false;
      this.refresh();
    });
  }

  changeSort(sort: SortState): void {
    this.sort = sort;
    this.source.setSort(sort);
  }

  /** Rücktaste oder Alt+↑ eine Ebene hoch, F5 neu laden; true, wenn behandelt. */
  handleShortcut(key: string, alt: boolean): boolean {
    if (key === 'Backspace' || (alt && key === 'ArrowUp')) this.goUp();
    else if (key === 'F5') this.refresh();
    else return false;
    return true;
  }

  get canGoUp(): boolean {
    return this.path !== null;
  }

  get crumbs(): LocalCrumb[] {
    return this.path === null ? [] : localCrumbs(this.path);
  }

  /** Gewählte Dateien und Ordner; Laufwerke lassen sich nicht hochladen. */
  get selectedPaths(): string[] {
    void this.source.version;
    if (this.path === null) return [];
    return selectedEntries(this.selection, this.source).map((entry) => entry.key);
  }

  get selectedBytes(): number {
    void this.source.version;
    return selectedBytes(this.selection, this.source);
  }

  get tableLabel(): string {
    return this.path === null ? THIS_PC : `Lokal: ${this.path}`;
  }
}
