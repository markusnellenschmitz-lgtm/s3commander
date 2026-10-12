// Wandelt Listing-Seiten des Backends in Einträge der Objekttabelle.

import type { ListPage, ObjectEntryDto } from '../../core/backend';
import type { S3Entry } from '../objects/entry';

function objectEntry(dto: ObjectEntryDto, prefix: string): S3Entry {
  return {
    key: dto.key,
    name: dto.key.slice(prefix.length),
    isPrefix: false,
    size: dto.size,
    lastModified: dto.lastModifiedMs ?? undefined,
    storageClass: dto.storageClass ?? undefined,
    etag: dto.etag ?? undefined,
  };
}

function folderEntry(key: string, prefix: string): S3Entry {
  return { key, name: key.slice(prefix.length), isPrefix: true };
}

/**
 * Einträge einer Seite. Ordner-Platzhalter (Objekt mit dem Key des Präfix selbst, wie ihn
 * die AWS-Konsole beim Anlegen eines Ordners erzeugt) werden ausgeblendet.
 */
export function pageEntries(page: ListPage, prefix: string): S3Entry[] {
  return [
    ...page.prefixes.map((key) => folderEntry(key, prefix)),
    ...page.objects.filter((o) => o.key !== prefix).map((o) => objectEntry(o, prefix)),
  ];
}

export interface Crumb {
  label: string;
  prefix: string;
}

/** Breadcrumb-Segmente eines Präfix: "a/b/" → [a → "a/", b → "a/b/"]. */
export function crumbs(prefix: string): Crumb[] {
  const parts = prefix.split('/').filter(Boolean);
  return parts.map((label, i) => ({ label, prefix: `${parts.slice(0, i + 1).join('/')}/` }));
}

/** Übergeordnetes Präfix: "a/b/" → "a/", "a/" → "". */
export function parentPrefix(prefix: string): string {
  const parts = prefix.split('/').filter(Boolean);
  return parts.length <= 1 ? '' : `${parts.slice(0, -1).join('/')}/`;
}
