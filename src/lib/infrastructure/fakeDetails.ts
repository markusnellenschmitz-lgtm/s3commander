// Simulierte Objekt-Details für das Fake-Backend: Metadaten, Tags, Versionen, ACL und
// vorsignierte Links. Versionierte Buckets haben Beispielversionen samt Delete Marker.

import type {
  BackendError,
  MetadataEntry,
  ObjectAcl,
  ObjectAt,
  ObjectEntryDto,
  ObjectHead,
  ObjectTag,
  ObjectVersion,
} from '../core/backend';

const MAX_TAGS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  zst: 'application/zstd',
  gz: 'application/gzip',
  zip: 'application/zip',
  tar: 'application/x-tar',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  sql: 'application/sql',
};
const SYSTEM_METADATA = new Set([
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'expires',
]);

export const FAKE_ACL: ObjectAcl = {
  owner: 'ops-team',
  grants: [{ grantee: 'ops-team', isPublic: false, permission: 'FULL_CONTROL' }],
};

const notFound = (key: string): BackendError => ({
  kind: 'service',
  message: `NoSuchKey: ${key} gibt es nicht (HTTP 404)`,
  service: { code: 'NoSuchKey', message: `${key} gibt es nicht`, httpStatus: 404, requestId: null },
});

const invalid = (message: string): BackendError => ({ kind: 'invalidDetails', message });

function contentType(key: string): string {
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export class FakeObjectDetails {
  readonly #metadata = new Map<string, MetadataEntry[]>();
  readonly #tags = new Map<string, ObjectTag[]>();
  readonly #versions = new Map<string, ObjectVersion[]>();
  readonly #objectsOf: (bucket: string) => ObjectEntryDto[];
  readonly #isVersioned: (bucket: string) => boolean;
  readonly #now: () => number;
  #nextVersion = 1;

  constructor(
    objectsOf: (bucket: string) => ObjectEntryDto[],
    isVersioned: (bucket: string) => boolean,
    now: () => number = Date.now,
  ) {
    this.#objectsOf = objectsOf;
    this.#isVersioned = isVersioned;
    this.#now = now;
  }

  head(at: ObjectAt): ObjectHead {
    const object = this.#object(at);
    return {
      size: object.size,
      contentType: contentType(at.key),
      etag: object.etag,
      storageClass: object.storageClass ?? 'STANDARD',
      lastModifiedMs: object.lastModifiedMs,
      versionId: this.versions(at).find((v) => v.isLatest)?.versionId ?? null,
      metadata: [...(this.#metadata.get(this.#id(at)) ?? [{ name: 'cache-control', value: 'no-store' }])],
      encryption: object.storageClass === 'GLACIER_IR' ? 'aws:kms' : 'AES256',
    };
  }

  saveMetadata(at: ObjectAt, metadata: MetadataEntry[]): void {
    const object = this.#object(at);
    const named = metadata.map((m) => ({ name: m.name.trim().toLowerCase(), value: m.value.trim() }));
    const wrong = named.find((m) => !SYSTEM_METADATA.has(m.name) && !/^x-amz-meta-[a-z0-9_-]+$/.test(m.name));
    if (wrong) throw invalid(`„${wrong.name}“ ist kein gültiger Metadaten-Name`);
    this.#metadata.set(this.#id(at), named);
    this.#addVersion(at, object.size);
  }

  tags(at: ObjectAt): ObjectTag[] {
    this.#object(at);
    return [...(this.#tags.get(this.#id(at)) ?? [])];
  }

  saveTags(at: ObjectAt, tags: ObjectTag[]): void {
    this.#object(at);
    if (tags.length > MAX_TAGS) throw invalid('Ein Objekt kann höchstens 10 Tags haben');
    this.#tags.set(
      this.#id(at),
      tags.map((t) => ({ ...t })),
    );
  }

  versions(at: ObjectAt): ObjectVersion[] {
    const object = this.#object(at);
    const id = this.#id(at);
    if (!this.#versions.has(id)) this.#versions.set(id, this.#sampleVersions(at, object));
    return (this.#versions.get(id) ?? []).map((v) => ({ ...v }));
  }

  restoreVersion(at: ObjectAt, versionId: string): void {
    const version = this.versions(at).find((v) => v.versionId === versionId && !v.isDeleteMarker);
    if (!version) throw notFound(`${at.key}?versionId=${versionId}`);
    this.#object(at).size = version.size;
    this.#addVersion(at, version.size);
  }

  deleteVersion(at: ObjectAt, versionId: string): void {
    const remaining = this.versions(at).filter((v) => v.versionId !== versionId);
    if (remaining.length > 0 && !remaining.some((v) => v.isLatest)) remaining[0].isLatest = true;
    this.#versions.set(this.#id(at), remaining);
  }

  acl(at: ObjectAt): ObjectAcl {
    this.#object(at);
    return structuredClone(FAKE_ACL);
  }

  presign(at: ObjectAt, expiresSecs: number): string {
    this.#object(at);
    const path = at.key.split('/').map(encodeURIComponent).join('/');
    return `https://${at.bucket}.s3.example.invalid/${path}?X-Amz-Expires=${expiresSecs}&X-Amz-Signature=vorschau`;
  }

  #object(at: ObjectAt): ObjectEntryDto {
    const object = this.#objectsOf(at.bucket).find((o) => o.key === at.key);
    if (!object) throw notFound(at.key);
    return object;
  }

  #id(at: ObjectAt): string {
    return `${at.profileId}/${at.bucket}/${at.key}`;
  }

  #sampleVersions(at: ObjectAt, object: ObjectEntryDto): ObjectVersion[] {
    const modified = object.lastModifiedMs ?? this.#now();
    if (!this.#isVersioned(at.bucket)) {
      return [
        { versionId: 'null', isLatest: true, isDeleteMarker: false, lastModifiedMs: modified, size: object.size },
      ];
    }
    return [
      {
        versionId: '3HL4kqtJlcpXroDT',
        isLatest: true,
        isDeleteMarker: false,
        lastModifiedMs: modified,
        size: object.size,
      },
      {
        versionId: 'Wq9XzTn2bY0eLm4R',
        isLatest: false,
        isDeleteMarker: true,
        lastModifiedMs: modified - DAY_MS / 2,
        size: 0,
      },
      {
        versionId: 'p7Kd2sVb9QeR1aXc',
        isLatest: false,
        isDeleteMarker: false,
        lastModifiedMs: modified - DAY_MS,
        size: Math.round(object.size * 0.99),
      },
    ];
  }

  #addVersion(at: ObjectAt, size: number): void {
    if (!this.#isVersioned(at.bucket)) return;
    const versions = this.versions(at).map((v) => ({ ...v, isLatest: false }));
    const latest = {
      versionId: `neu-${this.#nextVersion++}`,
      isLatest: true,
      isDeleteMarker: false,
      lastModifiedMs: this.#now(),
      size,
    };
    this.#versions.set(this.#id(at), [latest, ...versions]);
  }
}
