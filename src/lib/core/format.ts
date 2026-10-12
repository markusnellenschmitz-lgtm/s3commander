// Formatierung nach UI-SPEC §5: deutsche Zahlen, Binäreinheiten, absolute Zeiten.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

const numberFormats = new Map<number, Intl.NumberFormat>();
function nf(decimals: number): Intl.NumberFormat {
  let f = numberFormats.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    numberFormats.set(decimals, f);
  }
  return f;
}

/** 1,4 KiB · 412,8 KiB · 4,74 GiB · 12,4 GiB. GiB und größer unter 10 mit 2 Nachkommastellen. */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || bytes < 0 || !Number.isFinite(bytes)) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const decimals = unit === 0 ? 0 : unit >= 3 && value < 10 ? 2 : 1;
  return `${nf(decimals).format(value)} ${UNITS[unit]}`;
}

/** Exakte Bytes für Eigenschaften und Tooltips: 5.089.471.232 Bytes */
export function formatBytesExact(bytes: number): string {
  return `${nf(0).format(bytes)} Bytes`;
}

/** 12.483.920 */
export function formatCount(n: number): string {
  return nf(0).format(n);
}

/** „1 Objekt“, „12.483 Objekte“ */
export function countText(n: number, singular: string, plural: string): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`;
}

/** 48,2 MiB/s */
export function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : '—';
}

/** Restzeit: unter 60 s in Sekunden, sonst Minuten. */
export function formatRest(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  return `${Math.round(seconds / 60)} Min.`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Liste: 11.10.2026 03:14 */
export function formatDate(value: Date | string | number | undefined): string {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Eigenschaften-Raster: 11.10.2026 03:14:52 */
export function formatDateSeconds(value: Date | string | number | undefined): string {
  const base = formatDate(value);
  if (!base) return '';
  const d = value instanceof Date ? value : new Date(value as string | number);
  return `${base}:${pad(d.getSeconds())}`;
}

/** Uhrzeit für "Fertig · 15:09" */
export function formatTime(value: Date | number): string {
  const d = value instanceof Date ? value : new Date(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
