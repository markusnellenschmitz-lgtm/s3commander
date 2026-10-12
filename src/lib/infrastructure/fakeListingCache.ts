// Listing-Cache des Fake-Backends: dasselbe Verhalten wie der SQLite-Cache im Rust-Backend,
// nur im Arbeitsspeicher. Ein Listing ersetzt den gespeicherten Stand erst, wenn es vollständig ist.

import type { CacheStats, ListPage } from '../core/backend';

interface CachedListing {
  fetchedMs: number;
  pages: ListPage[];
}

/** Grobe Größe eines Eintrags in der Cache-Datei, damit die Einstellungen etwas anzeigen. */
const BYTES_PER_ENTRY = 160;

const folderKey = (profileId: string, bucket: string, prefix: string) => `${profileId}\n${bucket}\n${prefix}`;

export class FakeListingCache {
  readonly #listings = new Map<string, CachedListing>();

  load(profileId: string, bucket: string, prefix: string): CachedListing | undefined {
    return this.#listings.get(folderKey(profileId, bucket, prefix));
  }

  store(profileId: string, bucket: string, prefix: string, pages: ListPage[], fetchedMs: number): void {
    this.#listings.set(folderKey(profileId, bucket, prefix), { fetchedMs, pages });
  }

  forgetProfile(profileId: string): void {
    for (const key of this.#listings.keys()) {
      if (key.startsWith(`${profileId}\n`)) this.#listings.delete(key);
    }
  }

  clear(): void {
    this.#listings.clear();
  }

  stats(): CacheStats {
    let entries = 0;
    for (const { pages } of this.#listings.values()) {
      for (const page of pages) entries += page.objects.length + page.prefixes.length;
    }
    return { folders: this.#listings.size, entries, bytes: entries * BYTES_PER_ENTRY };
  }
}
