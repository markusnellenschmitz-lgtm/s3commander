import { describe, expect, it } from 'vitest';
import { backupsBucket, BACKUPS_PREFIX, logName, logsBucket } from './buckets';
import { pseudoHex } from './pseudoHex';
import { listFolder, paginate } from './s3Listing';
import { formatBytes } from '../../core/format';

describe('pseudoHex', () => {
  it('ist deterministisch und hat die gewünschte Länge', () => {
    expect(pseudoHex(3, 32)).toHaveLength(32);
    expect(pseudoHex(3, 32)).toBe(pseudoHex(3, 32));
    expect(pseudoHex(3, 32)).not.toBe(pseudoHex(4, 32));
  });
});

describe('Bucket-Fixtures', () => {
  it('ergeben im Ordner backups/2026/10/ die 17 Objekte und 4 Ordner aus UI-SPEC §2', () => {
    const listing = listFolder(backupsBucket(), BACKUPS_PREFIX);
    expect(listing.objects).toHaveLength(17);
    expect(listing.prefixes).toEqual(['daily/', 'manifests/', 'wal/', 'weekly/'].map((p) => BACKUPS_PREFIX + p));
    const newest = listing.objects.find((o) => o.key.endsWith('db-full-20261011.tar.zst'))!;
    expect(formatBytes(newest.size)).toBe('4,74 GiB');
    expect(newest.etag).toMatch(/^"[0-9a-f]{32}-157"$/);
  });

  it('erzeugen sortierte Logdateien', () => {
    const logs = logsBucket(3);
    expect(logs.map((l) => l.key)).toEqual([...logs.map((l) => l.key)].sort());
    expect(logName(1) > logName(0)).toBe(true);
  });
});

describe('listFolder', () => {
  const objects = backupsBucket();

  it('liefert auf jeder Ebene nur direkte Objekte und Präfixe', () => {
    expect(listFolder(objects, '')).toEqual({ objects: [], prefixes: ['backups/'] });
    expect(listFolder(objects, 'backups/')).toEqual({ objects: [], prefixes: ['backups/2026/'] });
    expect(listFolder(objects, `${BACKUPS_PREFIX}wal/`).objects).toHaveLength(1);
    expect(listFolder(objects, 'gibt-es-nicht/')).toEqual({ objects: [], prefixes: [] });
  });
});

describe('paginate', () => {
  it('teilt in Seiten mit Fortsetzungs-Token und Präfixen zuerst', () => {
    const pages = paginate(listFolder(backupsBucket(), BACKUPS_PREFIX), 10);
    expect(pages).toHaveLength(3);
    expect(pages[0].prefixes).toHaveLength(4);
    expect(pages[0].objects).toHaveLength(6);
    expect(pages[0].nextToken).toBe('seite-1');
    expect(pages[2].nextToken).toBeNull();
    expect(pages.reduce((n, p) => n + p.objects.length + p.prefixes.length, 0)).toBe(21);
  });

  it('liefert für leere Ordner genau eine leere Seite', () => {
    expect(paginate({ objects: [], prefixes: [] }, 10)).toEqual([{ objects: [], prefixes: [], nextToken: null }]);
  });
});
