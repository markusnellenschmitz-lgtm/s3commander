// Fenster aus sehr großen Ordnern: Die Einträge liegen im Backend (Listing im SQLite-Cache),
// sortiert und gefiltert in einer Sicht. Die Quelle holt nur Seiten um den sichtbaren Bereich und
// vergisst lange nicht gezeigte wieder; Einträge der Auswahl bleiben bekannt.

import type { EntryQuery, ViewInfo, WindowEntryDto, WindowPort, WindowStats } from '../../core/backend';
import type { Selection } from '../../core/table/selection.svelte';
import type { SortState } from '../../core/table/types';
import type { S3Entry } from './entry';
import type { ObjectSource } from './objectSource';

/** Zeilen je nachgeladener Seite. */
export const WINDOW_PAGE_SIZE = 500;
/** So viele Seiten bleiben geladen (25.000 Zeilen); länger nicht gezeigte werden vergessen. */
export const MAX_LOADED_PAGES = 50;
/** Höchstens so viele Zeilen je Anfrage (Backend: `MAX_WINDOW_ENTRIES`). */
const MAX_ROWS_PER_REQUEST = 10_000;
const PAGES_PER_REQUEST = MAX_ROWS_PER_REQUEST / WINDOW_PAGE_SIZE;

const NO_STATS: WindowStats = { count: 0, folders: 0, bytes: 0, total: 0 };

export interface WindowSourceOptions {
  port: WindowPort;
  listingId: number;
  /** Präfix des Ordners; Namen sind Keys ohne ihn. */
  prefix: string;
  sort: SortState;
  filter: EntryQuery | null;
  /** Schlüssel, deren Einträge auch nach dem Vergessen ihrer Seite bekannt bleiben (Auswahl). */
  retain?: (key: string) => boolean;
  onError?: (error: unknown) => void;
}

/** Eintrag eines Fensters als Zeile der Objekttabelle. */
export function fromWindowEntry(dto: WindowEntryDto, prefix: string): S3Entry {
  const entry: S3Entry = { key: dto.key, name: dto.key.slice(prefix.length), isPrefix: dto.isPrefix };
  if (dto.isPrefix) return entry;
  return {
    ...entry,
    size: dto.size,
    lastModified: dto.lastModifiedMs ?? undefined,
    storageClass: dto.storageClass ?? undefined,
    etag: dto.etag ?? undefined,
  };
}

const pageOf = (index: number) => Math.floor(index / WINDOW_PAGE_SIZE);

export class WindowSource implements ObjectSource {
  version = $state(0);
  /** Eine Sicht wird gerade angelegt (Öffnen, Sortieren, Filtern, Aktualisieren). */
  opening = $state(false);
  readonly isComplete = false;
  readonly listingId: number;
  /** Erfüllt, sobald die zuletzt angeforderte Sicht offen ist. */
  ready: Promise<void>;

  readonly #port: WindowPort;
  readonly #prefix: string;
  readonly #retain: (key: string) => boolean;
  readonly #onError: (error: unknown) => void;
  #sort: SortState;
  #filter: EntryQuery | null;
  #view: ViewInfo | null = null;
  /** Zählt Sichten; Antworten zu älteren werden verworfen. */
  #generation = 0;
  /** Geladene Seiten; die Reihenfolge der Map ist die der letzten Nutzung. */
  #pages = new Map<number, S3Entry[]>();
  #requested = new Set<number>();
  #indexByKey = new Map<string, number>();
  #remembered = new Map<string, S3Entry>();
  /** Zuletzt angeforderter Bereich; wird nach dem Öffnen einer Sicht geladen. */
  #wanted: [start: number, end: number] | null = null;

  constructor(options: WindowSourceOptions) {
    this.#port = options.port;
    this.listingId = options.listingId;
    this.#prefix = options.prefix;
    this.#sort = options.sort;
    this.#filter = options.filter;
    this.#retain = options.retain ?? (() => false);
    this.#onError = options.onError ?? (() => {});
    this.ready = this.#open();
  }

  get length(): number {
    return this.#stats.count;
  }

  get totalCount(): number {
    return this.#stats.total;
  }

  get isFiltered(): boolean {
    return this.#filter !== null;
  }

  get totalBytes(): number {
    return this.#stats.bytes;
  }

  get folderCount(): number {
    return this.#stats.folders;
  }

  get(index: number): S3Entry | undefined {
    return this.#pages.get(pageOf(index))?.[index % WINDOW_PAGE_SIZE];
  }

  keyAt(index: number): string | undefined {
    return this.get(index)?.key;
  }

  /** Position eines geladenen Eintrags; -1, wenn seine Seite nicht geladen ist. */
  indexOfKey(key: string): number {
    return this.#indexByKey.get(key) ?? -1;
  }

  sizeOfKey(key: string): number {
    return this.#entryOf(key)?.size ?? 0;
  }

