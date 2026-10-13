// Komponenten-Tests der Feature-Ansichten und der Kompositionswurzel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import ObjectTable from './objects/ObjectTable.svelte';
import MainWindow from './browser/MainWindow.svelte';
import ConnectionDialog from './connections/ConnectionDialog.svelte';
import App from '../../App.svelte';
import { ArraySource } from './objects/arraySource.svelte';
import { BrowserViewModel, bucketNodeId, DEFAULT_SORT } from './browser/browserViewModel.svelte';
import { ConnectionDialogViewModel } from './connections/connectionDialogViewModel.svelte';
import { TransfersViewModel } from './transfers/transfersViewModel.svelte';
import { FileDropViewModel } from './browser/fileDropViewModel.svelte';
import { controlledDrops } from '../../test/drops';
import DeleteDialog from './deletion/DeleteDialog.svelte';
import NameDialog from './naming/NameDialog.svelte';
import { NameDialogViewModel } from './naming/nameDialogViewModel.svelte';
import { ClipboardViewModel } from './clipboard/clipboardViewModel.svelte';
import { ObjectActionsViewModel } from './browser/objectActionsViewModel.svelte';
import { ConnectionActionsViewModel } from './connections/connectionActionsViewModel.svelte';
import { DetailsViewModel } from './details/detailsViewModel.svelte';
import { ObjectFilterViewModel } from './objects/objectFilterViewModel.svelte';
import { SettingsViewModel } from './settings/settingsViewModel.svelte';
import SettingsDialog from './settings/SettingsDialog.svelte';
import { ThemeViewModel, type KeyValueStore } from './settings/themeViewModel.svelte';
import { ViewPreferences } from './settings/viewPreferences.svelte';
import { TabsViewModel } from './browser/tabsViewModel.svelte';
import { LocalPanelViewModel } from './local/localPanelViewModel.svelte';
import { SplitViewModel } from './browser/splitViewModel.svelte';
import { PanelDragViewModel } from './browser/panelDragViewModel.svelte';
import { SyncViewModel } from './sync/syncViewModel.svelte';
import SyncDialog from './sync/SyncDialog.svelte';
import ShareDialog from './share/ShareDialog.svelte';
import { ShareDialogViewModel } from './share/shareDialogViewModel.svelte';

/** Schlüssel-Wert-Speicher im Speicher, für Tests ohne localStorage. */
function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => values.set(key, value) };
}
import DeleteConnectionDialog from './connections/DeleteConnectionDialog.svelte';
import { DeleteViewModel } from './deletion/deleteViewModel.svelte';
import type { DeleteOutcome } from '../core/backend';
import TransferPanel from './transfers/TransferPanel.svelte';
import { createFakeFilePicker } from '../infrastructure/filePickers';
import { transfer } from '../../test/transfers';
import { Selection } from '../core/table/selection.svelte';
import { createFakeBackend, FAKE_PROFILES } from '../infrastructure/fakeBackend';
import type { Platform } from '../core/platform';
import { BACKUPS_PREFIX } from '../infrastructure/fixtures/buckets';
import { file, folder, mockClientHeight } from '../../test/fakes';

let restoreHeight: () => void;
beforeEach(() => (restoreHeight = mockClientHeight(800)));
afterEach(() => restoreHeight());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ObjectTable', () => {
  const props = (source: ArraySource) => ({
    source,
    selection: new Selection(),
    sort: DEFAULT_SORT,
    label: 'Objekte',
    onsort: () => {},
  });

  it('zeigt Spalten, Icons nach Dateityp und formatierte Werte', () => {
    const lastModified = new Date(2026, 9, 11, 3, 14).getTime();
    const source = new ArraySource(
      [folder('daily'), file('db.tar.zst', { size: 5089471232, lastModified })],
      DEFAULT_SORT,
    );
    render(ObjectTable, props(source));
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('daily/')).toBeInTheDocument();
    expect(rows[1].querySelector('use[href="#i-folder"]')).toBeInTheDocument();
    expect(rows[2].querySelector('use[href="#i-file-archive"]')).toBeInTheDocument();
    expect(within(rows[2]).getByText('4,74 GiB')).toBeInTheDocument();
    expect(within(rows[2]).getByText('11.10.2026 03:14')).toBeInTheDocument();
  });

  it('blendet ausgewählte Spalten aus', () => {
    const source = new ArraySource([file('a.bin')], DEFAULT_SORT);
    render(ObjectTable, { ...props(source), hiddenColumns: ['size', 'etag'] });
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers).not.toContain('Größe');
    expect(headers).toContain('Geändert');
  });

  it('meldet geöffnete Einträge und kommt ohne Handler aus', async () => {
    const source = new ArraySource([folder('daily')], DEFAULT_SORT);
    const opened: string[] = [];
    render(ObjectTable, { ...props(source), onopen: (e) => opened.push(e.name) });
    await fireEvent.dblClick(screen.getAllByRole('row')[1]);
    expect(opened).toEqual(['daily/']);
    render(ObjectTable, { ...props(source), label: 'Ohne' });
    const row = within(screen.getByRole('grid', { name: 'Ohne' })).getAllByRole('row')[1];
    await expect(fireEvent.dblClick(row)).resolves.toBe(true);
  });
});

/** Feste Uhrzeit für Texte wie „bis …“ im Freigabe-Abschnitt. */
const NOW = new Date(2026, 9, 11, 15, 23, 8).getTime();

function mainWindow(platform: Platform = 'windows') {
  const backend = createFakeBackend({ pageDelayMs: 0, logObjects: 100, platform });
  const vm = new BrowserViewModel({ backend, schedule: (run) => run() });
  const transfers = new TransfersViewModel({ backend, picker: createFakeFilePicker(['C:\\neu.zip']) });
  const drops = controlledDrops();
  const upload = vi.fn().mockResolvedValue(undefined);
  const drop = new FileDropViewModel({ drops, browser: vm, upload });
  void drop.start();
  const onnewconnection = vi.fn();
  const oneditconnection = vi.fn();
  const deletion = new DeleteViewModel({ backend });
  const naming = new NameDialogViewModel({ backend });
  const clipboard = new ClipboardViewModel({ paste: (s, t, m) => transfers.copy(s, t, m) });
  const writeText = vi.fn().mockResolvedValue(undefined);
  const details = new DetailsViewModel({ backend, writeText, now: () => NOW });
  const share = new ShareDialogViewModel({ backend, writeText, now: () => NOW });
  const filter = new ObjectFilterViewModel({ target: vm, now: () => NOW });
  const settings = new SettingsViewModel({
    backend,
    theme: new ThemeViewModel(memoryStore(), { prefersDark: () => true, subscribe: () => () => {} }),
    view: new ViewPreferences(memoryStore()),
  });
  const actions = new ObjectActionsViewModel({
    browser: vm,
    transfers,
    deletion,
    naming,
    clipboard,
    details,
    share,
    writeText,
  });
  const tabs = new TabsViewModel(vm);
  const local = new LocalPanelViewModel({ backend });
  const split = new SplitViewModel({ browser: vm, local, transfers });
  const panelDrag = new PanelDragViewModel({ split, browser: vm, local });
  const sync = new SyncViewModel({ backend, deleteExtras: (selection) => void deletion.open(selection) });
  const connectionActions = new ConnectionActionsViewModel({
    browser: vm,
    edit: oneditconnection,
    writeText,
    openInNewTab: (profileId, bucket) => tabs.openInNewTab(profileId, bucket),
  });
  render(MainWindow, {
    vm,
    transfers,
    drop,
    deletion,
    naming,
    clipboard,
    actions,
    connectionActions,
    details,
    filter,
    settings,
    tabs,
    local,
    split,
    panelDrag,
    sync,
    onnewconnection,
    oneditconnection,
  });
  render(SyncDialog, { vm: sync });
  render(ShareDialog, { vm: share });
  return {
    share,
    sync,
    tabs,
    local,
    split,
    panelDrag,
    vm,
    backend,
    transfers,
    drops,
    upload,
    deletion,
    naming,
    clipboard,
    actions,
    connectionActions,
    details,
    filter,
    settings,
    writeText,
    onnewconnection,
    oneditconnection,
  };
}

describe('Drag and Drop aus dem Explorer', () => {
  const original = document.elementFromPoint;
  afterEach(() => {
    document.elementFromPoint = original;
  });

  it('hebt die Ordnerzeile hervor, zeigt die Vorschau und lädt beim Ablegen hoch', async () => {
    const { vm, drops, upload } = mainWindow();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
    const dailyRow = screen.getByText('daily/').closest<HTMLElement>('[data-row-index]')!;
    document.elementFromPoint = vi.fn(() => dailyRow);

    drops.emit({ type: 'enter', paths: ['C:\\Fotos', 'C:\\a.bin'], x: 100, y: 120 });
    await settle();
    expect(dailyRow).toHaveClass('is-drop');
    expect(screen.getByText('2 Elemente')).toBeInTheDocument();
    expect(screen.getByText(`Hochladen nach prod-backups-eu/${BACKUPS_PREFIX}daily/`)).toBeInTheDocument();

    const grid = screen.getByRole('grid', { name: /Objekte/ });
    document.elementFromPoint = vi.fn(() => grid);
    drops.emit({ type: 'over', paths: [], x: 300, y: 400 });
    await settle();
    expect(grid.querySelector('.s3-drop-frame')).not.toBeNull();
    expect(dailyRow).not.toHaveClass('is-drop');

    drops.emit({ type: 'drop', paths: ['C:\\Fotos', 'C:\\a.bin'], x: 300, y: 400 });
    await settle();
    expect(upload).toHaveBeenCalledWith({ profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX }, [
      'C:\\Fotos',
      'C:\\a.bin',
    ]);
    expect(screen.queryByText('2 Elemente')).not.toBeInTheDocument();
    expect(grid.querySelector('.s3-drop-frame')).toBeNull();
  });

  it('meldet außerhalb der Liste, dass dort nicht abgelegt werden kann', async () => {
    const { vm, drops } = mainWindow();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    await settle();
    document.elementFromPoint = vi.fn(() => document.body);
    drops.emit({ type: 'enter', paths: ['C:\\a'], x: 5, y: 5 });
    await settle();
    expect(screen.getByText('Zum Hochladen über der Liste ablegen')).toBeInTheDocument();
  });
});

