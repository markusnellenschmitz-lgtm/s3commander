// Abgleich im Fake-Backend: dieselben Regeln wie src-tauri/src/domain/sync.rs. Übertragen wird,
// was im Ziel fehlt, eine andere Größe hat oder in der Quelle neuer ist.

import type { FolderLocation, SyncDirection, SyncItem, SyncPreview, SyncReason } from '../core/backend';
import type { FakeDownload, FakeUploadFile } from './fakeTransfers';

/** Zeitunterschied, der noch als gleich gilt. */
const TIME_TOLERANCE_MS = 2_000;
const PREVIEW_LIMIT = 200;
const SEPARATOR = String.fromCharCode(92);

interface Entry {
  relative: string;
  size: number;
  modifiedMs: number | null;
}

export interface FakeLocalEntry extends Entry {
  path: string;
}

export interface FakeRemoteEntry extends Entry {
  key: string;
}

export interface FakeSyncPlan {
  folder: FolderLocation;
  uploads: FakeUploadFile[];
  downloads: FakeDownload[];
}

function reasonFor(source: Entry, target: Entry | undefined): SyncReason | null {
  if (!target) return 'new';
  if (source.size !== target.size) return 'sizeDiffers';
  const [sourceMs, targetMs] = [source.modifiedMs, target.modifiedMs];
  return sourceMs !== null && targetMs !== null && sourceMs > targetMs + TIME_TOLERANCE_MS ? 'newer' : null;
}

export class FakeSync {
  readonly #plans = new Map<string, FakeSyncPlan>();
  #next = 1;

  plan(
    folder: FolderLocation,
    localDir: string,
    direction: SyncDirection,
    local: FakeLocalEntry[],
    remote: FakeRemoteEntry[],
  ): SyncPreview {
    const [source, target] = direction === 'upload' ? [local, remote] : [remote, local];
    const targets = new Map<string, Entry>(target.map((e) => [e.relative, e]));
    const chosen: { entry: Entry; reason: SyncReason }[] = [];
    let unchanged = 0;
    for (const entry of source) {
      const reason = reasonFor(entry, targets.get(entry.relative));
      if (reason) chosen.push({ entry, reason });
      else unchanged++;
    }
    const sources = new Set(source.map((e) => e.relative));
    const extras = target.filter((e) => !sources.has(e.relative));
    const planId = `sync-${this.#next++}`;
    this.#plans.set(planId, {
      folder,
      uploads: direction === 'upload' ? chosen.map(({ entry }) => this.#upload(folder, entry as FakeLocalEntry)) : [],
      downloads:
        direction === 'download' ? chosen.map(({ entry }) => this.#download(localDir, entry as FakeRemoteEntry)) : [],
    });
    const items: SyncItem[] = chosen.map(({ entry, reason }) => ({
      relative: entry.relative,
      size: entry.size,
      reason,
    }));
    return {
      planId,
      direction,
      transfers: items.length,
      bytes: items.reduce((sum, item) => sum + item.size, 0),
      unchanged,
      items: items.slice(0, PREVIEW_LIMIT),
      remoteExtras: direction === 'upload' ? (extras as FakeRemoteEntry[]).map(({ key, size }) => ({ key, size })) : [],
      localExtras: direction === 'download' ? extras.length : 0,
    };
  }

  take(planId: string): FakeSyncPlan {
    const plan = this.#plans.get(planId);
    if (!plan) throw { kind: 'syncPlanNotFound', message: `Der Abgleich ${planId} ist nicht mehr gültig` };
    this.#plans.delete(planId);
    return plan;
  }

  #upload(folder: FolderLocation, entry: FakeLocalEntry): FakeUploadFile {
    return { path: entry.path, key: folder.prefix + entry.relative, size: entry.size };
  }

  #download(localDir: string, entry: FakeRemoteEntry): FakeDownload {
    const base = localDir.endsWith(SEPARATOR) ? localDir : `${localDir}${SEPARATOR}`;
    return { key: entry.key, size: entry.size, localPath: base + entry.relative.split('/').join(SEPARATOR) };
  }
}
