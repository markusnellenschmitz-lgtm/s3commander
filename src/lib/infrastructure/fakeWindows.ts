// Fenster des Fake-Backends: dasselbe Verhalten wie die Sichten im Rust-Backend
// (`application/windows.rs`, `adapters/sqlite_windows.rs`), nur im Arbeitsspeicher.

import type { EntryQuery, ListPage, ViewInfo, WindowEntryDto, WindowPort } from '../core/backend';
import type { SortState } from '../core/table/types';
import { compareEntries } from '../features/objects/entry';
import { entryMatcher } from '../features/objects/objectFilter';
import { fromWindowEntry } from '../features/objects/windowSource.svelte';

/** Wie `MAX_OPEN_VIEWS` im Backend. */
export const FAKE_MAX_OPEN_VIEWS = 4;
/** Wie `MAX_WINDOW_ENTRIES` im Backend. */
const MAX_WINDOW_ENTRIES = 10_000;

interface FakeListing {
  prefix: string;
  entries: Map<string, WindowEntryDto>;
}

function pageDtos(page: ListPage): WindowEntryDto[] {
  return [
    ...page.prefixes.map((key) => ({
      key,
      isPrefix: true,
      size: 0,
      lastModifiedMs: null,
      etag: null,
      storageClass: null,
    })),
    ...page.objects.map((o) => ({ ...o, isPrefix: false })),
  ];
}

export class FakeWindows implements WindowPort {
  readonly #listings = new Map<number, FakeListing>();
  readonly #views = new Map<number, WindowEntryDto[]>();
  #nextListing = 1;
  #nextView = 1;

  /** Legt ein Listing aus Seiten an und liefert seine Kennung. */
  createListing(prefix: string, pages: readonly ListPage[]): number {
    const id = this.#nextListing++;
    this.#listings.set(id, { prefix, entries: new Map() });
    for (const page of pages) this.append(id, page);
    return id;
  }

  append(listingId: number, page: ListPage): void {
    const listing = this.#listings.get(listingId);
    if (!listing) return;
    for (const dto of pageDtos(page)) listing.entries.set(dto.key, dto);
  }

  release(listingId: number): void {
    this.#listings.delete(listingId);
  }

  get openViews(): number {
    return this.#views.size;
  }

  async openWindow(listingId: number, filter: EntryQuery | null, sort: SortState): Promise<ViewInfo> {
    const listing = this.#listings.get(listingId);
    const all = listing ? [...listing.entries.values()].filter((dto) => dto.key !== listing.prefix) : [];
    const prefix = listing?.prefix ?? '';
    const matches = filter ? entryMatcher(filter) : () => true;
    const rows = all
      .map((dto) => ({ dto, entry: fromWindowEntry(dto, prefix) }))
      .filter(({ entry }) => matches(entry))
      .sort((a, b) => compareEntries(a.entry, b.entry, sort))
      .map(({ dto }) => dto);
    const viewId = this.#nextView++;
    this.#views.set(viewId, rows);
    for (const id of [...this.#views.keys()].slice(0, Math.max(0, this.#views.size - FAKE_MAX_OPEN_VIEWS))) {
      this.#views.delete(id);
    }
    const stats = {
      count: rows.length,
      folders: rows.filter((dto) => dto.isPrefix).length,
      bytes: rows.reduce((sum, dto) => sum + dto.size, 0),
      total: all.length,
    };
    return { viewId, stats };
  }

  async windowEntries(viewId: number, offset: number, limit: number): Promise<WindowEntryDto[]> {
    return this.#view(viewId).slice(offset, offset + Math.min(limit, MAX_WINDOW_ENTRIES));
  }

  async windowSelection(viewId: number, excluded: string[]): Promise<WindowEntryDto[]> {
    const skip = new Set(excluded);
    return this.#view(viewId).filter((dto) => !skip.has(dto.key));
  }

  async closeWindow(viewId: number): Promise<void> {
    this.#views.delete(viewId);
  }

  #view(viewId: number): WindowEntryDto[] {
    const rows = this.#views.get(viewId);
    if (!rows) throw { kind: 'cache', message: `Listing-Cache nicht verfügbar: Sicht ${viewId} ist nicht geöffnet` };
    return rows;
  }
}
