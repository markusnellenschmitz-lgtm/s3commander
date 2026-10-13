// Inhalt des offenen Ordners: setzt die Seiten eines Listings zur Datenquelle der Objekttabelle
// zusammen. Kleine Ordner liegen vollständig in einer ArraySource; sehr große bleiben im Backend,
// und eine WindowSource lädt nur sichtbare Fenster. Seiten aus dem Listing-Cache erscheinen
// sofort, frische ersetzen sie erst, wenn das Listing fertig ist.

import type { EntryQuery, FolderPage, WindowPort, WindowRef } from '../../core/backend';
import type { Selection } from '../../core/table/selection.svelte';
import type { SortState } from '../../core/table/types';
import { ArraySource } from '../objects/arraySource.svelte';
import type { S3Entry } from '../objects/entry';
import { filterSource, type ObjectSource } from '../objects/objectSource';
import { WindowSource } from '../objects/windowSource.svelte';
import { pageEntries } from './entryMapping';

/** Seiten werden höchstens so oft in die Tabelle übernommen, damit sie nicht ständig neu sortiert. */
export const FLUSH_INTERVAL_MS = 150;
/** Während ein großes Listing läuft, wird die Sicht so oft neu angelegt, damit neue Einträge erscheinen. */
export const WINDOW_REFRESH_MS = 2000;

export interface FolderContentPort extends WindowPort {
  releaseListing(listingId: number): Promise<void>;
}

export interface FolderContentDeps {
  port: FolderContentPort;
  selection: Selection;
  sort: SortState;
  schedule: (run: () => void, delayMs: number) => void;
  /** Fehler beim Laden von Fenstern (etwa Cache-Datei gesperrt). */
  onError: (error: unknown) => void;
}

export class FolderContent {
  source = $state.raw<ObjectSource>(new ArraySource([], { column: 'name', dir: 1 }));
  /** Bisher gelistete Einträge des laufenden Listings. */
  loadedCount = $state(0);
  /** Zeitpunkt des gespeicherten Listings, solange die Tabelle den Stand aus dem Cache zeigt. */
  cachedAtMs = $state<number | null>(null);

  readonly #deps: FolderContentDeps;
  readonly #array: ArraySource;
  #window = $state.raw<WindowSource | null>(null);
  #prefix = '';
  #sort: SortState;
  #query: EntryQuery | null = null;
  #pending: S3Entry[] = [];
  /** Frische Einträge, während die Tabelle noch den Stand aus dem Cache zeigt. */
  #live: S3Entry[] = [];
  /** Frisches, sehr großes Listing, während die Tabelle noch den Stand aus dem Cache zeigt. */
  #liveWindow: number | null = null;
  #flushPlanned = false;
  #refreshPlanned = false;

  constructor(deps: FolderContentDeps) {
    this.#deps = deps;
    this.#sort = deps.sort;
    this.#array = new ArraySource([], deps.sort);
    this.source = this.#array;
  }

  /** Eine Sicht auf ein großes Listing wird gerade angelegt; die Tabelle ist dann noch leer. */
  get isOpening(): boolean {
    return this.#window?.opening ?? false;
  }

  /** Neuer Ordner: leere Liste, Fenster des vorigen Ordners freigeben. */
  reset(prefix: string): void {
    this.#prefix = prefix;
    this.#releaseLiveWindow();
    this.#showArray([]);
    this.#pending = [];
    this.#live = [];
    this.loadedCount = 0;
    this.cachedAtMs = null;
  }

