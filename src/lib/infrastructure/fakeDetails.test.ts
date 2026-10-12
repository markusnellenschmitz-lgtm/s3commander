import { describe, expect, it } from 'vitest';
import { FAKE_ACL, FakeObjectDetails } from './fakeDetails';
import type { ObjectEntryDto } from '../core/backend';

const NOW = 1_000_000_000_000;

function setup(versioned = true) {
  const objects: ObjectEntryDto[] = [
    { key: 'a/db.tar.zst', size: 1000, lastModifiedMs: NOW, etag: '"e"', storageClass: null },
    { key: 'a/notiz.unbekannt', size: 5, lastModifiedMs: null, etag: null, storageClass: 'GLACIER' },
  ];
  const details = new FakeObjectDetails(
    () => objects,
    () => versioned,
    () => NOW,
  );
  return { details, objects };
}

const at = (key = 'a/db.tar.zst') => ({ profileId: 'p', bucket: 'b', key });

describe('FakeObjectDetails', () => {
  it('liefert Kopfdaten mit Typ, Storage Class, Version und Beispiel-Metadaten', () => {
    const { details } = setup();
    expect(details.head(at())).toEqual({
      size: 1000,
      contentType: 'application/zstd',
      etag: '"e"',
      storageClass: 'STANDARD',
      lastModifiedMs: NOW,
      versionId: '3HL4kqtJlcpXroDT',
      metadata: [{ name: 'cache-control', value: 'no-store' }],
      encryption: 'AES256',
    });
    const other = details.head(at('a/notiz.unbekannt'));
    expect([other.contentType, other.storageClass]).toEqual(['application/octet-stream', 'GLACIER']);
    expect(() => details.head(at('fehlt'))).toThrow();
    try {
      details.tags(at('fehlt'));
    } catch (error) {
      expect(error).toMatchObject({ kind: 'service', service: { code: 'NoSuchKey', httpStatus: 404 } });
    }
  });

  it('speichert Metadaten als neue Version und prüft Namen', () => {
    const { details } = setup();
    details.saveMetadata(at(), [{ name: ' X-Amz-Meta-Retention ', value: ' 90d ' }]);
    expect(details.head(at()).metadata).toEqual([{ name: 'x-amz-meta-retention', value: '90d' }]);
    expect(details.versions(at())[0]).toMatchObject({ versionId: 'neu-1', isLatest: true, lastModifiedMs: NOW });
    expect(() => details.saveMetadata(at(), [{ name: 'authorization', value: 'x' }])).toThrow(/kein gültiger/);
  });

  it('speichert Tags bis zum Limit', () => {
    const { details } = setup();
    expect(details.tags(at())).toEqual([]);
    details.saveTags(at(), [{ key: 'env', value: 'prod' }]);
    expect(details.tags(at())).toEqual([{ key: 'env', value: 'prod' }]);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: '' }));
    expect(() => details.saveTags(at(), eleven)).toThrow(/höchstens 10/);
  });

  it('stellt Versionen wieder her und löscht sie endgültig', () => {
    const { details, objects } = setup();
    expect(details.versions(at()).map((v) => v.isDeleteMarker)).toEqual([false, true, false]);
    details.restoreVersion(at(), 'p7Kd2sVb9QeR1aXc');
    expect(objects[0].size).toBe(990);
    expect(details.versions(at())).toHaveLength(4);
    expect(() => details.restoreVersion(at(), 'Wq9XzTn2bY0eLm4R')).toThrow();
    details.deleteVersion(at(), 'neu-1');
    expect(details.versions(at())[0]).toMatchObject({ versionId: '3HL4kqtJlcpXroDT', isLatest: true });
    for (const v of details.versions(at())) details.deleteVersion(at(), v.versionId);
    expect(details.versions(at())).toEqual([]);
  });

  it('kennt unversionierte Buckets, ACL und vorsignierte Links', () => {
    const { details } = setup(false);
    expect(details.versions(at())).toEqual([
      { versionId: 'null', isLatest: true, isDeleteMarker: false, lastModifiedMs: NOW, size: 1000 },
    ]);
    details.saveMetadata(at(), []);
    expect(details.versions(at())).toHaveLength(1);
    expect(details.acl(at())).toEqual(FAKE_ACL);
    expect(details.presign(at('a/db.tar.zst'), 60)).toBe(
      'https://b.s3.example.invalid/a/db.tar.zst?X-Amz-Expires=60&X-Amz-Signature=vorschau',
    );
    expect(details.versions(at('a/notiz.unbekannt'))[0].lastModifiedMs).toBe(NOW);
  });
});