  /** Lädt die Seiten des sichtbaren Bereichs und je eine davor und danach. */
  ensureRange(start: number, end: number): void {
    this.#wanted = [start, end];
    if (!this.#view || this.length === 0) return;
    const first = Math.max(0, pageOf(start) - 1);
    const last = Math.min(pageOf(this.length - 1), pageOf(Math.max(start, end - 1)) + 1);
    for (let page = first; page <= last; page++) {
      if (this.#touch(page)) continue;
      if (!this.#requested.has(page)) void this.#load(page, page);
    }
    this.#forgetOldPages();
  }

  /** Lädt einen ganzen Bereich, etwa bevor eine Bereichsauswahl seine Schlüssel braucht. */
  async ensureLoaded(start: number, end: number): Promise<void> {
    await this.ready;
    const last = Math.min(pageOf(this.length - 1), pageOf(end));
    const loads: Promise<void>[] = [];
    for (let page = pageOf(start); page <= last; page += PAGES_PER_REQUEST) {
      const upTo = Math.min(last, page + PAGES_PER_REQUEST - 1);
      if (!this.#hasPages(page, upTo)) loads.push(this.#load(page, upTo));
    }
    await Promise.all(loads);
  }

  setSort(sort: SortState): void {
    this.#sort = sort;
    this.ready = this.#open();
  }

  setFilter(query: EntryQuery | null): void {
    this.#filter = query;
    this.ready = this.#open();
  }

  /** Neue Sicht mit derselben Sortierung, etwa weil das Listing im Hintergrund gewachsen ist. */
  refresh(): void {
    this.ready = this.#open();
  }

  async resolveSelected(selection: Selection): Promise<S3Entry[]> {
    await this.ready;
    if (selection.isInverted) {
      if (!this.#view) return [];
      const entries = await this.#port.windowSelection(this.#view.viewId, [...selection.rawKeys]);
      return entries.map((dto) => fromWindowEntry(dto, this.#prefix));
    }
    const known = [...selection.rawKeys]
      .map((key) => this.#entryOf(key))
      .filter((entry): entry is S3Entry => entry !== undefined);
    const position = (entry: S3Entry) => this.#indexByKey.get(entry.key) ?? Number.MAX_SAFE_INTEGER;
    return known.sort((a, b) => position(a) - position(b));
  }

  /** Schließt die Sicht; spätere Antworten werden ignoriert. */
  dispose(): void {
    this.#generation++;
    const view = this.#view;
    this.#view = null;
    this.#clearPages();
    if (view) void this.#port.closeWindow(view.viewId).catch(() => {});
  }

  get #stats(): WindowStats {
    return this.#view?.stats ?? NO_STATS;
  }

  #entryOf(key: string): S3Entry | undefined {
    const index = this.#indexByKey.get(key);
    return (index === undefined ? undefined : this.get(index)) ?? this.#remembered.get(key);
  }

  async #open(): Promise<void> {
    const generation = ++this.#generation;
    this.opening = true;
    try {
      const view = await this.#port.openWindow(this.listingId, this.#filter, this.#sort);
      if (generation !== this.#generation) {
        void this.#port.closeWindow(view.viewId).catch(() => {});
        return;
      }
      const previous = this.#view;
      this.#view = view;
      this.#clearPages();
      this.version++;
      if (previous) void this.#port.closeWindow(previous.viewId).catch(() => {});
      if (this.#wanted) this.ensureRange(...this.#wanted);
    } catch (error) {
      if (generation === this.#generation) this.#onError(error);
    } finally {
      if (generation === this.#generation) this.opening = false;
    }
  }

  async #load(firstPage: number, lastPage: number): Promise<void> {
    const view = this.#view;
    if (!view) return;
    const generation = this.#generation;
    for (let page = firstPage; page <= lastPage; page++) this.#requested.add(page);
    try {
      const offset = firstPage * WINDOW_PAGE_SIZE;
      const limit = (lastPage - firstPage + 1) * WINDOW_PAGE_SIZE;
      const entries = await this.#port.windowEntries(view.viewId, offset, limit);
      if (generation !== this.#generation) return;
      this.#store(
        firstPage,
        entries.map((dto) => fromWindowEntry(dto, this.#prefix)),
      );
      this.version++;
    } catch (error) {
      if (generation === this.#generation) this.#onError(error);
    } finally {
      if (generation === this.#generation) {
        for (let page = firstPage; page <= lastPage; page++) this.#requested.delete(page);
      }
    }
  }

  #store(firstPage: number, entries: S3Entry[]): void {
    for (let start = 0; start < entries.length; start += WINDOW_PAGE_SIZE) {
      const page = firstPage + start / WINDOW_PAGE_SIZE;
      const rows = entries.slice(start, start + WINDOW_PAGE_SIZE);
      this.#pages.delete(page);
      this.#pages.set(page, rows);
      rows.forEach((entry, i) => this.#indexByKey.set(entry.key, page * WINDOW_PAGE_SIZE + i));
    }
  }

  #hasPages(first: number, last: number): boolean {
    for (let page = first; page <= last; page++) if (!this.#pages.has(page)) return false;
    return true;
  }

  /** Markiert eine geladene Seite als zuletzt genutzt; false, wenn sie nicht geladen ist. */
  #touch(page: number): boolean {
    const rows = this.#pages.get(page);
    if (!rows) return false;
    this.#pages.delete(page);
    this.#pages.set(page, rows);
    return true;
  }

  /** Vergisst die am längsten nicht genutzten Seiten; Einträge der Auswahl bleiben bekannt. */
  #forgetOldPages(): void {
    if (this.#pages.size <= MAX_LOADED_PAGES) return;
    for (const key of this.#remembered.keys()) if (!this.#retain(key)) this.#remembered.delete(key);
    for (const [page, rows] of this.#pages) {
      if (this.#pages.size <= MAX_LOADED_PAGES) break;
      this.#pages.delete(page);
      for (const entry of rows) {
        this.#indexByKey.delete(entry.key);
        if (this.#retain(entry.key)) this.#remembered.set(entry.key, entry);
      }
    }
  }

  #clearPages(): void {
    for (const rows of this.#pages.values()) {
      for (const entry of rows) if (this.#retain(entry.key)) this.#remembered.set(entry.key, entry);
    }
    this.#pages.clear();
    this.#requested.clear();
    this.#indexByKey.clear();
  }
}
