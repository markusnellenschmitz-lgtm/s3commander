import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectActionsViewModel, type ObjectMenuEntry } from './objectActionsViewModel.svelte';
import { BrowserViewModel } from './browserViewModel.svelte';
import { TransfersViewModel } from '../transfers/transfersViewModel.svelte';
import { DeleteViewModel } from '../deletion/deleteViewModel.svelte';
import { NameDialogViewModel } from '../naming/nameDialogViewModel.svelte';
import { ClipboardViewModel } from '../clipboard/clipboardViewModel.svelte';
import { DetailsViewModel } from '../details/detailsViewModel.svelte';
import { ShareDialogViewModel } from '../share/shareDialogViewModel.svelte';
import { createFakeBackend } from '../../infrastructure/fakeBackend';
import { createFakeFilePicker } from '../../infrastructure/filePickers';
import { BACKUPS_PREFIX } from '../../infrastructure/fixtures/buckets';
import { isMenuItem } from '../../core/menu';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let browser: BrowserViewModel;
let transfers: TransfersViewModel;
let deletion: DeleteViewModel;
let naming: NameDialogViewModel;
let clipboard: ClipboardViewModel;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let details: DetailsViewModel;
let share: ShareDialogViewModel;
let actions: ObjectActionsViewModel;

beforeEach(async () => {
  const backend = createFakeBackend({ pageDelayMs: 0 });
  browser = new BrowserViewModel({ backend, schedule: (run) => run() });
  transfers = new TransfersViewModel({ backend, picker: createFakeFilePicker() });
  deletion = new DeleteViewModel({ backend });
  naming = new NameDialogViewModel({ backend });
  clipboard = new ClipboardViewModel({ paste: (s, t, m) => transfers.copy(s, t, m) });
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  details = new DetailsViewModel({ backend, writeText });
  share = new ShareDialogViewModel({ backend, writeText });
  actions = new ObjectActionsViewModel({ browser, transfers, deletion, naming, clipboard, details, share, writeText });
  await browser.loadProfiles();
  browser.openBucket('aws-prod', 'prod-backups-eu');
  browser.openPrefix(BACKUPS_PREFIX);
  await settle();
});

/** Kurzform der Einträge: Id, mit "-" für gesperrt, "|" für Trennlinien. */
function summary(entries: ObjectMenuEntry[]): string[] {
  return entries.map((e) => (isMenuItem(e) ? `${e.id}${e.disabled ? '-' : ''}` : '|'));
}

const daily = () => browser.source.get(0)!;
const file = () => browser.source.get(5)!;

