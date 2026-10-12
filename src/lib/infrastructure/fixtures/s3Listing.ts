// Ordner-Listing wie ListObjectsV2 mit Delimiter "/": Objekte direkt unter dem Präfix und
// gemeinsame Präfixe der tieferen Ebenen. Nur für das Fake-Backend.

import type { ListPage, ObjectEntryDto } from '../../core/backend';

const DELIMITER = '/';

export interface FolderListing {
  objects: ObjectEntryDto[];
  prefixes: string[];
}

export function listFolder(objects: readonly ObjectEntryDto[], prefix: string): FolderListing {
  const direct: ObjectEntryDto[] = [];
  const prefixes = new Set<string>();
  for (const object of objects) {
    if (!object.key.startsWith(prefix)) continue;
    const rest = object.key.slice(prefix.length);
    const cut = rest.indexOf(DELIMITER);
    if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
    else direct.push(object);
  }
  return { objects: direct, prefixes: [...prefixes].sort() };
}

/** Zerlegt ein Listing in Seiten zu höchstens pageSize Einträgen (Präfixe zuerst). */
export function paginate(listing: FolderListing, pageSize: number): ListPage[] {
  const entries = [...listing.prefixes.map((p) => ({ prefix: p })), ...listing.objects.map((o) => ({ object: o }))];
  const pages: ListPage[] = [];
  for (let start = 0; start < entries.length || pages.length === 0; start += pageSize) {
    const chunk = entries.slice(start, start + pageSize);
    const more = start + pageSize < entries.length;
    pages.push({
      prefixes: chunk.flatMap((e) => ('prefix' in e ? [e.prefix] : [])),
      objects: chunk.flatMap((e) => ('object' in e ? [e.object] : [])),
      nextToken: more ? `seite-${pages.length + 1}` : null,
    });
  }
  return pages;
}
