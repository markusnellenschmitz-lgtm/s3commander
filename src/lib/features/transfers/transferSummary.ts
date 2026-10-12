// Kennzahlen der Transfer-Queue (Screen 4) in einem Durchlauf, damit auch Hunderttausende
// Transfers pro Meldung nur einmal durchlaufen werden.

import type { TransferDirection, TransferSnapshot, TransferState } from '../../core/backend';
import { restSeconds } from './transferText';

export type TransferFilter = 'all' | 'active' | 'waiting' | 'done' | 'failed';

/** Zustände, die „Fertige entfernen“ aus der Liste nimmt. */
export const FINISHED_STATES: readonly TransferState[] = ['done', 'skipped', 'cancelled'];

/** Welche Zustände ein Filter-Tab zeigt. */
export const FILTER_STATES: Record<Exclude<TransferFilter, 'all'>, readonly TransferState[]> = {
  active: ['active'],
  waiting: ['waiting', 'paused'],
  done: ['done', 'skipped'],
  failed: ['failed'],
};

export interface TransferTotals {
  doneBytes: number;
  totalBytes: number;
  percent: number;
  bytesPerSec: number;
  /** Tempo je Richtung; nur Richtungen mit laufenden Transfers. */
  speeds: Partial<Record<TransferDirection, number>>;
  restSeconds: number;
}

export interface TransferSummary {
  counts: Record<TransferFilter, number>;
  byState: Record<TransferState, number>;
  totals: TransferTotals;
  /** Erster laufender Transfer für die eingeklappte Leiste. */
  current: TransferSnapshot | undefined;
  /** Platz in der Warteschlange (ab 1) je wartendem Transfer. */
  waitingPositions: Map<number, number>;
}

/** Abgebrochene und übersprungene Transfers zählen nicht zum Gesamtfortschritt (UI-SPEC §5). */
const UNCOUNTED: readonly TransferState[] = ['cancelled', 'skipped'];

export function summarizeTransfers(transfers: readonly TransferSnapshot[]): TransferSummary {
  const byState: Record<TransferState, number> = {
    waiting: 0,
    active: 0,
    paused: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
  };
  const speeds: TransferTotals['speeds'] = {};
  const waitingPositions = new Map<number, number>();
  let totalBytes = 0;
  let doneBytes = 0;
  let current: TransferSnapshot | undefined;

  for (const t of transfers) {
    byState[t.state]++;
    if (!UNCOUNTED.includes(t.state)) {
      totalBytes += t.totalBytes;
      doneBytes += t.state === 'done' ? t.totalBytes : t.doneBytes;
    }
    if (t.state === 'active') {
      current ??= t;
      speeds[t.direction] = (speeds[t.direction] ?? 0) + t.bytesPerSec;
    }
    if (t.state === 'waiting') waitingPositions.set(t.id, waitingPositions.size + 1);
  }

  const bytesPerSec = Object.values(speeds).reduce((sum, speed) => sum + speed, 0);
  const count = (states: readonly TransferState[]) => states.reduce((sum, state) => sum + byState[state], 0);
  return {
    counts: {
      all: transfers.length,
      active: count(FILTER_STATES.active),
      waiting: count(FILTER_STATES.waiting),
      done: count(FILTER_STATES.done),
      failed: count(FILTER_STATES.failed),
    },
    byState,
    totals: {
      doneBytes,
      totalBytes,
      percent: totalBytes > 0 ? Math.floor((doneBytes / totalBytes) * 100) : 0,
      bytesPerSec,
      speeds,
      restSeconds: restSeconds({ totalBytes, doneBytes, bytesPerSec }),
    },
    current,
    waitingPositions,
  };
}

/** Transfers eines Filter-Tabs; „Alle“ gibt die Liste selbst zurück. */
export function filterTransfers(
  transfers: readonly TransferSnapshot[],
  filter: TransferFilter,
): readonly TransferSnapshot[] {
  if (filter === 'all') return transfers;
  const states = FILTER_STATES[filter];
  return transfers.filter((t) => states.includes(t.state));
}

/**
 * Zeilen der virtuellen Liste: je Transfer eine Zeile, bei Fehlern eine zweite mit den Details.
 * Kodiert als Index * 2 (+ 1 für die Fehlerzeile), damit keine Zeilenobjekte entstehen.
 */
export function transferRowSlots(transfers: readonly TransferSnapshot[]): number[] {
  const slots: number[] = [];
  transfers.forEach((t, index) => {
    slots.push(index * 2);
    if (t.state === 'failed' && t.error) slots.push(index * 2 + 1);
  });
  return slots;
}

/** Transfer und Art einer kodierten Zeile. */
export function decodeRowSlot(slot: number): { index: number; errorLine: boolean } {
  return { index: Math.floor(slot / 2), errorLine: slot % 2 === 1 };
}