describe('MainWindow', () => {
  it('zeigt ohne Profile den Leerzustand mit Neuer Verbindung', async () => {
    const { onnewconnection } = mainWindow();
    expect(screen.getByText('Bucket wählen')).toBeInTheDocument();
    expect(screen.getByText('Noch keine Verbindung angelegt.')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /Neue Verbindung/ });
    await fireEvent.click(buttons[1]);
    expect(onnewconnection).toHaveBeenCalledOnce();
  });

  it('zeigt Verbindungen im Baum und öffnet Buckets und Ordner', async () => {
    const { vm } = mainWindow();
    await vm.loadProfiles();
    await settle();
    const tree = screen.getByRole('tree');
    expect(within(tree).getByText('AWS Produktion')).toBeInTheDocument();
    expect(within(tree).getByRole('img', { name: 'Fehler' })).toBeInTheDocument();
    await fireEvent.click(within(tree).getByText('prod-backups-eu'));
    await settle();
    expect(screen.getByRole('navigation', { name: 'Pfad' })).toHaveTextContent('prod-backups-eu');

    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
    expect(screen.getByText('17 Objekte · 4 Ordner')).toBeInTheDocument();
    expect(screen.getByText('Sortiert nach Name, aufsteigend')).toBeInTheDocument();
    expect(screen.getByText('SigV4 · Virtual-Hosted')).toBeInTheDocument();

    await fireEvent.dblClick(screen.getByText('daily/'));
    await settle();
    expect(vm.location?.prefix).toBe(`${BACKUPS_PREFIX}daily/`);
  });

  it('bedient Werkzeugleiste, Breadcrumb und Tastenkürzel', async () => {
    const { vm } = mainWindow();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: /Eine Ebene hoch/ }));
    expect(vm.location?.prefix).toBe('backups/2026/');
    await fireEvent.click(screen.getByRole('button', { name: /Zurück/ }));
    expect(vm.location?.prefix).toBe(BACKUPS_PREFIX);
    await fireEvent.click(screen.getByRole('button', { name: /Weiter/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'backups' }));
    expect(vm.location?.prefix).toBe('backups/');
    await fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Pfad' })).getByRole('button', { name: /prod-backups-eu/ }),
    );
    expect(vm.location?.prefix).toBe('');
    const refresh = vi.spyOn(vm, 'refresh');
    await fireEvent.click(screen.getByRole('button', { name: /Aktualisieren/ }));
    await fireEvent.keyDown(window, { key: 'F5' });
    expect(refresh).toHaveBeenCalledTimes(2);
    await fireEvent.click(screen.getByRole('button', { name: 'Kompakt, 24 px' }));
    expect(vm.compact).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Standard, 28 px' }));
    expect(vm.compact).toBe(false);
    await settle();
  });

  it('ignoriert Tastenkürzel in Eingabefeldern', async () => {
    const { vm } = mainWindow();
    const input = document.createElement('input');
    document.body.append(input);
    const shortcut = vi.spyOn(vm, 'handleShortcut');
    await fireEvent.keyDown(input, { key: 'F5' });
    expect(shortcut).not.toHaveBeenCalled();
  });

  it('kopiert den Pfad in die Zwischenablage', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { vm } = mainWindow();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'Pfad kopieren' }));
    expect(writeText).toHaveBeenCalledWith('s3://prod-backups-eu/');
  });

  it('zeigt Fehlerleiste mit Request-ID und Profil-Bearbeitung', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { vm, oneditconnection } = mainWindow();
    await vm.loadProfiles();
    vm.openBucket('b2-archiv', 'archiv');
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('SignatureDoesNotMatch · HTTP 403 · Request-ID 7XQ2M9K4PZ1R8T3B');
    await fireEvent.click(within(alert).getByRole('button', { name: 'Request-ID kopieren' }));
    expect(writeText).toHaveBeenCalledWith('7XQ2M9K4PZ1R8T3B');
    await fireEvent.click(within(alert).getByRole('button', { name: 'Profil bearbeiten' }));
    expect(oneditconnection).toHaveBeenCalledWith(expect.objectContaining({ id: 'b2-archiv' }));
    const retry = vi.spyOn(vm, 'retry');
    await fireEvent.click(within(alert).getByRole('button', { name: 'Erneut versuchen' }));
    expect(retry).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Verbindung bearbeiten' }));
    expect(oneditconnection).toHaveBeenCalledTimes(2);
    await settle();
  });

  it('zeigt leere Buckets, laufende Listings und den Abbruch', async () => {
    const { vm } = mainWindow();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-exports-eu');
    await settle();
    expect(screen.getByText('Dieser Bucket ist leer')).toBeInTheDocument();
    vm.listingState = 'loading';
    await settle();
    expect(screen.getByRole('progressbar', { name: 'Listing läuft' })).toBeInTheDocument();
    const cancel = vi.spyOn(vm, 'cancelListing');
    await fireEvent.click(screen.getByRole('button', { name: 'Listing abbrechen' }));
    expect(cancel).toHaveBeenCalled();
    vm.listingState = 'cancelled';
    await settle();
    expect(screen.getByText(/Listing abgebrochen/)).toBeInTheDocument();
  });

  it('zeigt Fehler beim Laden der Profile in der Seitenleiste', async () => {
    const { vm } = mainWindow();
    vm.profilesError = { kind: 'repository', message: 'Profildatei ist beschädigt' };
    await settle();
    expect(screen.getByText('Profildatei ist beschädigt')).toBeInTheDocument();
  });

  it('bedient den Baum per Tastatur', async () => {
    const { vm } = mainWindow();
    await vm.loadProfiles();
    await settle();
    const tree = screen.getByRole('tree');
    await fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(tree).toHaveAttribute('aria-activedescendant', 'tree-c_aws-prod');
    await fireEvent.keyDown(tree, { key: 'x' });
    await fireEvent.click(within(tree).getByText('AWS Produktion'));
    await settle();
    expect(vm.connections[0].expanded).toBe(false);
  });
});

function dialogSetup() {
  const backend = createFakeBackend({ pageDelayMs: 0 });
  const onSaved = vi.fn();
  const onDeleteRequest = vi.fn();
  const vm = new ConnectionDialogViewModel({ backend, newId: () => 'neu-1', onSaved, onDeleteRequest });
  render(ConnectionDialog, { vm });
  return { vm, onSaved, onDeleteRequest };
}

