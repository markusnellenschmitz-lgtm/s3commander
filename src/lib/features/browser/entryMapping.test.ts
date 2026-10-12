import { describe, expect, it } from 'vitest';
import { crumbs, pageEntries, parentPrefix } from './entryMapping';

describe('pageEntries', () => {
  it('macht aus Präfixen Ordner und aus Objekten Dateien mit relativem Namen', () => {
    const entries = pageEntries(
      {
        prefixes: ['a/b/'],
        objects: [
          { key: 'a/', size: 0, lastModifiedMs: null, etag: null, storageClass: null },
          { key: 'a/x.txt', size: 5, lastModifiedMs: 7, etag: '"e"', storageClass: 'STANDARD' },
        ],
        nextToken: null,
      },
      'a/',
    );
    expect(entries).toEqual([
      { key: 'a/b/', name: 'b/', isPrefix: true },
      {
        key: 'a/x.txt',
        name: 'x.txt',
        isPrefix: false,
        size: 5,
        lastModified: 7,
        storageClass: 'STANDARD',
        etag: '"e"',
      },
    ]);
  });

  it('lässt fehlende Werte undefiniert', () => {
    const [entry] = pageEntries(
      {
        prefixes: [],
        objects: [{ key: 'k', size: 1, lastModifiedMs: null, etag: null, storageClass: null }],
        nextToken: null,
      },
      '',
    );
    expect(entry).toMatchObject({ lastModified: undefined, etag: undefined, storageClass: undefined });
  });
});

describe('Pfad-Hilfen', () => {
  it('zerlegt Präfixe in Breadcrumb-Segmente', () => {
    expect(crumbs('')).toEqual([]);
    expect(crumbs('backups/2026/')).toEqual([
      { label: 'backups', prefix: 'backups/' },
      { label: '2026', prefix: 'backups/2026/' },
    ]);
  });

  it('bestimmt das übergeordnete Präfix', () => {
    expect(parentPrefix('a/b/c/')).toBe('a/b/');
    expect(parentPrefix('a/')).toBe('');
    expect(parentPrefix('')).toBe('');
  });
});
