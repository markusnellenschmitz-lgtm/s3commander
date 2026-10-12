import { describe, expect, it } from 'vitest';
import { compareEntries, compareNames, ENTRY_COLUMN_LABELS, kindOf, toSelectedItem } from './entry';
import { file, folder } from '../../../test/fakes';

describe('kindOf', () => {
  it.each([
    [folder('daily'), 'folder'],
    [file('keys.tar.zst.gpg'), 'lock'],
    [file('secret.age'), 'lock'],
    [file('old.bin', { storageClass: 'DEEP_ARCHIVE' }), 'lock'],
    [file('old.bin', { storageClass: 'GLACIER' }), 'lock'],
    [file('db.TAR.ZST'), 'archive'],
    [file('logs.gz'), 'archive'],
    [file('README.txt'), 'text'],
    [file('schema.sql'), 'text'],
    [file('photo.jpg'), 'file'],
    [file('no-extension', { storageClass: undefined }), 'file'],
  ])('%o → %s', (entry, kind) => {
    expect(kindOf(entry)).toBe(kind);
  });
});

describe('compareNames', () => {
  it('sortiert natürlich und ohne Groß-/Kleinschreibung', () => {
    expect(['file10', 'File2', 'file1'].sort(compareNames)).toEqual(['file1', 'File2', 'file10']);
  });
});

describe('compareEntries', () => {
  const entries = [
    file('b.txt', { size: 300, lastModified: 3, storageClass: 'STANDARD' }),
    folder('zeta'),
    file('a.txt', { size: 100, lastModified: 2, storageClass: 'STANDARD_IA' }),
    file('c.txt', { size: 100, lastModified: 1, storageClass: 'GLACIER_IR' }),
    folder('alpha'),
  ];
  const sortBy = (column: string, dir: 1 | -1) =>
    [...entries].sort((a, b) => compareEntries(a, b, { column, dir })).map((e) => e.name);

  it('stellt Ordner unabhängig von der Richtung voran', () => {
    expect(sortBy('name', 1).slice(0, 2)).toEqual(['alpha/', 'zeta/']);
    expect(sortBy('name', -1).slice(0, 2)).toEqual(['zeta/', 'alpha/']);
  });

  it('sortiert nach Größe mit Name als zweitem Kriterium', () => {
    expect(sortBy('size', 1).slice(2)).toEqual(['a.txt', 'c.txt', 'b.txt']);
    expect(sortBy('size', -1).slice(2)).toEqual(['b.txt', 'c.txt', 'a.txt']);
  });

  it('sortiert nach Änderungsdatum und Storage Class', () => {
    expect(sortBy('modified', 1).slice(2)).toEqual(['c.txt', 'a.txt', 'b.txt']);
    expect(sortBy('storageClass', 1).slice(2)).toEqual(['c.txt', 'b.txt', 'a.txt']);
  });

  it('fällt bei unbekannter Spalte auf den Namen zurück', () => {
    expect(sortBy('etag', 1).slice(2)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('behandelt fehlende Werte als kleinste', () => {
    const a = file('a', { size: undefined, lastModified: undefined, storageClass: undefined });
    const b = file('b', { size: 1, lastModified: 1, storageClass: 'X' });
    expect(compareEntries(a, b, { column: 'size', dir: 1 })).toBeLessThan(0);
    expect(compareEntries(a, b, { column: 'modified', dir: 1 })).toBeLessThan(0);
    expect(compareEntries(a, b, { column: 'storageClass', dir: 1 })).toBeLessThan(0);
  });
});

it('hat eine Beschriftung für jede Spalte', () => {
  expect(Object.keys(ENTRY_COLUMN_LABELS)).toEqual(['name', 'size', 'modified', 'storageClass', 'etag']);
});

describe('toSelectedItem', () => {
  it('übernimmt Key, Größe und ETag und markiert Ordner', () => {
    expect(toSelectedItem(file('a.bin', { size: 7, etag: '"e"', lastModified: 5 }))).toEqual({
      key: 'p/a.bin',
      isFolder: false,
      size: 7,
      etag: '"e"',
      lastModifiedMs: 5,
    });
    expect(toSelectedItem(folder('dir'))).toEqual({
      key: 'p/dir/',
      isFolder: true,
      size: 0,
      etag: null,
      lastModifiedMs: null,
    });
  });
});