describe('ConnectionDialog', () => {
  it('ist geschlossen, bis er geöffnet wird', () => {
    dialogSetup();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('bietet nur beim Bearbeiten das Löschen an', async () => {
    const { vm, onDeleteRequest } = dialogSetup();
    await vm.loadPresets();
    vm.openCreate();
    await settle();
    expect(screen.queryByRole('button', { name: /Löschen/ })).not.toBeInTheDocument();
    vm.requestDelete();
    expect(onDeleteRequest).not.toHaveBeenCalled();
    vm.close();
    vm.openEdit(FAKE_PROFILES[0]);
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: /Löschen/ }));
    expect(onDeleteRequest).toHaveBeenCalledWith(FAKE_PROFILES[0].id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('legt eine Hetzner-Verbindung an, testet und speichert sie', async () => {
    const { vm, onSaved } = dialogSetup();
    await vm.loadPresets();
    vm.openCreate();
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Neue Verbindung' });
    await fireEvent.click(within(dialog).getByRole('button', { name: /Hetzner/ }));
    expect(screen.getByLabelText('Endpoint-URL')).toHaveValue('https://fsn1.your-objectstorage.com');
    await fireEvent.input(screen.getByLabelText('Region (optional)'), { target: { value: 'nbg1' } });
    expect(screen.getByLabelText('Endpoint-URL')).toHaveValue('https://nbg1.your-objectstorage.com');

    await fireEvent.input(screen.getByLabelText('Profilname'), { target: { value: 'Hetzner Test' } });
    await fireEvent.input(screen.getByLabelText('Access Key'), { target: { value: 'AKID' } });
    await fireEvent.input(screen.getByLabelText('Secret Key'), { target: { value: 'geheim' } });
    expect(screen.getByLabelText('Secret Key')).toHaveAttribute('type', 'password');
    await fireEvent.click(screen.getByRole('button', { name: 'Secret Key anzeigen' }));
    expect(screen.getByLabelText('Secret Key')).toHaveAttribute('type', 'text');
    await fireEvent.click(screen.getByRole('button', { name: 'Secret Key verbergen' }));

    await fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByText('Verbunden')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('5 Buckets · 142 ms');

    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('zeigt Feldfehler, Testfehler und den einzelnen Bucket', async () => {
    const { vm } = dialogSetup();
    await vm.loadPresets();
    vm.openCreate('minio');
    await settle();
    expect(screen.queryByText('Profilname ist Pflicht')).not.toBeInTheDocument();
    await fireEvent.blur(screen.getByLabelText('Profilname'));
    expect(screen.getByText('Profilname ist Pflicht')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(screen.getByText('Access Key ist Pflicht')).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText('Endpoint-URL'), { target: { value: 'http://localhost:9000' } });
    await fireEvent.input(screen.getByLabelText('Region (optional)'), { target: { value: 'us-east-1' } });
    Object.assign(vm.form, { name: 'MinIO', accessKeyId: 'a', secretAccessKey: 'falsch', bucket: 'media' });
    await fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByText(/SignatureDoesNotMatch/)).toBeInTheDocument());
    vm.form.secretAccessKey = 'richtig';
    await fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Bucket erreichbar'));
  });

  it('zeigt Erweitert mit geänderten Werten und die Konto-ID bei R2', async () => {
    const { vm } = dialogSetup();
    await vm.loadPresets();
    vm.openCreate('cloudflare-r2');
    await settle();
    await fireEvent.input(screen.getByLabelText('Konto-ID'), { target: { value: 'abc' } });
    expect(screen.getByLabelText('Endpoint-URL')).toHaveValue('https://abc.r2.cloudflarestorage.com');
    await fireEvent.click(screen.getByRole('button', { name: /Erweitert/ }));
    await fireEvent.click(screen.getByLabelText('Virtual-Hosted'));
    await fireEvent.click(screen.getByLabelText('TLS-Zertifikat prüfen'));
    expect(screen.getByRole('button', { name: /Erweitert/ })).toHaveTextContent('2 Werte geändert');
    await fireEvent.input(screen.getByLabelText('Timeout'), { target: { value: '0' } });
    await fireEvent.blur(screen.getByLabelText('Timeout'));
    expect(screen.getByText('1 bis 600 Sekunden')).toBeInTheDocument();
    vm.form.timeoutSecs = 60;
    vm.form.verifyTls = true;
    await settle();
    expect(screen.getByRole('button', { name: /Erweitert/ })).toHaveTextContent('1 Wert geändert');
    await fireEvent.click(screen.getByRole('button', { name: /Erweitert/ }));
    expect(screen.queryByLabelText('Timeout')).not.toBeInTheDocument();
  });

  it('bearbeitet ein Profil, wechselt die Vorlage und schließt per Esc und Knopf', async () => {
    const { vm } = dialogSetup();
    await vm.loadPresets();
    vm.openEdit(FAKE_PROFILES[0]);
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Verbindung bearbeiten' });
    await fireEvent.click(within(dialog).getByRole('button', { name: /Hetzner/ }));
    expect(screen.getByLabelText('Endpoint-URL')).toHaveValue('https://fsn1.your-objectstorage.com');
    expect(screen.getByLabelText('Region (optional)')).toHaveValue('fsn1');
    expect(screen.getByLabelText('Access Key')).toHaveAttribute('placeholder', 'unverändert');
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(vm.isOpen).toBe(false);
    vm.openEdit(FAKE_PROFILES[0]);
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'Dialog schließen' }));
    expect(vm.isOpen).toBe(false);
    vm.openEdit(FAKE_PROFILES[0]);
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(vm.isOpen).toBe(false);
  });

  it('speichert per Enter im Formular und zeigt den Ladezustand des Tests', async () => {
    const { vm, onSaved } = dialogSetup();
    await vm.loadPresets();
    vm.openCreate('hetzner');
    Object.assign(vm.form, { name: 'H', accessKeyId: 'a', secretAccessKey: 'b' });
    vm.testState = 'testing';
    await settle();
    expect(screen.getByText('Verbinde …')).toBeInTheDocument();
    await fireEvent.submit(screen.getByLabelText('Profilname').closest('form')!);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('Hochladen im Hauptfenster', () => {
  it('lädt per Knopf und Strg+U in den offenen Ordner und zeigt die Kurzinfo', async () => {
    const { vm, transfers } = mainWindow();
    const upload = vi.spyOn(transfers, 'upload');
    expect(screen.getByRole('button', { name: /Hochladen/ })).toBeDisabled();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-exports-eu');
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: /Hochladen/ }));
    await fireEvent.keyDown(window, { key: 'u', ctrlKey: true });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenLastCalledWith({ profileId: 'aws-prod', bucket: 'prod-exports-eu', prefix: '' });

    transfers.transfers = [transfer({ state: 'active' }), transfer({ id: 2, state: 'failed' })];
    await settle();
    const item = screen.getByRole('button', { name: /Transfer-Panel umschalten/ });
    expect(item).toHaveTextContent('1 aktiv · 1 Fehler');
    await fireEvent.click(item);
    expect(transfers.expanded).toBe(true);
    await fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(transfers.expanded).toBe(false);
    transfers.transfers = [transfer({ state: 'done' })];
    await settle();
    expect(screen.getByRole('button', { name: /Transfer-Panel umschalten/ })).toHaveTextContent('Transfers fertig');
  });
});

describe('Herunterladen im Hauptfenster', () => {
  it('lädt die Auswahl per Knopf und Strg+D herunter', async () => {
    const { vm, transfers } = mainWindow();
    const download = vi.spyOn(transfers, 'download').mockResolvedValue();
    const button = screen.getByRole('button', { name: /Herunterladen/ });
    expect(button).toBeDisabled();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
    await fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(download).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByText('daily/'));
    expect(button).toBeEnabled();
    await fireEvent.click(button);
    await fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(download).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenLastCalledWith({
      folder: { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX },
      items: [{ key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null, lastModifiedMs: null }],
    });
  });

  it('übergeht den Knopf, wenn die Auswahl nicht mehr geladen ist', async () => {
    const { vm, transfers } = mainWindow();
    const download = vi.spyOn(transfers, 'download');
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    await settle();
    vm.selection.set('weg', true);
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: /Herunterladen/ }));
    expect(download).not.toHaveBeenCalled();
  });
});

