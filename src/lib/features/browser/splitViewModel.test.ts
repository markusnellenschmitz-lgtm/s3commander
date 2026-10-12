import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { BrowserViewModel } from './browserViewModel.svelte';
import { SplitViewModel } from './splitViewModel.svelte';
import { DRAG_THRESHOLD_PX, PanelDragViewModel, type PanelPoint } from './panelDragViewModel.svelte';
import { LocalPanelViewModel } from '../local/localPanelViewModel.svelte';
import { TransfersViewModel } from '../transfers/transfersViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { createFakeFilePicker } from '../../infrastructure/filePickers';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';
import type { S3Entry } from '../objects/entry';

const DB_PROD = 'D:\\Backups\\db-prod';
const CHECKSUMS = `${DB_PROD}\\checksums.sha256`;

let browser: BrowserViewModel;
let local: LocalPanelViewModel;
let transfers: TransfersViewModel;
let split: SplitViewModel;
let drag: PanelDragViewModel;
let upload: MockInstance<TransfersViewModel['uploadPaths']>;
let download: MockInstance<TransfersViewModel['downloadTo']>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  const backend = createFakeBackend({ pageDelayMs: 0 });
  browser = new BrowserViewModel({ backend, schedule: (run) => run() });
  local = new LocalPanelViewModel({ backend });
  transfers = new TransfersViewModel({ backend, picker: createFakeFilePicker() });
  split = new SplitViewModel({ browser, local, transfers });
  drag = new PanelDragViewModel({ split, browser, local });
  upload = vi.spyOn(transfers, 'uploadPaths').mockResolvedValue();
  download = vi.spyOn(transfers, 'downloadTo').mockResolvedValue();
  await browser.loadProfiles();
  browser.openBucket('aws-prod', 'prod-backups-eu');
  browser.openPrefix(BACKUPS_PREFIX);
  await settle();
  await local.open(DB_PROD);
});

const entry = (source: { length: number; get(i: number): S3Entry | undefined }, name: string) =>
  Array.from({ length: source.length }, (_, i) => source.get(i)).find((e) => e?.name === name)!;
const daily = () => entry(browser.source, 'daily/');

describe('SplitViewModel', () => {
  it('schaltet um und lädt die lokale Seite beim ersten Zeigen', () => {
    const fresh = new LocalPanelViewModel({ backend: createFakeBackend() });
    const start = vi.spyOn(fresh, 'ensureStarted');
    const other = new SplitViewModel({ browser, local: fresh, transfers });
    other.toggle();
    expect([other.active, start.mock.calls.length]).toEqual([true, 1]);
    other.toggle();
    expect(other.active).toBe(false);
  });

  it('kopiert die lokale Auswahl in den Bucket und die Bucket-Auswahl nach lokal', () => {
    expect([split.canUpload, split.canDownload]).toEqual([false, false]);
    local.selection.set(CHECKSUMS, true);
    browser.selection.set(daily().key, true);
    expect([split.canUpload, split.canDownload]).toEqual([true, true]);
    split.upload();
    expect(upload).toHaveBeenCalledWith(browser.uploadTarget, [CHECKSUMS]);
    split.copyFrom('local', `${BACKUPS_PREFIX}daily/`);
    expect(upload).toHaveBeenLastCalledWith({ ...browser.uploadTarget, prefix: `${BACKUPS_PREFIX}daily/` }, [
      CHECKSUMS,
    ]);
    split.download();
    expect(download).toHaveBeenCalledWith(browser.selectedObjects, DB_PROD);
    split.copyFrom('bucket', `${DB_PROD}\\alt`);
    expect(download).toHaveBeenLastCalledWith(browser.selectedObjects, `${DB_PROD}\\alt`);
  });

  it('tut nichts ohne Auswahl oder Ziel und reagiert auf Strg+U', async () => {
    split.upload();
    split.download();
    expect(split.handleLocalShortcut('u', false)).toBe(false);
    expect(split.handleLocalShortcut('x', true)).toBe(false);
    local.selection.set(CHECKSUMS, true);
    expect(split.handleLocalShortcut('U', true)).toBe(true);
    expect(upload).toHaveBeenCalledOnce();
    await local.open(null);
    browser.selection.set(daily().key, true);
    split.download();
    expect(download).not.toHaveBeenCalled();
  });
});

