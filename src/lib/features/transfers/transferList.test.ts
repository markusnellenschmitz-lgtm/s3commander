import { describe, expect, it } from 'vitest';
import { TransferList } from './transferList.svelte';
import { transfer } from '../../../test/transfers';

describe('TransferList', () => {
  it('sortiert beim Ersetzen nach ID und zählt die Version hoch', () => {
    const list = new TransferList();
    list.replace([transfer({ id: 3 }), transfer({ id: 1 })]);
    expect(list.all.map((t) => t.id)).toEqual([1, 3]);
    expect(list.version).toBe(1);
  });

  it('übernimmt Änderungen an Ort und Stelle, neue ans Ende, entfernte heraus', () => {
    const list = new TransferList();
    list.replace([transfer({ id: 1 }), transfer({ id: 2 })]);
    const before = list.all;
    list.apply({ changed: [transfer({ id: 1, state: 'done' }), transfer({ id: 5 })], removed: [2] });
    expect(list.all.map((t) => [t.id, t.state])).toEqual([
      [1, 'done'],
      [5, 'active'],
    ]);
    expect(list.all).not.toBe(before);
  });
});