describe('Löschen im Hauptfenster', () => {
  it('öffnet den Dialog per Knopf und Entf, nennt Ziel und Menge und löscht', async () => {
    const { vm, backend, deletion } = mainWindow();
    render(DeleteDialog, { vm: deletion });
    const button = screen.getByRole('button', { name: /Löschen/ });
    expect(button).toBeDisabled();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(deletion.isOpen).toBe(false);

    await fireEvent.click(screen.getByText('daily/'));
    await fireEvent.keyDown(window, { key: 'Delete' });
    const dialog = await screen.findByRole('alertdialog', { name: '„daily/“ löschen?' });
    await settle();
    expect(dialog).toHaveTextContent(`1 Objekt (312,6 MiB) in prod-backups-eu/${BACKUPS_PREFIX} wird gelöscht.`);
    expect(dialog).toHaveTextContent('Ältere Versionen bleiben erhalten');
    expect(within(dialog).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
    await fireEvent.keyDown(window, { key: 'u', ctrlKey: true });

    const remove = vi.spyOn(backend, 'deleteObjects');
    await fireEvent.click(within(dialog).getByRole('button', { name: /Löschen/ }));
    await settle();
    expect(remove).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('zeigt Fortschritt, abgelehnte Objekte und Fehler im Dialog', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const deletion = new DeleteViewModel({ backend });
    render(DeleteDialog, { vm: deletion });
    const selection = {
      folder: { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX },
      items: [
        { key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null, lastModifiedMs: null },
        { key: `${BACKUPS_PREFIX}weekly/`, isFolder: true, size: 0, etag: null, lastModifiedMs: null },
      ],
    };
    let finish: (outcome: DeleteOutcome) => void = () => {};
    vi.spyOn(backend, 'deleteObjects').mockImplementation((_, onProgress) => {
      onProgress({ processed: 1, total: 4 });
      return new Promise((resolve) => (finish = resolve));
    });
    await deletion.open(selection);
    const dialog = screen.getByRole('alertdialog', { name: '2 Einträge löschen?' });
    await fireEvent.click(within(dialog).getByRole('button', { name: /Löschen/ }));
    expect(within(dialog).getByRole('progressbar', { name: 'Löschfortschritt' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(dialog).toHaveTextContent('1 von 4 gelöscht');
    expect(within(dialog).queryByRole('button', { name: /Löschen/ })).not.toBeInTheDocument();
    finish({
      deleted: 3,
      failedCount: 1,
      failures: [{ key: 'gesperrt.bin', code: 'AccessDenied', message: '' }],
      cancelled: false,
    });
    await settle();
    expect(dialog).toHaveTextContent('3 Objekte gelöscht, 1 nicht gelöscht.');
    expect(within(dialog).getByRole('list', { name: 'Nicht gelöschte Objekte' })).toHaveTextContent(
      'gesperrt.bin · AccessDenied',
    );
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    vi.spyOn(backend, 'prepareDelete').mockReturnValueOnce(new Promise(() => {}));
    void deletion.open(selection);
    await settle();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Ermittle die betroffenen Objekte …');
    deletion.cancel();

    const service = { code: 'AccessDenied', message: 'nein', httpStatus: 403, requestId: 'R9' };
    vi.spyOn(backend, 'prepareDelete').mockRejectedValueOnce({
      kind: 'service',
      message: 'Zugriff verweigert',
      service,
    });
    await deletion.open(selection);
    const failed = screen.getByRole('alertdialog');
    expect(failed).toHaveTextContent('Zugriff verweigert');
    expect(failed).toHaveTextContent('AccessDenied · HTTP 403 · Request-ID R9');
    await fireEvent.keyDown(failed, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('übergeht den Knopf, wenn die Auswahl nicht mehr geladen ist', async () => {
    const { vm, deletion } = mainWindow();
    const open = vi.spyOn(deletion, 'open');
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    await settle();
    vm.selection.set('weg', true);
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: /Löschen/ }));
    expect(open).not.toHaveBeenCalled();
  });
});

describe('Neuer Ordner und Umbenennen', () => {
  async function openBackups(vm: BrowserViewModel) {
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
  }

  it('legt per Knopf einen Ordner an und zeigt Fehler am Feld', async () => {
    const { vm, naming } = mainWindow();
    render(NameDialog, { vm: naming });
    expect(screen.getByRole('button', { name: /Neuer Ordner/ })).toBeDisabled();
    await openBackups(vm);
    await fireEvent.click(screen.getByRole('button', { name: /Neuer Ordner/ }));
    const dialog = screen.getByRole('dialog', { name: 'Neuer Ordner' });
    const input = within(dialog).getByRole('textbox', { name: /Name/ });
    expect(input).toHaveFocus();
    expect(dialog).toHaveTextContent(`in prod-backups-eu/${BACKUPS_PREFIX}`);
    await fireEvent.input(input, { target: { value: 'daily' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Anlegen' }));
    await settle();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('„daily“ gibt es in diesem Ordner schon');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await fireEvent.input(input, { target: { value: 'neu' } });
    await fireEvent.submit(input.closest('form')!);
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('öffnet mit F2 das Umbenennen und markiert den Namen ohne Endung', async () => {
    const { vm, naming } = mainWindow();
    render(NameDialog, { vm: naming });
    await openBackups(vm);
    const fileRow = vm.source.get(5)!;
    vm.selection.only(fileRow.key);
    await fireEvent.keyDown(window, { key: 'F2' });
    const dialog = await screen.findByRole('dialog', { name: `„${fileRow.name}“ umbenennen` });
    const input = within(dialog).getByRole<HTMLInputElement>('textbox', { name: /Name/ });
    await fireEvent.focus(input);
    expect(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe(
      fileRow.name.slice(0, fileRow.name.lastIndexOf('.')),
    );
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    vm.selection.only(vm.source.get(0)!.key);
    await fireEvent.keyDown(window, { key: 'F2' });
    const folderInput = await screen.findByRole<HTMLInputElement>('textbox', { name: /Name/ });
    await fireEvent.focus(folderInput);
    expect(folderInput.selectionEnd).toBe('daily'.length);
  });

  it('zeigt Fortschritt und Warnung beim Umbenennen', async () => {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const naming = new NameDialogViewModel({ backend });
    render(NameDialog, { vm: naming });
    const folder = { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX };
    let finish: (outcome: { newKey: string; undeleted: number }) => void = () => {};
    vi.spyOn(backend, 'renameObject').mockImplementation((_, __, ___, onProgress) => {
      onProgress({ copied: 2, total: 5 });
      return new Promise((resolve) => (finish = resolve));
    });
    naming.openRename({
      folder,
      items: [{ key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null, lastModifiedMs: null }],
    });
    naming.input('täglich');
    void naming.submit();
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('2 von 5 kopiert');
    expect(within(dialog).getByRole('button', { name: 'Abbrechen' })).toBeDisabled();
    finish({ newKey: 'x', undeleted: 1 });
    await settle();
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Kopiert, aber 1 Originale ließen sich nicht löschen.',
    );
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Filter und Suche im Hauptfenster', () => {
  async function openBackups(vm: BrowserViewModel) {
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
  }

  it('springt mit Strg+F ins Suchfeld, filtert und leert mit Esc', async () => {
    const { vm } = mainWindow();
    await openBackups(vm);
    const search = screen.getByRole('searchbox', { name: 'Objekte filtern' });
    expect(search).toHaveAttribute('placeholder', `Filtern in ${BACKUPS_PREFIX}`);
    await fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(search).toHaveFocus();
    await fireEvent.input(search, { target: { value: 'daily' } });
    await settle();
    expect(screen.getByText('daily/')).toBeInTheDocument();
    expect(screen.queryByText('weekly/')).not.toBeInTheDocument();
    expect(screen.getByText(/von \d+ \(gefiltert\)/)).toBeInTheDocument();
    await fireEvent.keyDown(search, { key: 'u', ctrlKey: true });
    await fireEvent.keyDown(search, { key: 'Escape' });
    await settle();
    expect(search).toHaveValue('');
    expect(screen.getByText('weekly/')).toBeInTheDocument();
  });

  it('filtert über die Menüs und zeigt bei leerem Ergebnis einen Ausweg', async () => {
    const { vm } = mainWindow();
    await openBackups(vm);
    await fireEvent.click(screen.getByRole('button', { name: 'Typ', expanded: false }));
    const menu = screen.getByRole('menu', { name: 'Filter' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Alle Typen' })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Ordner' }));
    await settle();
    expect(screen.getByRole('button', { name: /Typ: Ordner/ })).toHaveClass('is-pressed');
    expect(screen.queryByText(/\.tar\.zst$/)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Größe', expanded: false }));
    await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Über 1 GiB' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Keine Treffer' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    await settle();
    expect(screen.queryByRole('heading', { name: 'Keine Treffer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Typ/ })).not.toHaveClass('is-pressed');

    await fireEvent.click(screen.getByRole('button', { name: 'Datum', expanded: false }));
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('vergisst den Suchtext beim Wechsel des Ordners', async () => {
    const { vm, filter } = mainWindow();
    await openBackups(vm);
    filter.setText('daily');
    vm.openPrefix('');
    await settle();
    expect(filter.filter.text).toBe('');
  });
});

describe('Eigenschaften im Hauptfenster', () => {
  async function openDaily(vm: BrowserViewModel) {
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(`${BACKUPS_PREFIX}daily/`);
    await settle();
  }

  const panel = () => screen.getByRole('complementary', { name: 'Eigenschaften' });

  it('öffnet per Knopf, folgt der Auswahl und zeigt alle Abschnitte', async () => {
    const { vm } = mainWindow();
    await openDaily(vm);
    const toggle = screen.getByRole('button', { name: 'Eigenschaften (Alt+Enter)' });
    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(panel()).toHaveTextContent('Wähle eine Datei, um ihre Eigenschaften zu sehen.');
    await fireEvent.click(screen.getByText('db-incr-20261011-0600.tar.zst'));
    await settle();
    await settle();
    const general = within(panel()).getByRole('region', { name: 'Allgemein' });
    expect(general).toHaveTextContent('Content-Type application/zstd');
    expect(general).toHaveTextContent('312,6 MiB (327.784.858 Bytes)');
    expect(general).toHaveTextContent('Verschlüsselung SSE-S3 (AES-256)');
    expect(within(panel()).getByRole('region', { name: 'Tags' })).toHaveTextContent('0 von 10');
    expect(within(panel()).getAllByRole('listitem')).toHaveLength(3);
    expect(within(panel()).getByRole('region', { name: 'Versionen' })).toHaveTextContent('Delete Marker');
    expect(within(panel()).getByLabelText<HTMLInputElement>('Presigned URL').value).toContain('X-Amz-Expires=86400');
    expect(within(panel()).getByRole('region', { name: 'Berechtigungen' })).toHaveTextContent(
      'Nicht öffentlich · 1 Berechtigung · Eigentümer ops-team',
    );
    await fireEvent.click(within(panel()).getByRole('button', { name: 'Berechtigungen ausklappen' }));
    expect(within(panel()).getByRole('region', { name: 'Berechtigungen' })).toHaveTextContent('FULL_CONTROL');
    await fireEvent.click(within(panel()).getByRole('button', { name: 'Panel schließen (Alt+Enter)' }));
    expect(screen.queryByRole('complementary', { name: 'Eigenschaften' })).not.toBeInTheDocument();
    await fireEvent.keyDown(window, { key: 'Enter', altKey: true });
    expect(panel()).toBeInTheDocument();
  });

  it('bietet in der Freigabe unter Linux nur das Kopieren an', async () => {
    const { vm } = mainWindow('linux');
    await openDaily(vm);
    await fireEvent.click(screen.getByRole('button', { name: 'Eigenschaften (Alt+Enter)' }));
    await fireEvent.click(screen.getByText('db-incr-20261011-0600.tar.zst'));
    await settle();
    await settle();
    const share = within(panel()).getByRole('region', { name: 'Freigabe' });
    expect(within(share).getByRole('button', { name: 'Presigned URL kopieren' })).toBeInTheDocument();
    expect(within(share).queryByRole('button', { name: /Teilen/ })).not.toBeInTheDocument();
  });

  it('bearbeitet Metadaten und Tags im Panel', async () => {
    const { vm, details, writeText } = mainWindow();
    await openDaily(vm);
    details.isOpen = true;
    vm.selection.only(vm.source.get(0)!.key);
    await settle();
    await settle();
    const metadata = within(panel()).getByRole('region', { name: 'Metadaten' });
    await fireEvent.click(within(metadata).getByRole('button', { name: 'cache-control bearbeiten' }));
    await fireEvent.input(within(metadata).getByLabelText('Wert für cache-control'), {
      target: { value: 'max-age=60' },
    });
    await fireEvent.click(within(metadata).getByRole('button', { name: /Hinzufügen/ }));
    await fireEvent.input(within(metadata).getByLabelText('Name des neuen Metadatums'), {
      target: { value: 'x-amz-meta-retention' },
    });
    await fireEvent.input(within(metadata).getByLabelText('Wert für x-amz-meta-retention'), {
      target: { value: '90d' },
    });
    expect(metadata).toHaveTextContent('2 Änderungen · Speichern kopiert das Objekt auf sich selbst');
    await fireEvent.click(within(metadata).getByRole('button', { name: 'Speichern' }));
    await settle();
    await settle();
    expect(metadata).toHaveTextContent('x-amz-meta-retention 90d');
    expect(metadata).not.toHaveTextContent('Änderung');

    const tags = within(panel()).getByRole('region', { name: 'Tags' });
    await fireEvent.click(within(tags).getByRole('button', { name: /^Tag$/ }));
    await fireEvent.input(within(tags).getByLabelText('Tag-Schlüssel'), { target: { value: 'env' } });
    await fireEvent.input(within(tags).getByLabelText('Tag-Wert'), { target: { value: 'prod' } });
    await fireEvent.click(within(tags).getByRole('button', { name: 'Hinzufügen' }));
    await settle();
    expect(tags).toHaveTextContent('1 von 10');
    await fireEvent.click(within(tags).getByRole('button', { name: 'Tag env entfernen' }));
    await settle();
    expect(tags).toHaveTextContent('0 von 10');

    const general = within(panel()).getByRole('region', { name: 'Allgemein' });
    await fireEvent.click(within(general).getByRole('button', { name: 'Key kopieren' }));
    expect(writeText).toHaveBeenCalledWith(`${BACKUPS_PREFIX}daily/db-incr-20261011-0600.tar.zst`);
  });

  it('stellt Versionen wieder her, löscht sie nach Rückfrage und ändert die Gültigkeit', async () => {
    const { vm, details, writeText, backend } = mainWindow();
    await openDaily(vm);
    details.isOpen = true;
    vm.selection.only(vm.source.get(0)!.key);
    await settle();
    await settle();
    const versions = within(panel()).getByRole('region', { name: 'Versionen' });
    await fireEvent.click(within(versions).getByRole('button', { name: 'Version p7Kd2sVb… wiederherstellen' }));
    await settle();
    await settle();
    expect(within(versions).getAllByRole('listitem')).toHaveLength(4);
    await fireEvent.click(within(versions).getByRole('button', { name: 'Version Wq9XzTn2… endgültig löschen' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Version endgültig löschen?' });
    expect(confirm).toHaveTextContent('Das lässt sich nicht rückgängig machen.');
    await fireEvent.click(within(confirm).getByRole('button', { name: 'Endgültig löschen' }));
    await settle();
    await settle();
    expect(within(versions).getAllByRole('listitem')).toHaveLength(3);
    await fireEvent.click(
      within(versions).getByRole('button', { name: /neu-1… endgültig löschen|Version neu-1 endgültig löschen/ }),
    );
    expect(screen.getByRole('alertdialog')).toHaveTextContent('aktuelle Version');
    await fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Abbrechen' }));

    const share = within(panel()).getByRole('region', { name: 'Freigabe' });
    expect(share).toHaveTextContent('bis 12.10.2026 15:23:08');
    await fireEvent.change(within(share).getByLabelText('Gültigkeit des Links'), { target: { value: '3600' } });
    await settle();
    expect(within(share).getByLabelText<HTMLInputElement>('Presigned URL').value).toContain('X-Amz-Expires=3600');
    await fireEvent.click(within(share).getByRole('button', { name: 'Presigned URL kopieren' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('X-Amz-Expires=3600'));
    const shareLink = vi.spyOn(backend, 'shareLink').mockRejectedValueOnce({ kind: 'share', message: 'kein Dialog' });
    await fireEvent.click(within(share).getByRole('button', { name: /Teilen/ }));
    await settle();
    expect(shareLink).toHaveBeenCalledWith(
      'db-incr-20261011-0600.tar.zst',
      expect.stringContaining('X-Amz-Expires=3600'),
    );
    expect(within(share).getByRole('alert')).toHaveTextContent('kein Dialog');
  });

  it('teilt eine Datei über das Kontextmenü mit dem Teilen-Dialog von Windows', async () => {
    const { vm, backend, share } = mainWindow();
    await openDaily(vm);
    const openMenu = () =>
      fireEvent.contextMenu(screen.getByText('db-incr-20261011-0600.tar.zst'), { clientX: 5, clientY: 5 });
    await openMenu();
    await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Teilen/ }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: '„db-incr-20261011-0600.tar.zst“ teilen' });
    expect(dialog).toHaveTextContent('bis 12.10.2026 15:23:08');
    expect(dialog).toHaveTextContent('Wer den Link erhält');
    await fireEvent.change(within(dialog).getByLabelText('Gültigkeit des Links'), { target: { value: '604800' } });
    await settle();
    const shareLink = vi.spyOn(backend, 'shareLink');
    await fireEvent.click(within(dialog).getByRole('button', { name: /Teilen/ }));
    await settle();
    expect(shareLink).toHaveBeenCalledWith(
      'db-incr-20261011-0600.tar.zst',
      expect.stringContaining('X-Amz-Expires=604800'),
    );
    expect(share.isOpen).toBe(false);

    for (const close of [
      () => fireEvent.click(screen.getByRole('button', { name: 'Schließen' })),
      () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }),
    ]) {
      await openMenu();
      await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Teilen/ }));
      await close();
      expect(share.isOpen).toBe(false);
    }
  });

  it('bietet Eigenschaften und Presigned URL im Kontextmenü', async () => {
    const { vm, details, writeText } = mainWindow();
    await openDaily(vm);
    await fireEvent.contextMenu(screen.getByText('db-incr-20261011-0600.tar.zst'), { clientX: 5, clientY: 5 });
    await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Presigned URL kopieren/ }));
    await settle();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('X-Amz-Expires=86400'));
    await fireEvent.contextMenu(screen.getByText('db-incr-20261011-0600.tar.zst'), { clientX: 5, clientY: 5 });
    await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Eigenschaften/ }));
    expect(details.isOpen).toBe(true);
  });
});

describe('Kontextmenü im Verbindungsbaum', () => {
  it('öffnet per Rechtsklick, trennt und löscht eine Verbindung nach Rückfrage', async () => {
    const { vm, connectionActions } = mainWindow();
    render(DeleteConnectionDialog, { vm: connectionActions });
    await vm.loadProfiles();
    await settle();
    await fireEvent.contextMenu(screen.getByText('AWS Produktion'), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole('menu', { name: 'Aktionen für die Verbindung' });
    await fireEvent.click(within(menu).getByRole('menuitem', { name: /Trennen/ }));
    expect(vm.connections[0].status).toBe('disconnected');

    await fireEvent.contextMenu(screen.getByText('Backblaze B2 Archiv'), { clientX: 10, clientY: 10 });
    await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Verbindung löschen/ }));
    const confirm = screen.getByRole('alertdialog', { name: 'Verbindung löschen?' });
    expect(confirm).toHaveTextContent('„Backblaze B2 Archiv“ wird mit den gespeicherten Zugangsdaten entfernt.');
    expect(confirm).toHaveTextContent('Die Daten im Bucket bleiben unberührt.');
    expect(within(confirm).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
    await fireEvent.click(within(confirm).getByRole('button', { name: 'Verbindung löschen' }));
    await settle();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Backblaze B2 Archiv')).not.toBeInTheDocument();
  });

  it('zeigt Fehler beim Löschen und schließt mit Esc', async () => {
    const { vm, backend, connectionActions } = mainWindow();
    render(DeleteConnectionDialog, { vm: connectionActions });
    await vm.loadProfiles();
    vi.spyOn(backend, 'deleteProfile').mockRejectedValueOnce({ kind: 'credential', message: 'Speicher gesperrt' });
    connectionActions.requestDelete('aws-prod');
    await settle();
    const confirm = screen.getByRole('alertdialog');
    await fireEvent.click(within(confirm).getByRole('button', { name: 'Verbindung löschen' }));
    await settle();
    expect(within(confirm).getByRole('alert')).toHaveTextContent('Speicher gesperrt');
    await fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('öffnet das Menü für Buckets per Umschalt+F10 und ignoriert leere Stellen', async () => {
    const { vm, connectionActions, writeText } = mainWindow();
    await vm.loadProfiles();
    await settle();
    const tree = screen.getByRole('tree');
    await fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });
    expect(connectionActions.menu.state).toBeNull();
    await fireEvent.click(screen.getByText('prod-logs-eu'));
    await fireEvent.keyDown(tree, { key: 'ContextMenu' });
    const menu = screen.getByRole('menu');
    await fireEvent.click(within(menu).getByRole('menuitem', { name: /Pfad kopieren/ }));
    expect(writeText).toHaveBeenCalledWith('s3://prod-logs-eu');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    tree.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await fireEvent.keyDown(tree, { key: 'ArrowDown' });
  });
});

describe('Kontextmenü im Hauptfenster', () => {
  async function openBackups(vm: BrowserViewModel) {
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
  }

  it('öffnet per Rechtsklick auf eine Zeile und führt die gewählte Aktion aus', async () => {
    const { vm, naming } = mainWindow();
    render(NameDialog, { vm: naming });
    await openBackups(vm);
    await fireEvent.contextMenu(screen.getByText('daily/'), { clientX: 50, clientY: 60 });
    const menu = screen.getByRole('menu', { name: 'Aktionen für die Auswahl' });
    expect(within(menu).getByRole('menuitem', { name: /Öffnen/ })).toHaveFocus();
    expect(vm.selectedEntries.map((e) => e.name)).toEqual(['daily/']);
    await fireEvent.click(within(menu).getByRole('menuitem', { name: /Umbenennen/ }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: '„daily“ umbenennen' })).toBeInTheDocument();
  });

  it('bietet auf freier Fläche Ordner-Aktionen und öffnet per Umschalt+F10', async () => {
    const { vm, actions } = mainWindow();
    await openBackups(vm);
    const grid = screen.getByRole('grid', { name: /Objekte/ });
    await fireEvent.contextMenu(grid, { clientX: 5, clientY: 5 });
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['Einfügen Strg+V', 'Neuer Ordner', 'Hochladen Strg+U', 'Aktualisieren F5']);
    await fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
    expect(actions.menu.state).not.toBeNull();
    actions.menu.close();
    await fireEvent.keyDown(grid, { key: 'ContextMenu' });
    expect(actions.menu.state).not.toBeNull();
  });

  it('unterdrückt außerhalb der Tabelle das Browser-Menü (Teilen, Drucken), außer in Eingabefeldern', async () => {
    const { vm, actions } = mainWindow();
    await openBackups(vm);
    expect(await fireEvent.contextMenu(screen.getByRole('button', { name: /Hochladen/ }))).toBe(false);
    expect(actions.menu.state).toBeNull();
    expect(await fireEvent.contextMenu(screen.getByRole('searchbox'))).toBe(true);
    await fireEvent.keyDown(screen.getByRole('button', { name: /Hochladen/ }), { key: 'F10', shiftKey: true });
    expect(actions.menu.state).toBeNull();
  });
});

describe('Kopieren und Verschieben im Hauptfenster', () => {
  it('merkt mit Strg+C, zeigt den Hinweis und fügt mit Strg+V ein', async () => {
    const { vm, transfers, clipboard } = mainWindow();
    const copy = vi.spyOn(transfers, 'copy').mockResolvedValue();
    await vm.loadProfiles();
    vm.openBucket('aws-prod', 'prod-backups-eu');
    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
    await fireEvent.click(screen.getByText('daily/'));
    await fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
    const hint = await screen.findByRole('button', { name: /1 Eintrag zum Verschieben gemerkt/ });
    vm.openPrefix('');
    await settle();
    await fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    expect(copy).toHaveBeenCalledWith(
      {
        folder: { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: BACKUPS_PREFIX },
        items: [{ key: `${BACKUPS_PREFIX}daily/`, isFolder: true, size: 0, etag: null, lastModifiedMs: null }],
      },
      { profileId: 'aws-prod', bucket: 'prod-backups-eu', prefix: '' },
      true,
    );
    expect(hint).not.toBeInTheDocument();

    vm.openPrefix(BACKUPS_PREFIX);
    await settle();
    await fireEvent.click(screen.getByText('daily/'));
    await fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    await fireEvent.click(await screen.findByRole('button', { name: /zum Kopieren gemerkt/ }));
    expect(clipboard.content).toBeNull();
  });

  it('zeigt Kopien in der Queue mit Quelle und Ziel', async () => {
    const { vm } = transferPanel([
      transfer({
        direction: 'copy',
        name: 'db.tar',
        key: 'neu/db.tar',
        localPath: '',
        copySource: { bucket: 'prod-backups-eu', key: 'alt/db.tar' },
        partCount: 1,
      }),
    ]);
    vm.expanded = true;
    await settle();
    const row = within(screen.getByRole('grid', { name: 'Transfer-Liste' })).getAllByRole('row')[0];
    expect(within(row).getByRole('img', { name: 'Kopie' })).toBeInTheDocument();
    expect(row).toHaveTextContent('db.tar prod-backups-eu/alt/ → prod-backups-eu/neu/');
    expect(row).toHaveTextContent('Kopiert');
  });
});

function transferPanel(list = [transfer()]) {
  const backend = createFakeBackend({ pageDelayMs: 0 });
  const vm = new TransfersViewModel({ backend, picker: createFakeFilePicker() });
  vm.transfers = list;
  render(TransferPanel, { vm });
  return { vm };
}

describe('TransferPanel', () => {
  it('rendert bei sehr vielen Transfers nur die sichtbaren Zeilen', async () => {
    const restore = mockClientHeight(280);
    try {
      const many = Array.from({ length: 5000 }, (_, i) =>
        transfer({ id: i + 1, name: `datei-${i + 1}.bin`, state: 'waiting' }),
      );
      const { vm } = transferPanel(many);
      vm.expanded = true;
      await settle();
      const grid = screen.getByRole('grid', { name: 'Transfer-Liste' });
      expect(within(grid).getAllByRole('row').length).toBeLessThan(30);
      expect(grid).toHaveTextContent('Wartend · Platz 1');
      grid.scrollTop = 28 * 4000;
      await fireEvent.scroll(grid);
      expect(grid).toHaveTextContent('datei-4001.bin');
      expect(grid).not.toHaveTextContent('datei-1.bin ');
    } finally {
      restore();
    }
  });

  it('zeigt eingeklappt Zähler, aktuellen Vorgang und Summen', () => {
    transferPanel([
      transfer(),
      transfer({ id: 2, state: 'waiting', bytesPerSec: 0 }),
      transfer({ id: 3, state: 'failed' }),
    ]);
    const bar = screen.getByRole('region', { name: 'Transfers' });
    expect(bar).toHaveTextContent('1 aktiv');
    expect(bar).toHaveTextContent('1 wartend');
    expect(bar).toHaveTextContent('1 Fehler');
    expect(bar).toHaveTextContent('db-full-20261011.tar.zst · Teil 101 / 152');
    expect(bar).toHaveTextContent('32,0 MiB/s');
    expect(screen.getByRole('progressbar', { name: 'Gesamtfortschritt' })).toHaveAttribute('aria-valuenow', '65');
  });

  it('zeigt Downloads mit Richtung, Ziel und Tempo je Richtung', async () => {
    const { vm } = transferPanel([
      transfer(),
      transfer({
        id: 2,
        direction: 'download',
        name: 'media.zip',
        key: 'exports/media.zip',
        localPath: 'D:\\Exporte\\media.zip',
        partCount: 1,
        bytesPerSec: 16 * 1024 ** 2,
      }),
    ]);
    const bar = screen.getByRole('region', { name: 'Transfers' });
    expect(within(bar).getByRole('img', { name: 'Upload' }).parentElement).toHaveTextContent('32,0 MiB/s');
    expect(within(bar).getByRole('img', { name: 'Download' }).parentElement).toHaveTextContent('16,0 MiB/s');
    vm.expanded = true;
    await settle();
    const rows = within(screen.getByRole('grid', { name: 'Transfer-Liste' })).getAllByRole('row');
    expect(within(rows[1]).getByRole('img', { name: 'Download' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('media.zip ← prod-backups-eu/exports/ nach D:\\Exporte');
    expect(rows[1]).toHaveTextContent('Lädt herunter');
  });

  it('zeigt ohne laufende Transfers kein Tempo', () => {
    transferPanel([transfer({ state: 'waiting', bytesPerSec: 0 })]);
    expect(screen.getByRole('region', { name: 'Transfers' })).toHaveTextContent('—');
  });

  it('ist ohne Transfers unsichtbar', () => {
    transferPanel([]);
    expect(screen.queryByRole('region', { name: 'Transfers' })).not.toBeInTheDocument();
  });

  it('zeigt ausgeklappt alle Zustände mit passenden Aktionen', async () => {
    const service = {
      code: 'RequestTimeout',
      message: 'Der Endpunkt hat 30 s lang keine Daten angenommen',
      httpStatus: 400,
      requestId: 'R1',
    };
    const { vm } = transferPanel([
      transfer({ id: 1 }),
      transfer({ id: 2, state: 'waiting' }),
      transfer({ id: 3, state: 'paused' }),
      transfer({ id: 4, state: 'failed', error: { kind: 'service', message: 'RequestTimeout', service } }),
      transfer({ id: 5, state: 'done', finishedMs: new Date(2026, 9, 11, 15, 9).getTime() }),
      transfer({ id: 6, state: 'cancelled' }),
    ]);
    const spies = {
      pause: vi.spyOn(vm, 'pause'),
      resume: vi.spyOn(vm, 'resume'),
      cancel: vi.spyOn(vm, 'cancel'),
      retry: vi.spyOn(vm, 'retry'),
    };
    vm.expanded = true;
    await settle();
    const list = screen.getByRole('grid', { name: 'Transfer-Liste' });
    const rows = within(list).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Wartend · Platz 1');
    expect(rows[4]).toHaveTextContent('RequestTimeout · Der Endpunkt hat 30 s lang keine Daten angenommen');
    expect(rows[4]).toHaveTextContent('HTTP 400 · Request-ID R1');
    expect(list).toHaveTextContent('Fertig · 15:09');
    expect(list).toHaveTextContent('Abgebrochen');

    await fireEvent.click(within(rows[0]).getByRole('button', { name: 'Pausieren' }));
    await fireEvent.click(within(rows[2]).getByRole('button', { name: 'Fortsetzen' }));
    await fireEvent.click(within(rows[1]).getByRole('button', { name: 'Abbrechen' }));
    await fireEvent.click(within(rows[4]).getByRole('button', { name: 'Erneut versuchen' }));
    expect(spies.pause).toHaveBeenCalledWith(1);
    expect(spies.resume).toHaveBeenCalledWith(3);
    expect(spies.cancel).toHaveBeenCalledWith(2);
    expect(spies.retry).toHaveBeenCalledWith(4);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await fireEvent.click(within(rows[4]).getByRole('button', { name: 'Fehlerdetails kopieren' }));
    expect(writeText).toHaveBeenCalledWith('RequestTimeout · RequestTimeout · HTTP 400 · Request-ID R1');

    await fireEvent.click(rows[0]);
    expect(vm.selectedId).toBe(1);
  });

  it('filtert per Tabs, bedient Sammelaktionen und klappt wieder ein', async () => {
    const { vm } = transferPanel([transfer({ id: 1 }), transfer({ id: 2, state: 'done' })]);
    vm.expanded = true;
    await settle();
    await fireEvent.click(screen.getByRole('tab', { name: /Fertig/ }));
    expect(within(screen.getByRole('grid')).getAllByRole('row')).toHaveLength(1);
    await fireEvent.click(screen.getByRole('tab', { name: /Fehler/ }));
    expect(screen.getByText('Keine Transfers in dieser Ansicht.')).toBeInTheDocument();
    const pauseAll = vi.spyOn(vm, 'pauseAll');
    await fireEvent.click(screen.getByRole('button', { name: /Alle pausieren/ }));
    expect(pauseAll).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Fortsetzen/ })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: /Transfers/, expanded: true }));
    expect(vm.expanded).toBe(false);
  });

  it('zeigt Fehler der Aktionen als Leiste', async () => {
    const { vm } = transferPanel();
    vm.error = { kind: 'localFile', message: 'Lokale Datei: fehlt' };
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Lokale Datei: fehlt');
  });
});

describe('App', () => {
  it('verdrahtet Theme, Hauptfenster und Verbindungsdialog', async () => {
    render(App, { backend: createFakeBackend({ pageDelayMs: 0 }) });
    expect(document.documentElement.dataset.theme).toMatch(/dark|light/);
    await waitFor(() => expect(screen.getByText('AWS Produktion')).toBeInTheDocument());
    await fireEvent.click(screen.getAllByRole('button', { name: /Neue Verbindung/ })[0]);
    expect(screen.getByRole('dialog', { name: 'Neue Verbindung' })).toBeInTheDocument();
  });

  it('lädt den offenen Ordner nach „Neuer Ordner“ und Löschen neu', async () => {
    render(App, { backend: createFakeBackend({ pageDelayMs: 0 }) });
    await fireEvent.click(await screen.findByText('prod-exports-eu'));
    await screen.findByText('Dieser Bucket ist leer');
    await fireEvent.click(screen.getByRole('button', { name: /Neuer Ordner/ }));
    await fireEvent.input(screen.getByRole('textbox', { name: /Name/ }), { target: { value: 'neu' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await fireEvent.click(await screen.findByText('neu/'));
    await fireEvent.keyDown(window, { key: 'Delete' });
    const dialog = await screen.findByRole('alertdialog');
    await fireEvent.click(await within(dialog).findByRole('button', { name: /Löschen/ }));
    await waitFor(() => expect(screen.queryByText('neu/')).not.toBeInTheDocument());
  });

  it('fügt mit Strg+C und Strg+V eine nummerierte Kopie ein und lädt den Ordner neu', async () => {
    render(App, { backend: createFakeBackend({ pageDelayMs: 0, transfers: { tickMs: 5 } }) });
    await fireEvent.click(await screen.findByText('prod-exports-eu'));
    await screen.findByText('Dieser Bucket ist leer');
    await fireEvent.click(screen.getByRole('button', { name: /Neuer Ordner/ }));
    await fireEvent.input(screen.getByRole('textbox', { name: /Name/ }), { target: { value: 'neu' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await fireEvent.click(await screen.findByText('neu/'));
    await fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    await fireEvent.keyDown(window, { key: 'v', ctrlKey: true });

    expect(await screen.findByText('neu (2)/')).toBeInTheDocument();
  });

  it('bearbeitet über das Baum-Menü und löscht die Verbindung aus dem Dialog', async () => {
    render(App, { backend: createFakeBackend({ pageDelayMs: 0 }) });
    await fireEvent.contextMenu(await screen.findByText('Backblaze B2 Archiv'), { clientX: 5, clientY: 5 });
    await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Bearbeiten/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Verbindung bearbeiten' });
    await fireEvent.click(within(dialog).getByRole('button', { name: /Löschen/ }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Verbindung löschen?' });
    await fireEvent.click(within(confirm).getByRole('button', { name: 'Verbindung löschen' }));
    await waitFor(() => expect(screen.queryByText('Backblaze B2 Archiv')).not.toBeInTheDocument());
  });

  it('übernimmt gespeicherte Ansichtswerte und wendet neue sofort an', async () => {
    localStorage.setItem('s3client.view', JSON.stringify({ autoConnect: false, compact: true, hiddenColumns: [] }));
    try {
      render(App, { backend: createFakeBackend({ pageDelayMs: 0 }) });
      await screen.findByText('AWS Produktion');
      expect(screen.queryByText('prod-backups-eu')).not.toBeInTheDocument();
      await fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      const dialog = await screen.findByRole('dialog', { name: 'Einstellungen' });
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Darstellung' }));
      await fireEvent.click(within(dialog).getByRole('radio', { name: 'Standard, 28 px' }));
      await fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Größe' }));
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(JSON.parse(localStorage.getItem('s3client.view') ?? '{}')).toEqual({
        autoConnect: false,
        compact: false,
        hiddenColumns: ['size'],
      });
    } finally {
      localStorage.removeItem('s3client.view');
    }
  });

  it('wählt ohne Tauri das Fake-Backend', async () => {
    render(App);
    await waitFor(() => expect(screen.getByText('AWS Produktion')).toBeInTheDocument());
  });
});

describe('Einstellungen', () => {
  function settingsDialog() {
    const backend = createFakeBackend({ pageDelayMs: 0 });
    const theme = new ThemeViewModel(memoryStore(), { prefersDark: () => true, subscribe: () => () => {} });
    const view = new ViewPreferences(memoryStore());
    const vm = new SettingsViewModel({ backend, theme, view });
    render(SettingsDialog, { vm });
    return { vm, backend, theme, view };
  }

  const dialog = () => screen.getByRole('dialog', { name: 'Einstellungen' });
  const footer = () => within(dialog());

  it('öffnet im Hauptfenster per Knopf und mit Strg+Komma', async () => {
    const { settings } = mainWindow();
    await fireEvent.click(screen.getByRole('button', { name: 'Einstellungen (Strg+,)' }));
    expect(settings.isOpen).toBe(true);
    settings.close();
    await fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(settings.isOpen).toBe(true);
  });

  it('bearbeitet Transfer-Werte, zeigt Fehler und speichert', async () => {
    const { vm, backend } = settingsDialog();
    await vm.open();
    await settle();
    expect(screen.getByRole('heading', { name: 'Transfers' })).toBeInTheDocument();
    const save = footer().getByRole('button', { name: 'Speichern' });
    expect(save).toBeDisabled();

    const transfers = screen.getByRole('spinbutton', { name: 'Gleichzeitige Transfers' });
    await fireEvent.input(transfers, { target: { value: '99' } });
    expect(screen.getByText('Gleichzeitige Transfers muss zwischen 1 und 32 liegen')).toBeInTheDocument();
    expect(save).toBeDisabled();
    await fireEvent.input(transfers, { target: { value: '4' } });
    expect(screen.getByText('1 Änderung in Transfers')).toBeInTheDocument();
    expect(screen.getByLabelText('1 ungespeichert')).toBeInTheDocument();

    await fireEvent.change(screen.getByRole('combobox', { name: 'Teilgröße' }), { target: { value: '64' } });
    expect(screen.getByText(/höchstens 625 GiB pro Objekt/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Begrenzen' }));
    const download = screen.getByRole('spinbutton', { name: 'Download-Limit' });
    expect(download).toHaveValue(null);
    await fireEvent.input(download, { target: { value: '20' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Upload-Limit' }), { target: { value: '' } });
    await fireEvent.click(screen.getByRole('radio', { name: 'Überspringen' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Fehlgeschlagene Teile wiederholen' }));
    await fireEvent.click(
      screen.getByRole('checkbox', { name: 'Prüfsumme nach dem Upload vergleichen (CRC32C, sonst MD5)' }),
    );
    expect(screen.queryByRole('spinbutton', { name: 'Anzahl Wiederholungen' })).not.toBeInTheDocument();
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Multipart-Schwelle' }), { target: { value: '128' } });

    await fireEvent.click(save);
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((await backend.getSettings()).transfers).toEqual(
      expect.objectContaining({
        maxTransfers: 4,
        partSizeMib: 64,
        multipartThresholdMib: 128,
        uploadLimitMibps: 0,
        downloadLimitMibps: 20,
        conflict: 'skip',
        retries: 0,
        verifyChecksums: false,
      }),
    );
  });

  it('wechselt Kategorien, sucht und setzt Darstellung zurück', async () => {
    const { vm, theme, view } = settingsDialog();
    await vm.open();
    await settle();
    const nav = within(screen.getByRole('navigation', { name: 'Kategorien' }));

    await fireEvent.click(nav.getByRole('button', { name: 'Allgemein' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Alle Verbindungen beim Start verbinden' }));
    expect(vm.draft.autoConnect).toBe(false);

    await fireEvent.click(nav.getByRole('button', { name: 'Darstellung' }));
    expect(nav.getByRole('button', { name: 'Darstellung' })).toHaveAttribute('aria-current', 'page');
    await fireEvent.click(screen.getByRole('radio', { name: 'Hell' }));
    await fireEvent.click(screen.getByRole('radio', { name: 'Kompakt, 24 px' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'ETag' }));
    expect(screen.getByText('4 Änderungen')).toBeInTheDocument();
    await fireEvent.click(footer().getByRole('button', { name: 'Standardwerte' }));
    expect(screen.getByRole('radio', { name: 'Standard, 28 px' })).toBeChecked();
    await fireEvent.click(screen.getByRole('radio', { name: 'Dunkel' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Größe' }));
    await fireEvent.click(screen.getByRole('radio', { name: 'Kompakt, 24 px' }));
    await fireEvent.click(screen.getByRole('radio', { name: 'Standard, 28 px' }));

    await fireEvent.click(nav.getByRole('button', { name: 'Sicherheit' }));
    expect(screen.getByText(/Windows-Anmeldeinformationsspeicher/)).toBeInTheDocument();
    expect(footer().getByRole('button', { name: 'Standardwerte' })).toBeDisabled();
    await fireEvent.click(nav.getByRole('button', { name: 'Über' }));
    expect(screen.getByText('S3 Commander')).toBeInTheDocument();
    expect(screen.getByText('Tauri 2, Rust, Svelte 5')).toBeInTheDocument();

    const search = screen.getByRole('searchbox', { name: 'Einstellung suchen' });
    await fireEvent.input(search, { target: { value: 'zertifikat' } });
    expect(screen.getByRole('heading', { name: 'Sicherheit' })).toBeInTheDocument();
    await fireEvent.input(search, { target: { value: 'xyz' } });
    expect(screen.getByText('Keine Einstellung gefunden.')).toBeInTheDocument();

    await fireEvent.click(footer().getByRole('button', { name: 'Speichern' }));
    await settle();
    expect(theme.preference).toBe('dark');
    expect(view.value).toEqual({ autoConnect: false, compact: false, hiddenColumns: ['size'] });
  });

  it('schaltet den Listing-Cache und leert ihn', async () => {
    const { vm, backend } = settingsDialog();
    await backend.listFolder('aws-prod', 'prod-backups-eu', '', 'l', () => {});
    await vm.open('cache');
    await settle();
    expect(screen.getByText('1 Ordner · 1 Eintrag · 160 B')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Cache leeren' }));
    await settle();
    expect(screen.getByText('0 Ordner · 0 Einträge · 0 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cache leeren' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Ordner-Listings zwischenspeichern' }));
    expect(vm.draft.cacheEnabled).toBe(false);
  });

  it('schließt mit Abbrechen, Kreuz und Esc und zeigt Fehler', async () => {
    const { vm, backend } = settingsDialog();
    await vm.open();
    await settle();
    await fireEvent.click(footer().getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await vm.open();
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'Dialog schließen' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.spyOn(backend, 'getSettings').mockRejectedValueOnce({ kind: 'repository', message: 'Datei fehlt' });
    await vm.open();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Datei fehlt');
    await fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Zwei-Panel-Ansicht', () => {
  async function openSplit() {
    const window = mainWindow();
    await window.vm.loadProfiles();
    window.vm.openBucket('aws-prod', 'prod-backups-eu');
    window.vm.openPrefix(BACKUPS_PREFIX);
    await settle();
    await fireEvent.click(screen.getByRole('button', { name: 'Zwei-Panel' }));
    await settle();
    return window;
  }

  const localGrid = () => screen.getByRole('grid', { name: /^(Dieser PC|Lokal: )/ });

  it('zeigt lokal links, navigiert dort und schaltet zurück auf die Liste', async () => {
    const { local } = await openSplit();
    expect(screen.getByRole('button', { name: 'Zwei-Panel' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(localGrid()).getByText('D:')).toBeInTheDocument();
    expect(within(localGrid()).queryByRole('columnheader', { name: /Storage Class/ })).not.toBeInTheDocument();
    await fireEvent.dblClick(within(localGrid()).getByText('D:'));
    await settle();
    await fireEvent.dblClick(within(localGrid()).getByText('Backups'));
    await settle();
    const crumbs = within(screen.getByRole('navigation', { name: 'Lokaler Pfad' }));
    expect(crumbs.getByRole('button', { name: 'Backups' })).toBeInTheDocument();
    await fireEvent.click(crumbs.getByRole('button', { name: 'D:' }));
    await settle();
    expect(local.path).toBe('D:\\');
    await fireEvent.click(screen.getByRole('button', { name: 'Lokal eine Ebene hoch' }));
    await settle();
    expect(local.path).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Lokal aktualisieren' }));
    await fireEvent.click(crumbs.getByRole('button', { name: 'Dieser PC' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Liste' }));
    expect(screen.queryByRole('region', { name: 'Lokale Dateien' })).not.toBeInTheDocument();
  });

  it('sortiert lokal und zeigt leere und nicht lesbare Ordner', async () => {
    const { local, backend } = await openSplit();
    await local.open('D:\\Backups\\db-prod');
    await settle();
    await fireEvent.click(within(localGrid()).getByRole('button', { name: 'Größe' }));
    expect(local.sort.column).toBe('size');
    vi.spyOn(backend, 'listLocalDir').mockResolvedValueOnce([]);
    await local.open('D:\\Leer');
    await settle();
    expect(screen.getByRole('heading', { name: 'Dieser Ordner ist leer' })).toBeInTheDocument();
    await local.open('Q:\\fehlt');
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Ordner nicht lesbar');
  });

  it('kopiert über die Leiste in beide Richtungen', async () => {
    const { vm, local, transfers } = await openSplit();
    const upload = vi.spyOn(transfers, 'uploadPaths').mockResolvedValue();
    const download = vi.spyOn(transfers, 'downloadTo').mockResolvedValue();
    await local.open('D:\\Backups\\db-prod');
    await settle();
    const toBucket = screen.getByRole('button', { name: 'In den Bucket kopieren' });
    const toLocal = screen.getByRole('button', { name: 'Lokal speichern' });
    expect([toBucket, toLocal].map((b) => (b as HTMLButtonElement).disabled)).toEqual([true, true]);
    await fireEvent.click(within(localGrid()).getByText('checksums.sha256'));
    await fireEvent.click(toBucket);
    expect(upload).toHaveBeenCalledWith(vm.uploadTarget, ['D:\\Backups\\db-prod\\checksums.sha256']);
    await fireEvent.click(screen.getByText('daily/'));
    await fireEvent.click(toLocal);
    await settle();
    expect(download).toHaveBeenCalledWith(await vm.resolveSelection(), 'D:\\Backups\\db-prod');
  });

  it('nutzt auf der lokalen Seite nur deren Kürzel', async () => {
    const { local, transfers, deletion } = await openSplit();
    const upload = vi.spyOn(transfers, 'uploadPaths').mockResolvedValue();
    const remove = vi.spyOn(deletion, 'handleShortcut');
    await local.open('D:\\Backups\\db-prod');
    await settle();
    await fireEvent.click(within(localGrid()).getByText('checksums.sha256'));
    await fireEvent.keyDown(localGrid(), { key: 'u', ctrlKey: true });
    expect(upload).toHaveBeenCalledOnce();
    await fireEvent.keyDown(localGrid(), { key: 'Delete' });
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.keyDown(localGrid(), { key: 'Backspace' });
    await settle();
    expect(local.path).toBe('D:\\Backups');
    await fireEvent.contextMenu(localGrid(), { clientX: 5, clientY: 5 });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('gleicht lokal und Bucket ab und bietet das Löschen überzähliger Objekte an', async () => {
    const { local, transfers, deletion } = await openSplit();
    const sync = screen.getByRole('button', { name: 'Abgleichen' });
    expect(sync).toBeDisabled();
    await local.open('D:\\Backups\\db-prod');
    await settle();
    await fireEvent.click(sync);
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Abgleichen' });
    expect(within(dialog).getByText('4 Dateien (5,30 GiB) · 4 neu · 0 unverändert')).toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: 'Zu übertragen' })).toHaveTextContent(
      'alt/db-full-20261001.tar.zst',
    );

    await fireEvent.click(within(dialog).getByRole('radio', { name: /^Bucket → Lokal/ }));
    await settle();
    expect(within(dialog).getByText(/liegen nur lokal und bleiben unverändert/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('radio', { name: /^Lokal → Bucket/ }));
    await settle();
    await fireEvent.click(within(dialog).getByRole('checkbox', { name: /Danach im Bucket löschen/ }));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Neu vergleichen' }));
    await settle();
    expect(within(dialog).getByRole('checkbox', { name: /Danach im Bucket löschen/ })).toBeChecked();
    const upload = vi.spyOn(transfers, 'start');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Abgleichen' }));
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Abgleichen' })).not.toBeInTheDocument();
    expect(deletion.phase).not.toBe('closed');
    expect(deletion.selection?.items.length).toBeGreaterThan(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it('schließt den Abgleich mit Abbrechen, Kreuz und Esc', async () => {
    const { local, sync } = await openSplit();
    await local.open('D:\\Backups\\db-prod');
    await settle();
    for (const close of [
      () => fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' })),
      () => fireEvent.click(screen.getByRole('button', { name: 'Dialog schließen' })),
      () => fireEvent.keyDown(screen.getByRole('dialog', { name: 'Abgleichen' }), { key: 'Escape' }),
    ]) {
      await fireEvent.click(screen.getByRole('button', { name: 'Abgleichen' }));
      await settle();
      await close();
      expect(sync.isOpen).toBe(false);
    }
  });

  it('zieht Dateien mit der Maus auf die andere Seite', async () => {
    const { local, transfers, panelDrag } = await openSplit();
    const upload = vi.spyOn(transfers, 'uploadPaths').mockResolvedValue();
    await local.open('D:\\Backups\\db-prod');
    await settle();
    const dailyRow = screen.getByText('daily/').closest('[role="row"]') as HTMLElement;
    const elementFromPoint = vi.fn(() => dailyRow as Element | null);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint });
    try {
      const row = within(localGrid()).getByText('checksums.sha256').closest('[role="row"]') as HTMLElement;
      await fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
      await fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
      expect(panelDrag.active).toBe(true);
      expect(dailyRow).toHaveClass('is-drop');
      expect(screen.getByText('1 Element · 412 B')).toBeInTheDocument();
      await fireEvent.keyDown(window, { key: 'Escape' });
      expect(panelDrag.active).toBe(false);

      await fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
      await fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
      await fireEvent.pointerUp(window);
      expect(upload).toHaveBeenCalledWith(expect.objectContaining({ prefix: `${BACKUPS_PREFIX}daily/` }), [
        'D:\\Backups\\db-prod\\checksums.sha256',
      ]);
      elementFromPoint.mockReturnValue(null);
      await fireEvent.pointerDown(row, { button: 2, clientX: 10, clientY: 10 });
      await fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
      expect(panelDrag.active).toBe(false);
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });
});

describe('Tabs im Hauptfenster', () => {
  it('öffnet, wechselt und schließt Tabs per Maus und Tastatur', async () => {
    const { vm, connectionActions } = mainWindow();
    await vm.loadProfiles();
    const bar = () => screen.getByRole('tablist', { name: 'Geöffnete Buckets' });
    expect(within(bar()).queryAllByRole('tab')).toHaveLength(0);
    expect(within(bar()).getByRole('button', { name: 'Neuer Tab (Strg+T)' })).toBeDisabled();

    vm.openBucket('aws-prod', 'prod-backups-eu');
    await settle();
    connectionActions.openForNode(bucketNodeId('aws-prod', 'prod-logs-eu'), 5, 5);
    await settle();
    await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /In neuem Tab öffnen/ }));
    await settle();
    const tabs = within(bar()).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['prod-backups-eu', 'prod-logs-eu']);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs[1]).getByRole('img', { name: 'Verbunden' })).toBeInTheDocument();

    await fireEvent.click(tabs[0]);
    expect(vm.location?.bucket).toBe('prod-backups-eu');
    await fireEvent.keyDown(within(bar()).getAllByRole('tab')[1], { key: 'Enter' });
    expect(vm.location?.bucket).toBe('prod-logs-eu');
    await fireEvent.keyDown(within(bar()).getAllByRole('tab')[1], { key: 'a' });
    await fireEvent.click(within(bar()).getByRole('button', { name: 'Neuer Tab (Strg+T)' }));
    await fireEvent.keyDown(within(bar()).getAllByRole('tab')[2], { key: 'Delete' });
    expect(within(bar()).getAllByRole('tab')).toHaveLength(2);

    await fireEvent.click(within(bar()).getByRole('button', { name: 'Neuer Tab (Strg+T)' }));
    expect(within(bar()).getAllByRole('tab')).toHaveLength(3);
    await fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    expect(within(bar()).getAllByRole('tab')).toHaveLength(2);
    await fireEvent(within(bar()).getAllByRole('tab')[1], new MouseEvent('auxclick', { button: 2, bubbles: true }));
    expect(within(bar()).getAllByRole('tab')).toHaveLength(2);
    await fireEvent(within(bar()).getAllByRole('tab')[1], new MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(within(bar()).getAllByRole('tab')).toHaveLength(1);
    await fireEvent.click(within(bar()).getByRole('button', { name: 'Tab prod-backups-eu schließen' }));
    expect(within(bar()).queryAllByRole('tab')).toHaveLength(0);
    expect(vm.location).toBeNull();
  });
});