describe('Kontextmenü', () => {
  it('bietet auf freier Fläche Ordner-Aktionen und hebt die Auswahl auf', () => {
    browser.selection.only(file().key);
    actions.openForBackground(10, 20);
    expect(browser.hasSelection).toBe(false);
    expect(actions.menu.state?.x).toBe(10);
    expect(summary(actions.menu.state!.entries)).toEqual(['paste-', 'newFolder', 'upload', '|', 'refresh']);
  });

  it('wählt beim Rechtsklick nur die Zeile, wenn sie nicht gewählt war', () => {
    browser.selection.only(file().key);
    browser.selection.set(browser.source.get(6)!.key, true);
    actions.openForRow(6, 1, 1);
    expect(browser.selectedEntries).toHaveLength(2);
    actions.openForRow(0, 1, 1);
    expect(browser.selectedEntries.map((e) => e.key)).toEqual([daily().key]);
    expect(summary(actions.menu.state!.entries)).toEqual([
      'open',
      'download',
      '|',
      'copy',
      'cut',
      'paste-',
      '|',
      'rename',
      'copyPath',
      'newFolder',
      '|',
      'share-',
      'presignedUrl-',
      'properties',
      '|',
      'delete',
    ]);
    actions.openForRow(999, 1, 1);
    expect(browser.selectedEntries.map((e) => e.key)).toEqual([daily().key]);
  });

  it('sperrt Umbenennen bei Mehrfachauswahl und zeigt Kürzel und Gefahr an', () => {
    browser.selection.only(file().key);
    browser.selection.set(daily().key, true);
    clipboard.store('copy', browser.selectedObjects!);
    actions.openAt(5, 5);
    const entries = actions.menu.state!.entries.filter(isMenuItem);
    expect(summary(actions.menu.state!.entries)).not.toContain('open');
    expect(entries.find((e) => e.id === 'rename')?.disabled).toBe(true);
    expect(entries.find((e) => e.id === 'paste')?.disabled).toBe(false);
    expect(entries.find((e) => e.id === 'copyPath')?.label).toBe('Pfade kopieren');
    expect(entries.find((e) => e.id === 'download')?.kbd).toBe('Strg+D');
    expect(entries.find((e) => e.id === 'delete')?.danger).toBe(true);
  });

  it('öffnet „Teilen …“ nur für eine einzelne Datei', () => {
    actions.share();
    browser.selection.only(daily().key);
    actions.share();
    expect(share.isOpen).toBe(false);
    browser.selection.only(file().key);
    actions.openAt(1, 1);
    actions.menu.run('share');
    expect([share.isOpen, share.name]).toEqual([true, file().key.split('/').pop()]);
  });

  it('bietet „Teilen …“ unter Linux nicht an, „Presigned URL kopieren“ schon', () => {
    const linux = createFakeBackend({ pageDelayMs: 0, platform: 'linux' });
    const withoutSheet = new ObjectActionsViewModel({
      browser,
      transfers,
      deletion,
      naming,
      clipboard,
      details,
      share: new ShareDialogViewModel({ backend: linux, writeText }),
      writeText,
    });
    browser.selection.only(file().key);
    withoutSheet.openAt(1, 1);
    const ids = summary(withoutSheet.menu.state!.entries);
    expect(ids).not.toContain('share');
    expect(ids).toContain('presignedUrl');
  });

  it('öffnet ohne offenen Ordner kein Menü und schließt nach der Wahl', async () => {
    const empty = new ObjectActionsViewModel({
      browser: new BrowserViewModel({ backend: createFakeBackend() }),
      transfers,
      deletion,
      naming,
      clipboard,
      details,
      share,
      writeText,
    });
    empty.openAt(1, 1);
    expect(empty.menu.state).toBeNull();
    actions.openForBackground(1, 1);
    const refresh = vi.spyOn(browser, 'refresh');
    actions.menu.run('refresh');
    expect(actions.menu.state).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('Aktionen', () => {
  it('reicht die Auswahl an die zuständigen View-Models weiter', () => {
    browser.selection.only(file().key);
    const download = vi.spyOn(transfers, 'download').mockResolvedValue();
    const remove = vi.spyOn(deletion, 'open').mockResolvedValue();
    const rename = vi.spyOn(naming, 'openRename');
    actions.menu.run('download');
    actions.menu.run('delete');
    actions.menu.run('rename');
    const selection = browser.selectedObjects;
    expect(download).toHaveBeenCalledWith(selection);
    expect(remove).toHaveBeenCalledWith(selection);
    expect(rename).toHaveBeenCalledWith(selection);
  });

  it('kopiert, schneidet aus und fügt in den offenen Ordner ein', () => {
    const copy = vi.spyOn(transfers, 'copy').mockResolvedValue();
    browser.selection.only(file().key);
    actions.menu.run('copy');
    expect(clipboard.content?.mode).toBe('copy');
    actions.menu.run('cut');
    expect(clipboard.content?.mode).toBe('cut');
    actions.menu.run('paste');
    expect(copy).toHaveBeenCalledWith(expect.anything(), browser.uploadTarget, true);
  });

  it('öffnet Ordner, legt Ordner an, lädt hoch und kopiert Pfade', () => {
    const create = vi.spyOn(naming, 'openCreateFolder');
    const upload = vi.spyOn(transfers, 'upload').mockResolvedValue();
    const open = vi.spyOn(browser, 'open');
    browser.selection.only(file().key);
    actions.menu.run('open');
    expect(open).not.toHaveBeenCalled();
    actions.menu.run('copyPath');
    expect(writeText).toHaveBeenCalledWith(`s3://prod-backups-eu/${file().key}`);
    browser.selection.set(daily().key, true);
    actions.menu.run('copyPath');
    expect(writeText).toHaveBeenLastCalledWith(
      `s3://prod-backups-eu/${daily().key}\ns3://prod-backups-eu/${file().key}`,
    );
    actions.menu.run('newFolder');
    actions.menu.run('upload');
    expect(create).toHaveBeenCalledWith(browser.uploadTarget);
    expect(upload).toHaveBeenCalledWith(browser.uploadTarget);
    browser.selection.only(daily().key);
    const folder = daily();
    actions.menu.run('open');
    expect(open).toHaveBeenCalledWith(folder);
  });

  it('tut ohne Auswahl oder ohne offenen Ordner nichts', () => {
    const download = vi.spyOn(transfers, 'download');
    actions.download();
    actions.copyPath();
    expect(download).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    const idle = new BrowserViewModel({ backend: createFakeBackend() });
    const detached = new ObjectActionsViewModel({
      browser: idle,
      transfers,
      deletion,
      naming,
      clipboard,
      details,
      share,
      writeText,
    });
    const create = vi.spyOn(naming, 'openCreateFolder');
    detached.newFolder();
    detached.upload();
    detached.copyPath();
    expect(create).not.toHaveBeenCalled();
  });
});