  /** Cache-Seiten und frische Seiten ohne Cache gehen in die Tabelle, frische nach Cache-Seiten in den Puffer. */
  receive(page: FolderPage): void {
    if (page.window) {
      this.#receiveWindow(page.cachedMs, page.window);
      return;
    }
    const entries = pageEntries(page, this.#prefix);
    if (page.cachedMs !== null) {
      this.cachedAtMs = page.cachedMs;
    } else if (this.cachedAtMs !== null) {
      this.#live.push(...entries);
      this.loadedCount += entries.length;
      return;
    } else {
      this.loadedCount += entries.length;
    }
    this.#pending.push(...entries);
    this.#planFlush();
  }

  /** Das Listing ist fertig: Den Stand aus dem Cache ersetzt jetzt das frische Listing. */
  finish(): void {
    if (this.cachedAtMs !== null) {
      const liveWindow = this.#liveWindow;
      this.#liveWindow = null;
      if (liveWindow !== null) this.#showWindow(liveWindow);
      else {
        this.#showArray(this.#live);
        this.#deps.selection.prune(this.#array);
      }
      this.#live = [];
      this.#pending = [];
      this.cachedAtMs = null;
    } else {
      this.#window?.refresh();
    }
  }

  /** Abgebrochen oder gescheitert: Ein nie gezeigtes frisches großes Listing wird freigegeben. */
  abort(): void {
    this.#releaseLiveWindow();
  }

  /** Übernimmt gesammelte Seiten sofort in die Tabelle. */
  flush(): void {
    this.#flushPlanned = false;
    const entries = this.#pending;
    this.#pending = [];
    this.#array.append(entries);
  }

  setSort(sort: SortState): void {
    this.#sort = sort;
    this.#array.setSort(sort);
    this.#window?.setSort(sort);
  }

  applyFilter(query: EntryQuery | null): void {
    this.#query = query;
    if (this.source !== this.#array) this.#array.setFilter(query);
    filterSource(this.source, this.#deps.selection, query);
  }

  /** Alle ausgewählten Einträge, bei großen Ordnern auch nicht geladene. */
  resolveSelected(): Promise<S3Entry[]> {
    return this.source.resolveSelected(this.#deps.selection);
  }

  #receiveWindow(cachedMs: number | null, window: WindowRef): void {
    if (cachedMs !== null) {
      this.cachedAtMs = cachedMs;
      this.#showWindow(window.listingId);
      return;
    }
    this.loadedCount = window.loaded;
    if (this.cachedAtMs !== null) {
      this.#liveWindow = window.listingId;
      this.#live = [];
    } else if (this.#window?.listingId === window.listingId) {
      this.#planWindowRefresh();
    } else {
      this.#showWindow(window.listingId);
    }
  }

  #showWindow(listingId: number): void {
    this.#disposeWindow();
    this.#pending = [];
    this.#array.replace([]);
    const selection = this.#deps.selection;
    this.#window = new WindowSource({
      port: this.#deps.port,
      listingId,
      prefix: this.#prefix,
      sort: this.#sort,
      filter: this.#query,
      retain: (key) => selection.rawKeys.has(key),
      onError: this.#deps.onError,
    });
    this.source = this.#window;
  }

  #showArray(entries: readonly S3Entry[]): void {
    this.#disposeWindow();
    this.#array.setFilter(this.#query);
    this.#array.replace(entries);
    this.source = this.#array;
  }

  #disposeWindow(): void {
    const window = this.#window;
    if (!window) return;
    this.#window = null;
    window.dispose();
    this.#release(window.listingId);
  }

  #releaseLiveWindow(): void {
    if (this.#liveWindow !== null) this.#release(this.#liveWindow);
    this.#liveWindow = null;
  }

  #release(listingId: number): void {
    void this.#deps.port.releaseListing(listingId).catch(() => {});
  }

  #planFlush(): void {
    if (this.#flushPlanned) return;
    this.#flushPlanned = true;
    this.#deps.schedule(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  #planWindowRefresh(): void {
    if (this.#refreshPlanned) return;
    this.#refreshPlanned = true;
    const window = this.#window;
    this.#deps.schedule(() => {
      this.#refreshPlanned = false;
      if (window && window === this.#window) window.refresh();
    }, WINDOW_REFRESH_MS);
  }
}
