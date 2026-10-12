import { describe, expect, it } from 'vitest';
import { clampColumnWidth, DEFAULT_MIN_COLUMN_WIDTH, gridTemplate, isResizable, visibleColumns } from './columns';
import { nextSort } from './sort';
import type { Column } from './types';

const name: Column<unknown> = { id: 'name', label: 'Name', width: 'minmax(260px, 1fr)' };
const size: Column<unknown> = { id: 'size', label: 'Größe', width: '104px', minWidth: 80 };
const etag: Column<unknown> = { id: 'etag', label: 'ETag', width: '300px', minWindowWidth: 1440 };

describe('Spalten', () => {
  it('blendet Spalten unter ihrer Mindestfensterbreite aus', () => {
    expect(visibleColumns([name, size, etag], 1439).map((c) => c.id)).toEqual(['name', 'size']);
    expect(visibleColumns([name, size, etag], 1440).map((c) => c.id)).toEqual(['name', 'size', 'etag']);
  });

  it('baut die Grid-Spuren mit Auswahlspalte und Überschreibungen', () => {
    expect(gridTemplate([name, size], {})).toBe('28px minmax(260px, 1fr) 104px');
    expect(gridTemplate([name, size], { size: 150 })).toBe('28px minmax(260px, 1fr) 150px');
  });

  it('verstellt nur feste Spuren', () => {
    expect(isResizable(name)).toBe(false);
    expect(isResizable(size)).toBe(true);
  });

  it('begrenzt Breiten nach unten und rundet', () => {
    expect(clampColumnWidth(size, 20)).toBe(80);
    expect(clampColumnWidth(size, 120.6)).toBe(121);
    expect(clampColumnWidth(etag, 1)).toBe(DEFAULT_MIN_COLUMN_WIDTH);
  });
});

describe('nextSort', () => {
  it('beginnt neue Spalten aufsteigend', () => {
    expect(nextSort(undefined, 'size')).toEqual({ column: 'size', dir: 1 });
    expect(nextSort({ column: 'name', dir: -1 }, 'size')).toEqual({ column: 'size', dir: 1 });
  });

  it('kehrt bei gleicher Spalte die Richtung um', () => {
    expect(nextSort({ column: 'size', dir: 1 }, 'size')).toEqual({ column: 'size', dir: -1 });
    expect(nextSort({ column: 'size', dir: -1 }, 'size')).toEqual({ column: 'size', dir: 1 });
  });
});
