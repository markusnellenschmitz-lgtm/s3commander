<script lang="ts">
  // Kompositionswurzel: erzeugt Adapter und View-Models und verdrahtet sie.
  // Einzige Stelle, die lib/infrastructure kennt.
  import { onMount, untrack } from 'svelte';
  import IconSprite from './lib/ui/icons/IconSprite.svelte';
  import MainWindow from './lib/features/browser/MainWindow.svelte';
  import { TabsViewModel } from './lib/features/browser/tabsViewModel.svelte';
  import { LocalPanelViewModel } from './lib/features/local/localPanelViewModel.svelte';
  import { SplitViewModel } from './lib/features/browser/splitViewModel.svelte';
  import { PanelDragViewModel } from './lib/features/browser/panelDragViewModel.svelte';
  import { SyncViewModel } from './lib/features/sync/syncViewModel.svelte';
  import SyncDialog from './lib/features/sync/SyncDialog.svelte';
  import ConnectionDialog from './lib/features/connections/ConnectionDialog.svelte';
  import DeleteDialog from './lib/features/deletion/DeleteDialog.svelte';
  import NameDialog from './lib/features/naming/NameDialog.svelte';
  import { NameDialogViewModel } from './lib/features/naming/nameDialogViewModel.svelte';
  import ShareDialog from './lib/features/share/ShareDialog.svelte';
  import { ShareDialogViewModel } from './lib/features/share/shareDialogViewModel.svelte';
  import { ClipboardViewModel } from './lib/features/clipboard/clipboardViewModel.svelte';
  import { ObjectActionsViewModel } from './lib/features/browser/objectActionsViewModel.svelte';
  import { DetailsViewModel } from './lib/features/details/detailsViewModel.svelte';
  import { ObjectFilterViewModel } from './lib/features/objects/objectFilterViewModel.svelte';
  import { SettingsViewModel } from './lib/features/settings/settingsViewModel.svelte';
  import SettingsDialog from './lib/features/settings/SettingsDialog.svelte';
  import { ViewPreferences } from './lib/features/settings/viewPreferences.svelte';
  import { ConnectionActionsViewModel } from './lib/features/connections/connectionActionsViewModel.svelte';
  import DeleteConnectionDialog from './lib/features/connections/DeleteConnectionDialog.svelte';
  import { DeleteViewModel } from './lib/features/deletion/deleteViewModel.svelte';
  import { BrowserViewModel } from './lib/features/browser/browserViewModel.svelte';
  import { ConnectionDialogViewModel } from './lib/features/connections/connectionDialogViewModel.svelte';
  import { TransfersViewModel } from './lib/features/transfers/transfersViewModel.svelte';
  import { FileDropViewModel } from './lib/features/browser/fileDropViewModel.svelte';

  import { ThemeViewModel } from './lib/features/settings/themeViewModel.svelte';
  import type { BackendPort, FileDropPort, FilePickerPort, FolderLocation } from './lib/core/backend';
  import {
    createClipboardWriter,
    createDocumentThemeTarget,
    createLocalStorageStore,
    createMediaColorScheme,
  } from './lib/infrastructure/browser';
  import { createTauriBackend, isTauri } from './lib/infrastructure/tauriBackend';
  import { createFakeBackend } from './lib/infrastructure/fakeBackend';
  import { createFakeFilePicker, createTauriFilePicker } from './lib/infrastructure/filePickers';
  import { createNoFileDrop, createTauriFileDrop } from './lib/infrastructure/fileDrop';

  interface Props {
    /** Für Tests; sonst echte Adapter in Tauri, Fakes im Browser. */
    backend?: BackendPort;
    picker?: FilePickerPort;
    drops?: FileDropPort;
  }

  let { backend: injectedBackend, picker: injectedPicker, drops: injectedDrops }: Props = $props();
  // Adapter werden genau einmal beim Start gewählt und danach nicht mehr getauscht.
  // svelte-ignore state_referenced_locally
  const backend = injectedBackend ?? (isTauri() ? createTauriBackend() : createFakeBackend());
  // svelte-ignore state_referenced_locally
  const picker = injectedPicker ?? (isTauri() ? createTauriFilePicker() : createFakeFilePicker());
  // svelte-ignore state_referenced_locally
  const drops = injectedDrops ?? (isTauri() ? createTauriFileDrop() : createNoFileDrop());

  const theme = new ThemeViewModel(createLocalStorageStore(), createMediaColorScheme());
  const themeTarget = createDocumentThemeTarget();
  $effect(() => themeTarget.apply(theme.resolved));
  $effect(() => () => theme.dispose());

  const writeText = createClipboardWriter();
  const browser = new BrowserViewModel({ backend });
  const tabs = new TabsViewModel(browser);
  const dialog = new ConnectionDialogViewModel({
    backend,
    onSaved: (profile) => browser.upsertProfile(profile),
    onDeleteRequest: (profileId) => connectionActions.requestDelete(profileId),
  });
  const connectionActions = new ConnectionActionsViewModel({
    browser,
    edit: (profile) => dialog.openEdit(profile),
    writeText,
    openInNewTab: (profileId, bucket) => tabs.openInNewTab(profileId, bucket),
  });
  const local = new LocalPanelViewModel({ backend });
  const transfers = new TransfersViewModel({
    backend,
    picker,
    onFolderChanged: (folder) => refreshFolder(folder),
    onLocalChanged: (dir) => local.refreshIfShowing(dir),
  });
  const split = new SplitViewModel({ browser, local, transfers });
  const panelDrag = new PanelDragViewModel({ split, browser, local });
  const sync = new SyncViewModel({ backend, deleteExtras: (selection) => void deletion.open(selection) });

  function refreshFolder(folder: FolderLocation) {
    browser.refreshIfShowing(folder.profileId, folder.bucket, folder.prefix);
  }
  const deletion = new DeleteViewModel({ backend, onDeleted: refreshFolder });
  const naming = new NameDialogViewModel({ backend, onChanged: refreshFolder });
  const clipboard = new ClipboardViewModel({
    paste: (selection, target, move) => transfers.copy(selection, target, move),
  });
  const details = new DetailsViewModel({ backend, writeText, onChanged: refreshFolder });
  const share = new ShareDialogViewModel({ backend, writeText });
  const filter = new ObjectFilterViewModel({ source: browser.source, selection: browser.selection });
  const view = new ViewPreferences(createLocalStorageStore());
  browser.compact = view.value.compact;
  browser.hiddenColumns = view.value.hiddenColumns;
  const settings = new SettingsViewModel({
    backend,
    theme,
    view,
    onSaved: (saved) => {
      browser.compact = saved.compact;
      browser.hiddenColumns = saved.hiddenColumns;
    },
  });
  // Die Dichte-Knöpfe der Werkzeugleiste ändern browser.compact; der Wert bleibt gespeichert.
  $effect(() => {
    const compact = browser.compact;
    untrack(() => {
      if (view.value.compact !== compact) view.update({ compact });
    });
  });
  const actions = new ObjectActionsViewModel({
    browser,
    transfers,
    deletion,
    naming,
    clipboard,
    details,
    share,
    writeText,
  });

  const drop = new FileDropViewModel({
    drops,
    browser,
    upload: (target, paths) => transfers.uploadPaths(target, paths),
  });

  onMount(() => {
    void browser.loadProfiles({ autoConnect: view.value.autoConnect });
    void dialog.loadPresets();
    void transfers.start();
    void drop.start();
    return () => {
      transfers.dispose();
      drop.dispose();
    };
  });
</script>

<IconSprite />
<MainWindow
  vm={browser}
  {transfers}
  {drop}
  {deletion}
  {naming}
  {clipboard}
  {actions}
  {connectionActions}
  {details}
  {filter}
  {settings}
  {tabs}
  {local}
  {split}
  {panelDrag}
  {sync}
  onnewconnection={() => dialog.openCreate()}
  oneditconnection={(profile) => dialog.openEdit(profile)}
/>
<ConnectionDialog vm={dialog} />
<DeleteConnectionDialog vm={connectionActions} />
<SettingsDialog vm={settings} />
<SyncDialog vm={sync} />
<DeleteDialog vm={deletion} />
<NameDialog vm={naming} />
<ShareDialog vm={share} />
