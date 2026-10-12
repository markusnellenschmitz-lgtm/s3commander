// Vollständig geladene Liste eines Präfix. Für sehr große Listings kommt eine Quelle,
// die Fenster aus dem Rust-Backend (SQLite-Cache) nachlädt, mit derselben Schnittstelle.

import type { SortState } from '../../core/table/types';
import { compareEntries, type S3Entry } from './entry';
import type { ObjectSource } from './objectSource';

export class ArraySource implements ObjectSource {
  version = $state(0);
  /** Alle geladenen Einträge, sortiert. */
  #all: S3Entry[] = [];
  /** Sichtbare Einträge: alle oder die Treffer des Filters. */
  #rows: S3Entry[] = [];
  #index = new Map<string, number>();
  #sort: SortState;
  #filter: ((entry: S3Entry) => boolean) | null = null;

  constructor(rows: readonly S3Entry[], sort: SortState) {
    this.#sort = sort;
    this.replace(rows);
  }

  get length(): number {
    return this.#rows.length;
  }

  /** Anzahl aller geladenen Einträge, auch der vom Filter ausgeblendeten. */
  get totalCount(): number {
    return this.#all.length;
  }

  get isFiltered(): boolean {
    return this.#filter !== null;
  }

  get(index: number): S3Entry | undefined {
    return this.#rows[index];
  }

  keyAt(index: number): string | undefined {
    return this.#rows[index]?.key;
  }

  indexOfKey(key: string): number {
    return this.#index.get(key) ?? -1;
  }

  sizeOfKey(key: string): number {
    const index = this.#index.get(key);
    return index === undefined ? 0 : (this.#rows[index].size ?? 0);
  }

  get totalBytes(): number {
    return this.#rows.reduce((sum, row) => sum + (row.size ?? 0), 0);
  }

  get folderCount(): number {
    return this.#rows.filter((row) => row.isPrefix).length;
  }

  replace(rows: readonly S3Entry[]): void {
    this.#all = rows.slice();
    this.#applySort();
  }

  /** Hängt Einträge an und sortiert neu. Für Listings seitenweise gebündelt aufrufen. */
  append(rows: readonly S3Entry[]): void {
    if (rows.length === 0) return;
    for (const row of rows) this.#all.push(row);
    this.#applySort();
  }

  setSort(sort: SortState): void {
    this.#sort = sort;
    this.#applySort();
  }

  /** Zeigt nur Einträge, für die `filter` true liefert; null zeigt wieder alle. */
  setFilter(filter: ((entry: S3Entry) => boolean) | null): void {
    this.#filter = filter;
    this.#applyFilter();
  }

  #applySort(): void {
    const sort = this.#sort;
    this.#all.sort((a, b) => compareEntries(a, b, sort));
    this.#applyFilter();
  }

  #applyFilter(): void {
    const filter = this.#filter;
    this.#rows = filter ? this.#all.filter(filter) : this.#all;
    this.#index = new Map(this.#rows.map((row, i) => [row.key, i]));
    this.version++;
  }
}
