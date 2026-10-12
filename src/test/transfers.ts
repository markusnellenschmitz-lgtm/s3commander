// Test-Helfer für Transfers.

import type { TransferSnapshot } from '../lib/core/backend';

const MiB = 1024 ** 2;

/** Laufender Multipart-Upload mit überschreibbaren Feldern. */
export function transfer(overrides: Partial<TransferSnapshot> = {}): TransferSnapshot {
  return {
    id: 1,
    direction: 'upload',
    profileId: 'aws-prod',
    name: 'db-full-20261011.tar.zst',
    localPath: 'D:\\Backups\\db-full-20261011.tar.zst',
    copySource: null,
    sourceProfileId: null,
    bucket: 'prod-backups-eu',
    key: 'backups/2026/10/db-full-20261011.tar.zst',
    totalBytes: 152 * 32 * MiB,
    doneBytes: 100 * 32 * MiB,
    state: 'active',
    bytesPerSec: 32 * MiB,
    partCount: 152,
    partsDone: 100,
    error: null,
    finishedMs: null,
    ...overrides,
  };
}