describe('PanelDragViewModel', () => {
  let point: PanelPoint;

  beforeEach(() => {
    point = { side: null, rowIndex: null };
    drag.setHitTest(() => point);
  });

  it('beginnt erst nach einigen Pixeln und wählt die gedrückte Zeile', () => {
    const file = entry(local.source, 'checksums.sha256');
    drag.press('local', file, 100, 100, false);
    expect(local.selection.has(CHECKSUMS)).toBe(true);
    drag.move(101, 101);
    expect(drag.active).toBe(false);
    drag.move(100 + DRAG_THRESHOLD_PX, 100);
    expect([drag.active, drag.from]).toEqual([true, 'local']);
    expect(drag.countText).toBe('1 Element · 412 B');
    expect(drag.targetText).toBe('Zum Kopieren auf der anderen Seite ablegen');
  });

  it('legt auf einer Ordnerzeile oder im offenen Ordner der anderen Seite ab', () => {
    drag.press('local', entry(local.source, 'checksums.sha256'), 0, 0, false);
    point = { side: 'bucket', rowIndex: browser.source.indexOfKey(daily().key) };
    drag.move(20, 20);
    expect(drag.folder?.key).toBe(daily().key);
    expect(drag.rowClass('bucket', daily())).toBe('is-drop');
    expect(drag.rowClass('local', daily())).toBe('');
    expect(drag.highlights('bucket')).toBe(false);
    expect(drag.targetText).toBe(`Kopieren nach prod-backups-eu/${daily().key}`);
    drag.release();
    expect(upload).toHaveBeenCalledWith({ ...browser.uploadTarget, prefix: daily().key }, [CHECKSUMS]);
    expect(drag.active).toBe(false);

    browser.selection.set(daily().key, true);
    drag.press('bucket', daily(), 0, 0, false);
    point = { side: 'local', rowIndex: null };
    drag.move(30, 0);
    expect(drag.highlights('local')).toBe(true);
    expect(drag.targetText).toBe(`Speichern nach ${DB_PROD}`);
    drag.release();
    expect(download).toHaveBeenCalledWith(browser.selectedObjects, DB_PROD);
  });

  it('kopiert nichts über der eigenen Seite, nach Esc oder mit Strg', () => {
    const file = entry(local.source, 'checksums.sha256');
    drag.press('local', file, 0, 0, false);
    point = { side: 'local', rowIndex: 0 };
    drag.move(30, 0);
    expect(drag.targetSide).toBeNull();
    drag.release();
    drag.press('local', file, 0, 0, false);
    point = { side: 'bucket', rowIndex: null };
    drag.move(30, 0);
    drag.cancel();
    drag.release();
    local.selection.clear();
    drag.press('local', file, 0, 0, true);
    drag.move(30, 0);
    expect([drag.active, local.selection.has(CHECKSUMS)]).toEqual([false, false]);
    expect(upload).not.toHaveBeenCalled();
  });

  it('zieht nichts, wenn nichts ausgewählt werden kann, und behält eine bestehende Auswahl', async () => {
    browser.selection.set(daily().key, true);
    const weekly = entry(browser.source, 'weekly/');
    browser.selection.set(weekly.key, true);
    drag.press('bucket', daily(), 0, 0, false);
    expect(browser.selectedCount).toBe(2);
    await local.open(null);
    drag.press('local', entry(local.source, 'D:'), 0, 0, false);
    drag.move(30, 0);
    expect(drag.active).toBe(false);
  });
});
