<script lang="ts">
  // Hauptfenster (Screen 2, 6a, 6b, 6c). Layout nach Main.dc.html mit nativer Titelleiste.
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Plus from '@lucide/svelte/icons/plus';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Rows3 from '@lucide/svelte/icons/rows-3';
  import Rows4 from '@lucide/svelte/icons/rows-4';
  import Database from '@lucide/svelte/icons/database';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Copy from '@lucide/svelte/icons/copy';
  import Loader from '@lucide/svelte/icons/loader';
  import ConnectionTree from './ConnectionTree.svelte';
  import ObjectTable from '../objects/ObjectTable.svelte';
  import TransferPanel from '../transfers/TransferPanel.svelte';
  import { onMount, untrack } from 'svelte';
  import type { DropPoint, FileDropViewModel } from './fileDropViewModel.svelte';
  import Upload from '@lucide/svelte/icons/upload';
  import Download from '@lucide/svelte/icons/download';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import type { TransfersViewModel } from '../transfers/transfersViewModel.svelte';
  import type { DeleteViewModel } from '../deletion/deleteViewModel.svelte';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import type { NameDialogViewModel } from '../naming/nameDialogViewModel.svelte';
  import type { ClipboardViewModel } from '../clipboard/clipboardViewModel.svelte';
  import type { ObjectActionsViewModel } from './objectActionsViewModel.svelte';
  import type { ConnectionActionsViewModel } from '../connections/connectionActionsViewModel.svelte';
  import type { DetailsViewModel } from '../details/detailsViewModel.svelte';
  import type { SettingsViewModel } from '../settings/settingsViewModel.svelte';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import DetailsPanel from '../details/DetailsPanel.svelte';
  import PanelRight from '@lucide/svelte/icons/panel-right';
  import List from '@lucide/svelte/icons/list';
  import Columns2 from '@lucide/svelte/icons/columns-2';
  import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
  import type { SyncViewModel } from '../sync/syncViewModel.svelte';
  import LocalPanel from '../local/LocalPanel.svelte';
  import type { LocalPanelViewModel } from '../local/localPanelViewModel.svelte';
  import DragGhost from '../../ui/drag/DragGhost.svelte';
  import type { PanelSide, SplitViewModel } from './splitViewModel.svelte';
  import type { PanelDragViewModel, PanelPoint } from './panelDragViewModel.svelte';
  import type { S3Entry } from '../objects/entry';
  import Search from '@lucide/svelte/icons/search';
  import ListFilter from '@lucide/svelte/icons/list-filter';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { FIND_KEY, type FilterGroup, type ObjectFilterViewModel } from '../objects/objectFilterViewModel.svelte';
  import ContextMenu from '../../ui/menu/ContextMenu.svelte';
  import type { BrowserViewModel } from './browserViewModel.svelte';
  import type { TabsViewModel } from './tabsViewModel.svelte';
  import TabBar from './TabBar.svelte';
  import type { ConnectionProfile } from '../../core/backend';
  import { errorDetail } from '../../core/backend';

  interface Props {
    vm: BrowserViewModel;
    onnewconnection: () => void;
    oneditconnection: (profile: ConnectionProfile) => void;
    transfers: TransfersViewModel;
    drop: FileDropViewModel;
    deletion: DeleteViewModel;
    naming: NameDialogViewModel;
    clipboard: ClipboardViewModel;
    actions: ObjectActionsViewModel;
    connectionActions: ConnectionActionsViewModel;
    details: DetailsViewModel;
    filter: ObjectFilterViewModel;
    settings: SettingsViewModel;
    tabs: TabsViewModel;
    local: LocalPanelViewModel;
    split: SplitViewModel;
    panelDrag: PanelDragViewModel;
    sync: SyncViewModel;
  }

  let {
    vm,
    onnewconnection,
    oneditconnection,
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
  }: Props = $props();

  function openSync() {
    const place = split.syncPlace;
    if (place) sync.open(place.folder, place.localDir);
  }

  let searchInput: HTMLInputElement | undefined = $state();

  // Der Suchtext gilt nur für den Ordner, in dem er eingegeben wurde.
  $effect(() => {
    void vm.location;
    untrack(() => filter.onNavigate());
  });

  /** Strg+F springt ins Suchfeld. */
  function focusSearch(e: KeyboardEvent): boolean {
    if (!e.ctrlKey || e.key.toLowerCase() !== FIND_KEY || !searchInput) return false;
    searchInput.focus();
    searchInput.select();
    return true;
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    filter.setText('');
  }

  function openFilterMenu(group: FilterGroup, e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    filter.openMenu(group, rect.left, rect.bottom + 2);
  }

  const FILTER_GROUPS: readonly FilterGroup[] = ['kind', 'size', 'date'];

  // Das Panel folgt der Auswahl, solange es offen ist.
  $effect(() => {
    if (details.isOpen) void details.show(vm.selectedEntries, vm.uploadTarget);
  });

  /** Bucket-Tabelle; die lokale Tabelle der Zwei-Panel-Ansicht ist kein Ziel für Bucket-Aktionen. */
  const BUCKET_TABLE = '[data-panel="bucket"] .s3-table';

  function rowIndexAt(element: Element | null): number | null {
    const row = element?.closest<HTMLElement>('[data-row-index]');
    return row ? Number(row.dataset.rowIndex) : null;
  }

  /** Übersetzt Fensterkoordinaten in Tabelle und Zeile unter dem Mauszeiger (Explorer-Drop). */
  function hitTest(x: number, y: number): DropPoint {
    const element = document.elementFromPoint(x, y);
    return { inTable: element?.closest(BUCKET_TABLE) != null, rowIndex: rowIndexAt(element) };
  }

  /** Seite und Zeile unter dem Mauszeiger beim Ziehen zwischen den Panels. */
  function panelHitTest(x: number, y: number): PanelPoint {
    const element = document.elementFromPoint(x, y);
    const panel = element?.closest<HTMLElement>('[data-panel]')?.dataset.panel;
    const side = panel === 'local' || panel === 'bucket' ? panel : null;
    return { side, rowIndex: side ? rowIndexAt(element) : null };
  }

  onMount(() => {
    drop.setHitTest(hitTest);
    panelDrag.setHitTest(panelHitTest);
  });

  /** Linke Maustaste auf einer Zeile der Zwei-Panel-Ansicht kann ein Ziehen beginnen. */
  function pressRow(side: PanelSide, e: PointerEvent, entry: S3Entry) {
    if (!split.active || e.button !== 0) return;
    panelDrag.press(side, entry, e.clientX, e.clientY, e.ctrlKey || e.shiftKey || e.metaKey);
  }

  function bucketRowClass(entry: S3Entry): string {
    return [drop.rowClass(entry), panelDrag.rowClass('bucket', entry)].filter(Boolean).join(' ');
  }

  const connection = $derived(vm.currentConnection);
  const shownError = $derived(vm.visibleError);

  function copy(text: string) {
    void navigator.clipboard?.writeText(text);
  }

  /** Rechtsklick in der Objekttabelle: Menü für die Zeile oder für den Ordner. */
  /** Hier bleibt das Menü von WebView2 (Ausschneiden, Kopieren, Einfügen) erhalten. */
  const EDITABLE = 'input, textarea, [contenteditable="true"]';

  /**
   * Eigenes Menü in der Objektliste; sonst wird das Browser-Menü von WebView2 (Teilen, Drucken,
   * Neu laden) unterdrückt, weil es in einer Desktop-App nichts zu suchen hat.
   */
  function onContextMenu(e: MouseEvent) {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(EDITABLE)) return;
    e.preventDefault();
    if (!target?.closest(BUCKET_TABLE)) return;
    const row = target.closest<HTMLElement>('[data-row-index]');
    if (row) actions.openForRow(Number(row.dataset.rowIndex), e.clientX, e.clientY);
    else actions.openForBackground(e.clientX, e.clientY);
  }

  /** Umschalt+F10 und Menütaste öffnen das Menü an der aktiven Zeile. */
  function openMenuFromKeyboard(e: KeyboardEvent, target: Element | null): boolean {
    const grid = target?.closest('.s3-table');
    if (!grid || !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return false;
    const anchor = (grid.querySelector('.s3-tr.is-active') ?? grid).getBoundingClientRect();
    actions.openAt(anchor.left + MENU_INSET, anchor.top + MENU_INSET);
    return true;
  }

  /** Abstand des Menüs zur linken oberen Ecke der Zeile beim Öffnen per Tastatur. */
  const MENU_INSET = 24;

  /** Auf der lokalen Seite gelten nur ihre eigenen Kürzel und die allgemeinen der Anwendung. */
  function localShortcuts(e: KeyboardEvent): (() => boolean)[] {
    const nothing = { uploadTarget: null, selectedObjects: () => null };
    return [
      () => settings.handleShortcut(e.key, e.ctrlKey),
      () => tabs.handleShortcut(e.key, e.ctrlKey, e.shiftKey),
      () => split.handleLocalShortcut(e.key, e.ctrlKey),
      () => transfers.handleShortcut(e.key, e.ctrlKey, nothing),
      () => local.handleShortcut(e.key, e.altKey),
    ];
  }

  /** Kürzel der Anwendung in der Reihenfolge, in der sie gefragt werden; true heißt behandelt. */
  function shortcuts(e: KeyboardEvent, target: Element | null): (() => boolean)[] {
    if (target?.closest('[data-panel="local"]')) return localShortcuts(e);
    const selection = () => vm.selectedObjects;
    return [
      () => focusSearch(e),
      () => settings.handleShortcut(e.key, e.ctrlKey),
      () => tabs.handleShortcut(e.key, e.ctrlKey, e.shiftKey),
      () => (target?.closest('input') ? false : openMenuFromKeyboard(e, target)),
      () => transfers.handleShortcut(e.key, e.ctrlKey, { uploadTarget: vm.uploadTarget, selectedObjects: selection }),
      () => clipboard.handleShortcut(e.key, e.ctrlKey, { selection, target: vm.uploadTarget }),
      () => deletion.handleShortcut(e.key, selection),
      () => naming.handleShortcut(e.key, selection),
      () => details.handleShortcut(e.key, e.altKey),
      () => vm.handleShortcut(e.key, e.altKey, target?.closest('[role="grid"]') != null),
    ];
  }

  function onWindowKey(e: KeyboardEvent) {
    if (panelDrag.active && e.key === 'Escape') {
      e.preventDefault();
      panelDrag.cancel();
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('textarea, select, [role="dialog"], [role="alertdialog"]')) return;
    // In Eingabefeldern gilt nur Strg+F; alle anderen Tasten gehören dem Feld.
    const active = target?.closest('input') ? shortcuts(e, target).slice(0, 1) : shortcuts(e, target);
    if (active.some((handle) => handle())) e.preventDefault();
  }
</script>

<svelte:window
  onkeydown={onWindowKey}
  oncontextmenu={onContextMenu}
  onpointermove={(e) => panelDrag.move(e.clientX, e.clientY)}
  onpointerup={() => panelDrag.release()}
/>

{#if filter.menu}
  <ContextMenu
    entries={filter.menu.entries}
    x={filter.menu.x}
    y={filter.menu.y}
    label="Filter"
    onselect={(id) => filter.choose(id)}
    onclose={() => filter.closeMenu()}
  />
{/if}

{#if actions.menu.state}
  <ContextMenu
    entries={actions.menu.state.entries}
    x={actions.menu.state.x}
    y={actions.menu.state.y}
    label="Aktionen für die Auswahl"
    onselect={(id) => actions.menu.run(id)}
    onclose={() => actions.menu.close()}
  />
{/if}

<div class="app" class:is-dragging={panelDrag.active}>
  <div class="app-body">
    <aside class="sidebar" aria-label="Verbindungen">
      <div class="s3-tree-group">Verbindungen</div>
      <div class="sidebar-tree">
        <ConnectionTree {vm} actions={connectionActions} />
        {#if vm.profilesError}
          <p class="sidebar-note error">{vm.profilesError.message}</p>
        {:else if vm.connections.length === 0}
          <p class="sidebar-note">Noch keine Verbindung angelegt.</p>
        {/if}
      </div>
      <div class="sidebar-foot">
        <button class="s3-btn s3-btn-secondary s3-btn-sm sidebar-new" onclick={onnewconnection}>
          <Plus class="s3-ico" />Neue Verbindung
        </button>
        <button
          class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
          aria-label="Verbindung bearbeiten"
          title="Verbindung bearbeiten"
          disabled={!connection}
          onclick={() => connection && oneditconnection(connection.profile)}
        >
          <Pencil class="s3-ico" />
        </button>
        <button
          class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
          aria-label="Einstellungen (Strg+,)"
          title="Einstellungen (Strg+,)"
          onclick={() => settings.open()}
        >
          <SettingsIcon class="s3-ico" />
        </button>
      </div>
    </aside>

    <main class="app-main">
      <TabBar vm={tabs} />
      <div class="s3-actionbar" role="toolbar" aria-label="Aktionen">
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          aria-label="Zurück (Alt+←)"
          title="Zurück (Alt+←)"
          disabled={!vm.canGoBack}
          onclick={() => vm.goBack()}
        >
          <ArrowLeft class="s3-ico" />
        </button>
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          aria-label="Weiter (Alt+→)"
          title="Weiter (Alt+→)"
          disabled={!vm.canGoForward}
          onclick={() => vm.goForward()}
        >
          <ArrowRight class="s3-ico" />
        </button>
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          aria-label="Eine Ebene hoch (Alt+↑)"
          title="Eine Ebene hoch (Alt+↑)"
          disabled={!vm.canGoUp}
          onclick={() => vm.goUp()}
        >
          <ArrowUp class="s3-ico" />
        </button>
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          aria-label="Aktualisieren (F5)"
          title="Aktualisieren (F5)"
          disabled={!vm.location}
          onclick={() => vm.refresh()}
        >
          <RefreshCw class="s3-ico" />
        </button>
        <span class="s3-tsep"></span>
        <button
          class="s3-btn s3-btn-primary"
          title="Dateien in den offenen Ordner hochladen (Strg+U)"
          disabled={!vm.uploadTarget}
          onclick={() => actions.upload()}
        >
          <Upload class="s3-ico" />Hochladen<span class="s3-kbd">Strg+U</span>
        </button>
        <button
          class="s3-btn s3-btn-ghost"
          title="Auswahl in einen lokalen Ordner herunterladen (Strg+D)"
          disabled={!vm.hasSelection}
          onclick={() => actions.download()}
        >
          <Download class="s3-ico" />Herunterladen
        </button>
        <button
          class="s3-btn s3-btn-ghost"
          title="Neuen Ordner im offenen Ordner anlegen"
          disabled={!vm.uploadTarget}
          onclick={() => actions.newFolder()}
        >
          <FolderPlus class="s3-ico" />Neuer Ordner
        </button>
        <button
          class="s3-btn s3-btn-ghost"
          title="Auswahl löschen (Entf)"
          disabled={!vm.hasSelection}
          onclick={() => actions.remove()}
        >
          <Trash2 class="s3-ico" />Löschen
        </button>
        <span class="grow"></span>
        <span class="s3-muted toolbar-label">Ansicht</span>
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          class:is-pressed={!split.active}
          aria-pressed={!split.active}
          aria-label="Liste"
          title="Liste"
          onclick={() => split.toggle(false)}
        >
          <List class="s3-ico" />
        </button>
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          class:is-pressed={split.active}
          aria-pressed={split.active}
          aria-label="Zwei-Panel"
          title="Zwei-Panel: lokal und Bucket nebeneinander"
          onclick={() => split.toggle(true)}
        >
          <Columns2 class="s3-ico" />
        </button>
        <span class="s3-tsep"></span>
        <span class="s3-muted toolbar-label">Dichte</span>
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          class:is-pressed={!vm.compact}
          aria-pressed={!vm.compact}
          aria-label="Standard, 28 px"
          title="Standard, 28 px"
          onclick={() => (vm.compact = false)}
        >
          <Rows3 class="s3-ico" />
        </button>
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          class:is-pressed={vm.compact}
          aria-pressed={vm.compact}
          aria-label="Kompakt, 24 px"
          title="Kompakt, 24 px"
          onclick={() => (vm.compact = true)}
        >
          <Rows4 class="s3-ico" />
        </button>
        <span class="s3-tsep"></span>
        <button
          class="s3-btn s3-btn-ghost s3-btn-icon"
          class:is-pressed={details.isOpen}
          aria-pressed={details.isOpen}
          aria-label="Eigenschaften (Alt+Enter)"
          title="Eigenschaften (Alt+Enter)"
          onclick={() => details.toggle()}
        >
          <PanelRight class="s3-ico" />
        </button>
      </div>

      {#if vm.location}
        <div class="s3-navrow">
          <nav class="s3-crumbs" aria-label="Pfad">
            <button
              class="s3-crumb s3-crumb-bucket"
              class:is-current={vm.crumbs.length === 0}
              onclick={() => vm.openPrefix('')}
            >
              <Database class="s3-ico" /><span>{vm.location.bucket}</span>
            </button>
            {#each vm.crumbs as crumb, i (crumb.prefix)}
              <svg class="s3-ico s3-crumb-sep" aria-hidden="true"><use href="#i-chevron-right" /></svg>
              <button
                class="s3-crumb"
                class:is-current={i === vm.crumbs.length - 1}
                onclick={() => vm.openPrefix(crumb.prefix)}
              >
                <span>{crumb.label}</span>
              </button>
            {/each}
            <span class="grow"></span>
            <button
              class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
              aria-label="Pfad kopieren"
              title="Pfad kopieren"
              onclick={() => vm.location && copy(`s3://${vm.location.bucket}/${vm.location.prefix}`)}
            >
              <Copy class="s3-ico" />
            </button>
          </nav>
          <label class="s3-input search">
            <Search class="s3-ico" />
            <input
              bind:this={searchInput}
              type="search"
              value={filter.filter.text}
              placeholder="Filtern in {vm.location.prefix || vm.location.bucket}"
              aria-label="Objekte filtern"
              oninput={(e) => filter.setText(e.currentTarget.value)}
              onkeydown={onSearchKey}
            />
            <span class="s3-kbd">Strg+F</span>
          </label>
          {#each FILTER_GROUPS as group (group)}
            <button
              class="s3-btn s3-btn-secondary"
              class:is-pressed={filter.filter[group] !== 'all'}
              aria-haspopup="menu"
              aria-expanded={filter.menu?.group === group}
              onclick={(e) => openFilterMenu(group, e)}
            >
              {#if group === 'kind'}<ListFilter class="s3-ico" />{/if}{filter.buttonLabel(group)}<ChevronDown
                class="s3-ico"
              />
            </button>
          {/each}
        </div>
      {/if}

      {#if shownError}
        <div class="s3-banner s3-banner-error banner" role="alert">
          <CircleX class="s3-ico banner-icon" />
          <div class="banner-text">
            <strong>{shownError.message}</strong>
            {#if errorDetail(shownError)}<span class="s3-mono banner-detail">{errorDetail(shownError)}</span>{/if}
          </div>
          {#if shownError.service?.requestId}
            <button
              class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
              aria-label="Request-ID kopieren"
              title="Request-ID kopieren"
              onclick={() => copy(shownError.service?.requestId ?? '')}
            >
              <Copy class="s3-ico" />
            </button>
          {/if}
          <button class="s3-btn s3-btn-secondary s3-btn-sm" onclick={() => vm.retry()}> Erneut versuchen </button>
          {#if connection}
            <button class="s3-btn s3-btn-secondary s3-btn-sm" onclick={() => oneditconnection(connection.profile)}
              >Profil bearbeiten</button
            >
          {/if}
        </div>
      {/if}

      {#if vm.listingState === 'loading'}
        <div class="s3-progress s3-progress-indeterminate listing-bar" role="progressbar" aria-label="Listing läuft">
          <i></i>
        </div>
      {/if}

      <div class="content-row">
        {#if split.active}
          <section class="split-local" data-panel="local" aria-label="Lokale Dateien">
            <LocalPanel
              vm={local}
              compact={vm.compact}
              rowClass={(entry) => panelDrag.rowClass('local', entry)}
              dropTarget={panelDrag.highlights('local')}
              onrowpointerdown={(e, entry) => pressRow('local', e, entry)}
            />
          </section>
          <div
            class="split-bar"
            role="toolbar"
            aria-label="Zwischen lokal und Bucket kopieren"
            aria-orientation="vertical"
          >
            <button
              class="s3-btn s3-btn-secondary s3-btn-icon"
              aria-label="In den Bucket kopieren"
              title="→ in den Bucket kopieren (Strg+U auf der lokalen Seite)"
              disabled={!split.canUpload}
              onclick={() => split.upload()}
            >
              <ArrowRight class="s3-ico" />
            </button>
            <button
              class="s3-btn s3-btn-secondary s3-btn-icon"
              aria-label="Lokal speichern"
              title="← lokal speichern"
              disabled={!split.canDownload}
              onclick={() => split.download()}
            >
              <ArrowLeft class="s3-ico" />
            </button>
            <span class="split-sep"></span>
            <button
              class="s3-btn s3-btn-ghost s3-btn-icon"
              aria-label="Abgleichen"
              title="Lokalen Ordner und Bucket-Ordner abgleichen"
              disabled={!split.syncPlace}
              onclick={openSync}
            >
              <ArrowLeftRight class="s3-ico" />
            </button>
          </div>
        {/if}
        <div class="table-area" data-panel="bucket">
          {#if !vm.location}
            <div class="s3-state">
              <div class="s3-state-icon"><Database class="s3-ico" /></div>
              <h2 class="s3-state-title">Bucket wählen</h2>
              <p>Links eine Verbindung aufklappen und einen Bucket öffnen.</p>
              {#if vm.connections.length === 0}
                <div class="s3-state-actions">
                  <button class="s3-btn s3-btn-secondary" onclick={onnewconnection}
                    ><Plus class="s3-ico" />Neue Verbindung</button
                  >
                </div>
              {/if}
            </div>
          {:else}
            <ObjectTable
              source={vm.source}
              selection={vm.selection}
              sort={vm.sort}
              compact={vm.compact}
              label={vm.tableLabel}
              onsort={(sort) => vm.changeSort(sort)}
              onopen={(entry) => vm.open(entry)}
              rowClass={bucketRowClass}
              dropTarget={drop.highlightsTable || panelDrag.highlights('bucket')}
              hiddenColumns={vm.hiddenColumns}
              onrowpointerdown={(e, entry) => pressRow('bucket', e, entry)}
            />
            {#if vm.hasNoMatches}
              <div class="s3-state empty-overlay">
                <div class="s3-state-icon"><Search class="s3-ico" /></div>
                <h2 class="s3-state-title">Keine Treffer</h2>
                <p>Kein Eintrag in {vm.location.bucket}/{vm.location.prefix} passt zum Filter.</p>
                <div class="s3-state-actions">
                  <button class="s3-btn s3-btn-secondary" onclick={() => filter.clear()}>Filter zurücksetzen</button>
                </div>
              </div>
            {/if}
            {#if vm.isEmptyFolder}
              <div class="s3-state empty-overlay">
                <div class="s3-state-icon"><FolderOpen class="s3-ico" /></div>
                <h2 class="s3-state-title">
                  {vm.crumbs.length === 0 ? 'Dieser Bucket ist leer' : 'Dieser Ordner ist leer'}
                </h2>
                <p>{vm.location.bucket}/{vm.location.prefix} enthält keine Objekte.</p>
              </div>
            {/if}
          {/if}
        </div>
        {#if details.isOpen}<DetailsPanel vm={details} />{/if}
      </div>
      <TransferPanel vm={transfers} />
    </main>
  </div>

  <footer class="s3-statusbar" role="status">
    {#if connection}
      <div class="s3-sb-item" class:is-error={connection.status === 'error'}>
        <span class="s3-dot {connection.status === 'error' ? 's3-dot-error' : 's3-dot-ok'}" aria-hidden="true"></span>
        <span>{connection.profile.name} · {connection.profile.region}</span>
      </div>
    {/if}
    {#if vm.listingState === 'loading' || vm.listingState === 'cancelled'}
      <div class="s3-sb-item listing-item">
        {#if vm.listingState === 'loading'}<Loader class="s3-ico" />{/if}
        <strong>{vm.listingText}</strong>
      </div>
      {#if vm.listingState === 'loading'}
        <button class="s3-sb-item is-button" onclick={() => vm.cancelListing()}>Listing abbrechen</button>
      {/if}
    {/if}
    {#if vm.location}
      <div class="s3-sb-item"><span>{vm.countText}</span></div>
      <div class="s3-sb-item"><strong>{vm.selectionText}</strong></div>
      <div class="s3-sb-item"><span>{vm.sortText}</span></div>
      {#if clipboard.statusText}
        <button class="s3-sb-item is-button" title="Gemerkte Auswahl vergessen" onclick={() => clipboard.clear()}>
          {clipboard.statusText} · Strg+V fügt ein
        </button>
      {/if}
    {/if}
    <div class="s3-sb-spacer"></div>
    {#if transfers.transfers.length > 0}
      <button
        class="s3-sb-item is-button is-right"
        class:is-error={transfers.counts.failed > 0}
        aria-label="Transfer-Panel umschalten (Strg+J)"
        onclick={() => transfers.toggle()}
      >
        <ArrowUpDown class="s3-ico" />
        <span>{transfers.summaryText || 'Transfers fertig'}</span>
        <span class="s3-progress" style:--value="{transfers.totals.percent}%"><i></i></span>
      </button>
    {/if}
    {#if connection}
      <div class="s3-sb-item is-right">
        <span>SigV4 · {connection.profile.addressing === 'virtual-hosted' ? 'Virtual-Hosted' : 'Path-Style'}</span>
      </div>
    {/if}
  </footer>
  {#if drop.active}
    <DragGhost x={drop.x} y={drop.y} title={drop.countText} detail={drop.targetText} />
  {/if}
  {#if panelDrag.active}
    <DragGhost x={panelDrag.x} y={panelDrag.y} title={panelDrag.countText} detail={panelDrag.targetText} />
  {/if}
</div>

<style>
  .sidebar {
    width: 240px;
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--bg-app);
    border-right: 1px solid var(--border-subtle);
    min-height: 0;
  }
  .sidebar-tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .sidebar-note {
    margin: var(--space-8) var(--space-12);
    font-size: var(--text-12);
    color: var(--fg-secondary);
  }
  .sidebar-note.error {
    color: var(--error-fg);
  }
  .sidebar-foot {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-8);
    border-top: 1px solid var(--border-subtle);
  }
  .sidebar-new {
    flex: 1;
  }
  .grow {
    flex: 1;
  }
  .toolbar-label {
    font-size: var(--text-12);
    margin-right: var(--space-4);
  }
  .s3-crumbs {
    flex: 1;
  }
  .banner {
    align-items: flex-start;
    padding: 10px var(--space-8) 10px var(--space-12);
    flex: none;
  }
  .banner :global(.banner-icon) {
    margin-top: 2px;
  }
  .banner-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .banner-text strong {
    font-weight: var(--weight-semibold);
  }
  .banner-detail {
    font-size: var(--text-12);
    line-height: var(--leading-16);
  }
  .listing-bar {
    height: 2px;
    border-radius: 0;
    flex: none;
  }
  .listing-item {
    color: var(--info-fg);
  }
  .listing-item strong {
    color: var(--fg-primary);
  }
  .empty-overlay {
    position: absolute;
    inset: 120px 0 auto 0;
    pointer-events: none;
  }
  /* Knöpfe im Leerzustand bleiben bedienbar, der Rest lässt Klicks zur Tabelle durch. */
  .empty-overlay .s3-state-actions {
    pointer-events: auto;
  }
  .app-main {
    position: relative;
  }
  .search {
    width: 280px;
    flex: none;
  }
  .content-row {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .table-area {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .split-local {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
  }
  /* Leiste zwischen den Seiten (UI-SPEC Screen 3: 44 px) */
  .split-bar {
    width: 44px;
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-8);
    background: var(--bg-app);
    border-left: 1px solid var(--border-subtle);
    border-right: 1px solid var(--border-subtle);
  }
  .split-sep {
    width: 20px;
    height: 1px;
    background: var(--border-subtle);
  }
  .app.is-dragging {
    user-select: none;
    cursor: copy;
  }
</style>
