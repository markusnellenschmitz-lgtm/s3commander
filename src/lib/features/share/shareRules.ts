// Regeln für vorsignierte Links: Gültigkeiten und ihr Ablauf als Text.

import { formatDateSeconds } from '../../core/format';

/** Gültigkeiten für vorsignierte Links (SigV4 erlaubt höchstens sieben Tage). */
export const SHARE_DURATIONS: readonly { label: string; secs: number }[] = [
  { label: '1 Stunde', secs: 60 * 60 },
  { label: '24 Stunden', secs: 24 * 60 * 60 },
  { label: '7 Tage', secs: 7 * 24 * 60 * 60 },
];
export const DEFAULT_SHARE_SECS = SHARE_DURATIONS[1].secs;

/** "bis 12.10.2026 15:23:08" */
export function shareUntilText(nowMs: number, secs: number): string {
  return `bis ${formatDateSeconds(nowMs + secs * 1000)}`;
}
