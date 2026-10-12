import { describe, expect, it } from 'vitest';
import { MetadataEditor, NEW_METADATA_NAME } from './metadataEditor.svelte';

const saved = [
  { name: 'cache-control', value: 'no-store' },
  { name: 'x-amz-meta-owner', value: 'ops' },
];

function editor() {
  const e = new MetadataEditor();
  e.load(saved);
  return e;
}

describe('MetadataEditor', () => {
  it('zählt geänderte, neue und entfernte Einträge', () => {
    const e = editor();
    expect([e.changeCount, e.isValid]).toEqual([0, true]);
    const [cache, owner] = e.rows;
    e.edit(cache.id);
    expect(e.rows[0].editing).toBe(true);
    e.setValue(cache.id, 'max-age=60');
    e.setName(cache.id, 'ignoriert');
    expect(e.rows[0].name).toBe('cache-control');
    e.remove(owner.id);
    e.add();
    expect(e.rows.at(-1)).toMatchObject({ name: NEW_METADATA_NAME, value: '', original: null, editing: true });
    expect(e.changeCount).toBe(3);
    expect(e.isDirty(e.rows[0])).toBe(true);
  });

  it('meldet ungültige und doppelte Namen und liefert normalisierte Einträge', () => {
    const e = editor();
    e.add();
    const added = e.rows.at(-1)!;
    expect(e.error(added)).not.toBeNull();
    e.setName(added.id, ' X-Amz-Meta-Owner ');
    expect(e.error(added)).toBe('„X-Amz-Meta-Owner“ kommt mehrfach vor');
    e.setName(added.id, 'x-amz-meta-retention');
    e.setValue(added.id, 'ü');
    expect(e.isValid).toBe(false);
    e.setValue(added.id, ' 90d ');
    expect(e.isValid).toBe(true);
    expect(e.entries.at(-1)).toEqual({ name: 'x-amz-meta-retention', value: '90d' });
    e.edit(999);
    e.setValue(999, 'x');
    e.discard();
    expect([e.changeCount, e.rows.length]).toEqual([0, 2]);
  });
});
