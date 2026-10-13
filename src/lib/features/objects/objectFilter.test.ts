import { describe, expect, it } from 'vitest';
import { entryMatcher, filterQuery, isActive, namePattern, NO_FILTER, type ObjectFilter } from './objectFilter';
import { file, folder } from '../../../test/fakes';

const NOW = new Date(2026, 9, 11, 12).getTime();
const DAY = 24 * 60 * 60 * 1000;
const MiB = 1024 ** 2;

const entries = [
  folder('backups'),
  file('db.tar.zst', { size: 300 * MiB, lastModified: NOW - DAY / 2 }),
  file('notiz.txt', { size: 2 * 1024, lastModified: NOW - 3 * DAY }),
  file('video.mp4', { size: 2 * 1024 * MiB, lastModified: NOW - 400 * DAY }),
  file('geheim.gpg', { size: 50 * MiB, lastModified: undefined }),
];

function names(filter: Partial<ObjectFilter>): string[] {
  const query = filterQuery({ ...NO_FILTER, ...filter }, NOW);
  const matches = query ? entryMatcher(query) : () => true;
  return entries.filter(matches).map((e) => e.name);
}

describe('Objektfilter', () => {
  it('ist ohne Angaben inaktiv', () => {
    expect(isActive(NO_FILTER)).toBe(false);
    expect(filterQuery(NO_FILTER, NOW)).toBeNull();
    expect(isActive({ ...NO_FILTER, text: '  ' })).toBe(false);
    expect(isActive({ ...NO_FILTER, date: 'week' })).toBe(true);
  });

  it('sucht Namensteile ohne Groß/klein und mit Platzhalter', () => {
    expect(names({ text: 'TAR' })).toEqual(['db.tar.zst']);
    expect(names({ text: 'n*.txt' })).toEqual(['notiz.txt']);
    expect(names({ text: '(' })).toEqual([]);
    expect(namePattern('')).toBeNull();
    expect(namePattern('a.b')?.test('axb')).toBe(false);
  });

  it('filtert nach Typ, Größe und Datum', () => {
    expect(names({ kind: 'folder' })).toEqual(['backups/']);
    expect(names({ kind: 'lock' })).toEqual(['geheim.gpg']);
    expect(names({ size: 'small' })).toEqual(['notiz.txt']);
    expect(names({ size: 'large' })).toEqual(['db.tar.zst']);
    expect(names({ size: 'huge' })).toEqual(['video.mp4']);
    expect(names({ date: 'today' })).toEqual(['db.tar.zst']);
    expect(names({ date: 'week' })).toEqual(['db.tar.zst', 'notiz.txt']);
    expect(names({ date: 'older' })).toEqual(['video.mp4']);
    expect(names({ text: 'gp', size: 'medium' })).toEqual(['geheim.gpg']);
    expect(names({ text: 'gp', size: 'small' })).toEqual([]);
  });

  it('übersetzt die Auswahl in absolute Grenzen für das Backend', () => {
    expect(filterQuery({ ...NO_FILTER, text: ' db ', kind: 'archive' }, NOW)).toEqual({
      text: 'db',
      kind: 'archive',
      minSize: null,
      maxSize: null,
      modifiedFrom: null,
      modifiedTo: null,
    });
    expect(filterQuery({ ...NO_FILTER, size: 'huge' }, NOW)).toMatchObject({ minSize: 1024 * MiB, maxSize: null });
    expect(filterQuery({ ...NO_FILTER, size: 'small' }, NOW)).toMatchObject({ minSize: 0, maxSize: MiB });
    expect(filterQuery({ ...NO_FILTER, date: 'week' }, NOW)).toMatchObject({
      modifiedFrom: NOW - 7 * DAY,
      modifiedTo: NOW,
    });
    expect(filterQuery({ ...NO_FILTER, date: 'older' }, NOW)).toMatchObject({
      modifiedFrom: null,
      modifiedTo: NOW - 365 * DAY,
    });
  });
});
