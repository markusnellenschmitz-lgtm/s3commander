import { describe, expect, it } from 'vitest';
import {
  countText,
  formatBytes,
  formatBytesExact,
  formatCount,
  formatDate,
  formatDateSeconds,
  formatRest,
  formatSpeed,
  formatTime,
} from './format';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1229, '1,2 KiB'],
    [1434, '1,4 KiB'],
    [Math.round(412.8 * 1024), '412,8 KiB'],
    [Math.round(12.4 * 1024 ** 2), '12,4 MiB'],
    [Math.round(4.74 * 1024 ** 3), '4,74 GiB'],
    [Math.round(14.16 * 1024 ** 3), '14,2 GiB'],
    [Math.round(2.5 * 1024 ** 4), '2,50 TiB'],
  ])('%d Bytes → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it.each([undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY])('ungültig (%s) → leer', (value) => {
    expect(formatBytes(value)).toBe('');
  });

  it('bleibt bei der größten Einheit', () => {
    expect(formatBytes(1024 ** 6)).toBe('1.024,0 PiB');
  });
});

describe('Zahlen', () => {
  it('formatiert exakte Bytes mit Tausenderpunkt', () => {
    expect(formatBytesExact(5089471232)).toBe('5.089.471.232 Bytes');
  });

  it('formatiert Anzahlen deutsch', () => {
    expect(formatCount(12483920)).toBe('12.483.920');
    expect(countText(1, 'Objekt', 'Objekte')).toBe('1 Objekt');
    expect(countText(12483, 'Objekt', 'Objekte')).toBe('12.483 Objekte');
    expect(countText(0, 'Objekt', 'Objekte')).toBe('0 Objekte');
  });

  it('formatiert Tempo und zeigt Strich ohne Tempo', () => {
    expect(formatSpeed(48.2 * 1024 ** 2)).toBe('48,2 MiB/s');
    expect(formatSpeed(0)).toBe('—');
  });
});

describe('formatRest', () => {
  it.each([
    [49.2, '50 s'],
    [59, '59 s'],
    [240, '4 Min.'],
    [0, '—'],
    [-3, '—'],
    [Number.POSITIVE_INFINITY, '—'],
  ])('%d s → %s', (seconds, expected) => {
    expect(formatRest(seconds)).toBe(expected);
  });
});

describe('Datum', () => {
  const sample = new Date(2026, 9, 11, 3, 14, 52);

  it('zeigt Listen-Datum ohne Sekunden', () => {
    expect(formatDate(sample)).toBe('11.10.2026 03:14');
    expect(formatDate(sample.getTime())).toBe('11.10.2026 03:14');
  });

  it('zeigt Sekunden im Eigenschaften-Raster', () => {
    expect(formatDateSeconds(sample)).toBe('11.10.2026 03:14:52');
  });

  it.each([undefined, '', 'kein Datum'])('ungültig (%s) → leer', (value) => {
    expect(formatDate(value)).toBe('');
    expect(formatDateSeconds(value)).toBe('');
  });
});

it('formatiert Uhrzeiten zweistellig', () => {
  expect(formatTime(new Date(2026, 9, 11, 7, 5))).toBe('07:05');
  expect(formatTime(new Date(2026, 9, 11, 15, 9).getTime())).toBe('15:09');
});
