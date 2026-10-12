<script lang="ts">
  // Linke Seite der Zwei-Panel-Ansicht (Screen 3): Pfadleiste „Dieser PC › D: › Backups“ und
  // dieselbe Tabelle wie im Bucket, ohne Storage Class und ETag.
  import Monitor from '@lucide/svelte/icons/monitor';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import ObjectTable from '../objects/ObjectTable.svelte';
  import type { S3Entry } from '../objects/entry';
  import { LOCAL_HIDDEN_COLUMNS, THIS_PC, type LocalPanelViewModel } from './localPanelViewModel.svelte';

  interface Props {
    vm: LocalPanelViewModel;
    compact?: boolean;
    rowClass?: (entry: S3Entry) => string;
    dropTarget?: boolean;
    onrowpointerdown?: (e: PointerEvent, entry: S3Entry) => void;
  }

  let { vm, compact = false, rowClass, dropTarget = false, onrowpointerdown }: Props = $props();

  const isEmpty = $derived(!vm.loading && !vm.error && vm.source.totalCount === 0 && vm.path !== null);
</script>

<div class="local">
  <div class="head">
    <span class="s3-tree-group side-label">Lokal</span>
    <nav class="s3-crumbs crumbs" aria-label="Lokaler Pfad">
      <button class="s3-crumb" class:is-current={vm.path === null} onclick={() => vm.open(null)}>
        <Monitor class="s3-ico" /><span>{THIS_PC}</span>
      </button>
      {#each vm.crumbs as crumb, i (crumb.path)}
        <svg class="s3-ico s3-crumb-sep" aria-hidden="true"><use href="#i-chevron-right" /></svg>
        <button class="s3-crumb" class:is-current={i === vm.crumbs.length - 1} onclick={() => vm.open(crumb.path)}>
          <span>{crumb.label}</span>
        </button>
      {/each}
    </nav>
    <button
      class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
      aria-label="Lokal eine Ebene hoch"
      title="Eine Ebene hoch (Rücktaste)"
      disabled={!vm.canGoUp}
      onclick={() => vm.goUp()}
    >
      <ArrowUp class="s3-ico" />
    </button>
    <button
      class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
      aria-label="Lokal aktualisieren"
      title="Aktualisieren (F5)"
      onclick={() => vm.refresh()}
    >
      <RefreshCw class="s3-ico" />
    </button>
  </div>
  <div class="table">
    <ObjectTable
      source={vm.source}
      selection={vm.selection}
      sort={vm.sort}
      {compact}
      label={vm.tableLabel}
      onsort={(sort) => vm.changeSort(sort)}
      onopen={(entry) => vm.openEntry(entry)}
      hiddenColumns={LOCAL_HIDDEN_COLUMNS}
      {rowClass}
      {dropTarget}
      {onrowpointerdown}
    />
    {#if vm.error}
      <div class="s3-state overlay" role="alert">
        <div class="s3-state-icon"><CircleAlert class="s3-ico" /></div>
        <h2 class="s3-state-title">Ordner nicht lesbar</h2>
        <p>{vm.error.message}</p>
      </div>
    {:else if isEmpty}
      <div class="s3-state overlay">
        <div class="s3-state-icon"><FolderOpen class="s3-ico" /></div>
        <h2 class="s3-state-title">Dieser Ordner ist leer</h2>
      </div>
    {/if}
  </div>
</div>

<style>
  .local {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    height: 36px;
    padding: 0 var(--space-8);
    background: var(--bg-app);
    border-bottom: 1px solid var(--border-subtle);
    flex: none;
  }
  .side-label {
    padding: 0;
    margin-right: var(--space-4);
  }
  .crumbs {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .table {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .overlay {
    position: absolute;
    inset: 28px 0 0;
    background: var(--bg-panel);
  }
</style>
