import { describe, expect, it } from 'vitest';
import { decodeRowSlot, filterTransfers, summarizeTransfers, transferRowSlots } from './transferSummary';
import { FAKE_UPLOAD_ERROR } from '../../infrastructure/fakeTransfers';
import { transfer } from '../../../test/transfers';

describe('Kennzahlen der Transfers', () => {
  it('zählt Zustände und Wartepositionen in einem Durchlauf', () => {
    const summary = summarizeTransfers([
      transfer({ id: 1, state: 'waiting' }),
      transfer({ id: 2, state: 'active', bytesPerSec: 4 }),
      transfer({ id: 3, state: 'waiting' }),
      transfer({ id: 4, state: 'skipped', totalBytes: 999 }),
    ]);
    expect(summary.counts).toEqual({ all: 4, active: 1, waiting: 2, done: 1, failed: 0 });
    expect(summary.byState.skipped).toBe(1);
    expect([...summary.waitingPositions]).toEqual([
      [1, 1],
      [3, 2],
    ]);
    expect(summary.current?.id).toBe(2);
    expect(summary.totals.speeds).toEqual({ upload: 4 });
  });

  it('kommt ohne Transfers aus', () => {
    const summary = summarizeTransfers([]);
    expect(summary.totals).toEqual({
      doneBytes: 0,
      totalBytes: 0,
      percent: 0,
      bytesPerSec: 0,
      speeds: {},
      restSeconds: Number.POSITIVE_INFINITY,
    });
    expect(summary.current).toBeUndefined();
  });

  it('bleibt bei 100.000 Transfers schnell', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => transfer({ id: i + 1, state: i % 3 ? 'waiting' : 'done' }));
    const started = performance.now();
    const summary = summarizeTransfers(many);
    const slots = transferRowSlots(filterTransfers(many, 'waiting'));
    expect(summary.counts.waiting).toBe(66_666);
    expect(slots).toHaveLength(66_666);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('Zeilen der virtuellen Liste', () => {
  it('fügt nach fehlgeschlagenen Transfers mit Fehler eine Detailzeile ein', () => {
    const slots = transferRowSlots([
      transfer({ id: 1 }),
      transfer({ id: 2, state: 'failed', error: FAKE_UPLOAD_ERROR }),
      transfer({ id: 3, state: 'failed', error: null }),
    ]);
    expect(slots).toEqual([0, 2, 3, 4]);
    expect(slots.map(decodeRowSlot)).toEqual([
      { index: 0, errorLine: false },
      { index: 1, errorLine: false },
      { index: 1, errorLine: true },
      { index: 2, errorLine: false },
    ]);
  });

  it('filtert je Tab und gibt für „Alle“ die Liste selbst zurück', () => {
    const list = [transfer({ id: 1, state: 'paused' }), transfer({ id: 2, state: 'done' })];
    expect(filterTransfers(list, 'all')).toBe(list);
    expect(filterTransfers(list, 'waiting').map((t) => t.id)).toEqual([1]);
  });
});
