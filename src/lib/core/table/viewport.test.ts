import { describe, expect, it } from 'vitest';
import {
  computeViewport,
  DEFAULT_OVERSCAN,
  MAX_SCROLL_PX,
  scrollTopForRowHeightChange,
  scrollTopToReveal,
  type ViewportInput,
} from './viewport';

const base: ViewportInput = { scrollTop: 0, clientHeight: 28 + 280, headerHeight: 28, rowHeight: 28, rowCount: 1000 };

describe('computeViewport unskaliert', () => {
  it('rendert sichtbare Zeilen plus Overscan ab dem Anfang', () => {
    const vp = computeViewport(base);
    expect(vp.scaled).toBe(false);
    expect(vp.spacerPx).toBe(28_000);
    expect(vp.visibleRows).toBe(10);
    expect(vp.start).toBe(0);
    expect(vp.end).toBe(10 + DEFAULT_OVERSCAN);
    expect(vp.offsetPx).toBe(0);
  });

  it('verschiebt das Fenster beim Scrollen', () => {
    const vp = computeViewport({ ...base, scrollTop: 28 * 100 + 14 });
    expect(vp.firstExact).toBeCloseTo(100.5);
    expect(vp.start).toBe(90);
    expect(vp.end).toBe(121);
    expect(vp.offsetPx).toBe(90 * 28);
  });

  it('begrenzt Scrollposition und Fenster am Ende', () => {
    const vp = computeViewport({ ...base, scrollTop: 10_000_000 });
    expect(vp.end).toBe(1000);
    expect(vp.firstExact).toBe(990);
  });

  it('kommt mit leerer Liste und ohne Höhe zurecht', () => {
    const vp = computeViewport({ ...base, rowCount: 0, clientHeight: 0 });
    expect(vp.start).toBe(0);
    expect(vp.end).toBe(0);
    expect(vp.spacerPx).toBe(0);
  });

  it('nimmt eigenen Overscan', () => {
    expect(computeViewport({ ...base, overscan: 2 }).end).toBe(12);
  });
});

describe('computeViewport skaliert', () => {
  const big: ViewportInput = { ...base, rowCount: 1_000_000 };

  it('deckelt den Scrollbereich', () => {
    const vp = computeViewport(big);
    expect(vp.scaled).toBe(true);
    expect(vp.spacerPx).toBe(MAX_SCROLL_PX);
  });

  it('bildet das Scrollende exakt auf die letzte Zeile ab', () => {
    const top = computeViewport(big).scrollable;
    const vp = computeViewport({ ...big, scrollTop: top });
    expect(vp.end).toBe(1_000_000);
    expect(vp.firstExact).toBe(1_000_000 - 10);
    // Unterkante der letzten Zeile fällt auf die Unterkante des Platzhalters.
    expect(vp.offsetPx + (vp.end - vp.start) * 28).toBeCloseTo(vp.spacerPx);
  });

  it('bildet die Mitte proportional ab', () => {
    const half = computeViewport(big).scrollable / 2;
    const vp = computeViewport({ ...big, scrollTop: half });
    expect(vp.firstExact).toBeCloseTo((1_000_000 - 10) / 2);
  });

  it('respektiert eine eigene Obergrenze', () => {
    const vp = computeViewport({ ...base, rowCount: 100, maxScrollPx: 1000 });
    expect(vp.scaled).toBe(true);
    expect(vp.spacerPx).toBe(1000);
  });
});

describe('scrollTopToReveal', () => {
  it('liefert null für sichtbare Zeilen', () => {
    const vp = computeViewport({ ...base, scrollTop: 28 * 50 });
    expect(scrollTopToReveal(vp, 55, 28)).toBeNull();
  });

  it('scrollt nach oben bis zur Zeile', () => {
    const vp = computeViewport({ ...base, scrollTop: 28 * 50 });
    expect(scrollTopToReveal(vp, 40, 28)).toBe(40 * 28);
  });

  it('scrollt nach unten, bis die Zeile unten anliegt', () => {
    const vp = computeViewport({ ...base, scrollTop: 28 * 50 });
    expect(scrollTopToReveal(vp, 70, 28)).toBe((70 + 1 - 10) * 28);
  });

  it('rechnet im skalierten Modus proportional', () => {
    const big = { ...base, rowCount: 1_000_000 };
    const vp = computeViewport(big);
    const top = scrollTopToReveal(vp, 999_999, 28)!;
    expect(top).toBeCloseTo(vp.scrollable);
  });
});

it('hält die erste Zeile bei Dichtewechsel', () => {
  expect(scrollTopForRowHeightChange(28 * 40, 28, 24)).toBe(24 * 40);
});
