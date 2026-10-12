<script lang="ts">
  // Verbindungsbaum der Seitenleiste (Screen 2). Ein Tab-Stopp, Cursor über aria-activedescendant.
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import {
    bucketNodeId,
    connectionNodeId,
    type BrowserViewModel,
    type ConnectionStatus,
  } from './browserViewModel.svelte';
  import { isSelfHosted } from '../../core/backend';
  import ContextMenu from '../../ui/menu/ContextMenu.svelte';
  import type { ConnectionActionsViewModel } from '../connections/connectionActionsViewModel.svelte';
  import { CONNECTION_DOT } from './connectionStatus';

  interface Props {
    vm: BrowserViewModel;
    actions: ConnectionActionsViewModel;
  }

  let { vm, actions }: Props = $props();

  /** Abstand des Menüs zur linken oberen Ecke des Knotens beim Öffnen per Tastatur. */
  const MENU_INSET = 24;

  function onContextMenu(e: MouseEvent) {
    const node = (e.target as Element).closest<HTMLElement>('[data-node-id]');
    if (!node?.dataset.nodeId) return;
    e.preventDefault();
    actions.openForNode(node.dataset.nodeId, e.clientX, e.clientY);
  }

  function openMenuFromKeyboard(tree: HTMLElement): void {
    const id = vm.activeTreeId;
    if (!id) return;
    const node = tree.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`) ?? tree;
    const rect = node.getBoundingClientRect();
    actions.openForNode(id, rect.left + MENU_INSET, rect.top + MENU_INSET);
  }

  const META: Record<ConnectionStatus, (region: string) => string> = {
    connected: (region) => region,
    connecting: () => 'verbindet …',
    error: () => 'Fehler',
    disconnected: () => 'getrennt',
  };

  const nodeId = (id: string) => `tree-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      openMenuFromKeyboard(e.currentTarget as HTMLElement);
    } else if (vm.treeKeyDown(e.key)) {
      e.preventDefault();
    }
  }
</script>

<div
  class="s3-tree"
  role="tree"
  tabindex="0"
  aria-label="Verbindungen und Buckets"
  aria-activedescendant={vm.activeTreeId ? nodeId(vm.activeTreeId) : undefined}
  onkeydown={onKeyDown}
  oncontextmenu={onContextMenu}
>
  {#each vm.connections as connection (connection.profile.id)}
    {@const id = connectionNodeId(connection.profile.id)}
    {@const dot = CONNECTION_DOT[connection.status]}
    <!-- Knoten sind über aria-activedescendant erreichbar, nicht über tabindex. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
    <div
      id={nodeId(id)}
      data-node-id={id}
      class="s3-node"
      class:is-open={connection.expanded}
      class:is-error={connection.status === 'error'}
      class:is-off={connection.status === 'disconnected'}
      class:is-active={vm.activeTreeId === id}
      role="treeitem"
      aria-selected="false"
      aria-expanded={connection.expanded}
      title={connection.error?.message}
      onclick={() => vm.activateTreeNode(id)}
    >
      <span class="s3-twisty"><SpriteIcon name="chevron-right" /></span>
      <SpriteIcon name={isSelfHosted(connection.profile.provider) ? 'server' : 'cloud'} />
      <span class="s3-label">{connection.profile.name}</span>
      <span class="s3-node-meta">{META[connection.status](connection.profile.region)}</span>
      <span class="s3-dot {dot.cls}" role="img" aria-label={dot.label}></span>
    </div>
    {#if connection.expanded}
      {#each connection.buckets as bucket (bucket.name)}
        {@const bid = bucketNodeId(connection.profile.id, bucket.name)}
        {@const selected = vm.isActiveBucket(connection.profile.id, bucket.name)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
        <div
          id={nodeId(bid)}
          data-node-id={bid}
          class="s3-node"
          class:is-selected={selected}
          class:is-active={vm.activeTreeId === bid}
          style="--lvl: 1"
          role="treeitem"
          aria-selected={selected}
          onclick={() => vm.activateTreeNode(bid)}
        >
          <span class="s3-twisty is-leaf"></span>
          <SpriteIcon name="database" />
          <span class="s3-label">{bucket.name}</span>
        </div>
      {/each}
    {/if}
  {/each}
</div>

{#if actions.menu.state}
  <ContextMenu
    entries={actions.menu.state.entries}
    x={actions.menu.state.x}
    y={actions.menu.state.y}
    label="Aktionen für die Verbindung"
    onselect={(id) => actions.menu.run(id)}
    onclose={() => actions.menu.close()}
  />
{/if}
