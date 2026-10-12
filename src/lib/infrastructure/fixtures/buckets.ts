// Testdaten nach UI-SPEC §2 als flache Objektlisten je Bucket, wie S3 sie speichert.
// Nur für das Fake-Backend (Browser-Vorschau) und Tests.

import type { ObjectEntryDto } from '../../core/backend';
import { pseudoHex } from './pseudoHex';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const KiB = 1024;

export const BACKUPS_PREFIX = 'backups/2026/10/';

const at = (month: number, day: number, hour: number, minute: number, second = 0) =>
  new Date(2026, month - 1, day, hour, minute, second).getTime();

function object(key: string, size: number, time: number, storageClass: string, etag: string): ObjectEntryDto {
  return { key, size, lastModifiedMs: time, etag: `"${etag}"`, storageClass };
}

const FULL_BACKUP_GIB = [4.58, 4.61, 4.63, 4.66, 4.64, 4.68, 4.7, 4.71, 4.69, 4.73, 4.74];
const FULL_BACKUP_MINUTE = [12, 11, 13, 12, 14, 12, 13, 15, 12, 13, 14];
/** Die ersten vier Vollsicherungen liegen bereits in STANDARD_IA. */
const INFREQUENT_ACCESS_DAYS = 4;
/** Multipart-ETag: erste Sicherung mit 147 Teilen, jede folgende einer mehr. */
const FIRST_PART_COUNT = 147;

const OTHER_FILES: [name: string, size: number, time: number, storageClass: string, seed: number][] = [
  ['checksums-202610.sha256', 1434, at(10, 11, 3, 16), 'STANDARD', 41],
  ['db-schema-20261011.sql', Math.round(412.8 * KiB), at(10, 11, 3, 2), 'STANDARD', 42],
  ['keys-20261001.tar.zst.gpg', Math.round(2.3 * MiB), at(10, 1, 2, 58), 'GLACIER_IR', 43],
  ['media-index-20261011.json.gz', Math.round(12.4 * MiB), at(10, 11, 4, 40), 'STANDARD', 44],
  ['README.txt', 1229, at(9, 2, 11, 20), 'STANDARD', 45],
  ['restore-test-20261008.log', Math.round(184.2 * KiB), at(10, 8, 5, 47), 'STANDARD', 46],
];

/** Je Unterordner ein Objekt, damit die Ordner beim Listing als Präfix erscheinen. */
const FOLDER_SAMPLES: [folder: string, name: string, size: number][] = [
  ['daily/', 'db-incr-20261011-0600.tar.zst', Math.round(312.6 * MiB)],
  ['manifests/', 'manifest-20261011.json', Math.round(8.4 * KiB)],
  ['wal/', '000000010000004A000000C3', 16 * MiB],
  ['weekly/', 'db-full-2026-w41.tar.zst', Math.round(4.7 * GiB)],
];

/** prod-backups-eu: Ordner backups/2026/10/ mit 17 Objekten und 4 Unterordnern. */
export function backupsBucket(): ObjectEntryDto[] {
  const fullBackups = FULL_BACKUP_GIB.map((gib, i) => {
    const day = i + 1;
    const etag = `${pseudoHex(i + 3, 32)}-${FIRST_PART_COUNT + i}`;
    return object(
      `${BACKUPS_PREFIX}db-full-202610${String(day).padStart(2, '0')}.tar.zst`,
      Math.round(gib * GiB),
      at(10, day, 3, FULL_BACKUP_MINUTE[i], 52),
      i < INFREQUENT_ACCESS_DAYS ? 'STANDARD_IA' : 'STANDARD',
      etag,
    );
  });
  const others = OTHER_FILES.map(([name, size, time, sc, seed]) =>
    object(BACKUPS_PREFIX + name, size, time, sc, pseudoHex(seed, 32)),
  );
  const samples = FOLDER_SAMPLES.map(([folder, name, size], i) =>
    object(BACKUPS_PREFIX + folder + name, size, at(10, 11, 6, i), 'STANDARD', pseudoHex(60 + i, 32)),
  );
  return [...fullBackups, ...others, ...samples];
}

const FIRST_LOG_TIME = new Date(2025, 10, 20).getTime();
const LOG_INTERVAL_MS = 28_000;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** CloudFront-Logname; steigt mit dem Index, damit die Liste sortiert entsteht. */
export function logName(i: number): string {
  const d = new Date(FIRST_LOG_TIME + i * LOG_INTERVAL_MS);
  const hour = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}`;
  const id = (i * 4099 + 0x1a2b3c).toString(16).padStart(8, '0');
  return `E2X4K9Q1ZP7M3A.${hour}.${id}.gz`;
}

/** prod-logs-eu: Ordner cloudfront/ mit vielen kleinen Logdateien. */
export function logsBucket(count: number): ObjectEntryDto[] {
  return Array.from({ length: count }, (_, i) => {
    const r = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
    return {
      key: `cloudfront/${logName(i)}`,
      size: Math.round((18 + r * 64) * KiB),
      lastModifiedMs: FIRST_LOG_TIME + i * LOG_INTERVAL_MS,
      etag: `"${pseudoHex(i, 32)}"`,
      storageClass: 'STANDARD',
    };
  });
}
