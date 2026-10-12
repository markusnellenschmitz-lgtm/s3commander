import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, OPTIONAL_COLUMNS, VIEW_STORAGE_KEY, ViewPreferences } from './viewPreferences.svelte';
import type { KeyValueStore } from './themeViewModel.svelte';

function store(initial: string | null = null): KeyValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== null) values.set(VIEW_STORAGE_KEY, initial);
  return { values, get: (key) => values.get(key) ?? null, set: (key, value) => values.set(key, value) };
}

describe('ViewPreferences', () => {
  it('startet mit Standardwerten und speichert Änderungen', () => {
    const s = store();
    const prefs = new ViewPreferences(s);
    expect(prefs.value).toEqual(DEFAULT_VIEW);
    prefs.update({ compact: true, hiddenColumns: ['etag'] });
    expect(JSON.parse(s.values.get(VIEW_STORAGE_KEY)!)).toEqual({
      autoConnect: true,
      compact: true,
      hiddenColumns: ['etag'],
    });
    expect(new ViewPreferences(s).value.compact).toBe(true);
  });

  it('übergeht kaputte und unbekannte Werte', () => {
    expect(new ViewPreferences(store('{kaputt')).value).toEqual(DEFAULT_VIEW);
    const mixed = new ViewPreferences(store('{"autoConnect":"ja","compact":true,"hiddenColumns":["name","size",3]}'));
    expect(mixed.value).toEqual({ autoConnect: true, compact: true, hiddenColumns: ['size'] });
    expect(new ViewPreferences(store('{"hiddenColumns":"size"}')).value.hiddenColumns).toEqual([]);
  });

  it('bietet alle Spalten außer dem Namen zum Ausblenden an', () => {
    expect(OPTIONAL_COLUMNS.map((c) => c.label)).toEqual(['Größe', 'Geändert', 'Storage Class', 'ETag']);
  });
});
