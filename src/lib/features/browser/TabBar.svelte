<script lang="ts">
  // Tab-Leiste (UI-SPEC §1, Screen 2): ein Tab je geöffnetem Bucket mit Status-Punkt und
  // Schließen-x, dahinter „Neuer Tab“. Mittlere Maustaste oder Entf auf dem Tab schließt ihn.
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import { CONNECTION_DOT } from './connectionStatus';
  import type { TabsViewModel } from './tabsViewModel.svelte';

  interface Props {
    vm: TabsViewModel;
  }

  let { vm }: Props = $props();

  const MIDDLE_BUTTON = 1;

  function onTabKey(e: KeyboardEvent, id: number) {
    if (e.key === 'Delete') vm.close(id);
    else if (e.key === 'Enter' || e.key === ' ') vm.select(id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<div class="s3-tabs tabbar" role="tablist" aria-label="Geöffnete Buckets">
  {#each vm.tabs as tab (tab.id)}
    {@const dot = CONNECTION_DOT[tab.status]}
    <div
      class="s3-tab tab"
      class:is-active={tab.active}
      role="tab"
      tabindex={tab.active ? 0 : -1}
      aria-selected={tab.active}
      title={tab.title}
      onclick={() => vm.select(tab.id)}
      onkeydown={(e) => onTabKey(e, tab.id)}
      onauxclick={(e) => e.button === MIDDLE_BUTTON && vm.close(tab.id)}
    >
      <span class="s3-dot {dot.cls}" role="img" aria-label={dot.label}></span>
      <span class="s3-ellipsis">{tab.label}</span>
      <button
        class="s3-plain s3-tab-x"
        aria-label="Tab {tab.label} schließen"
        tabindex="-1"
        onclick={(e) => {
          e.stopPropagation();
          vm.close(tab.id);
        }}
      >
        <SpriteIcon name="x" />
      </button>
    </div>
  {/each}
  <button
    class="s3-btn s3-btn-ghost s3-btn-icon new"
    aria-label="Neuer Tab (Strg+T)"
    title="Neuer Tab (Strg+T)"
    disabled={!vm.canCreate}
    onclick={() => vm.newTab()}
  >
    <SpriteIcon name="plus" />
  </button>
</div>

<style>
  .tabbar {
    flex: none;
  }
  .tab {
    min-width: 0;
  }
  .new {
    align-self: center;
    margin-left: var(--space-4);
  }
</style>
