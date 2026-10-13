<script lang="ts">
  // Transfer-Queue (Screen 4): eingeklappte Leiste oder Panel mit Tabs, Summen und Zeilen.
  // Die Liste ist virtuell: gerendert werden nur die sichtbaren Zeilen, auch bei 100.000 Transfers.
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import { errorDetail } from '../../core/backend';
  import { formatBytes, formatCount, formatRest, formatSpeed } from '../../core/format';
  import { computeViewport, ROW_HEIGHT } from '../../core/table/viewport';
  import { decodeRowSlot } from './transferSummary';
  import { FINISHED_STATES, TRANSFER_FILTERS, type TransfersViewModel } from './transfersViewModel.svelte';
  import type { TransferDirection } from '../../core/backend';
  import {
    DIRECTION_ICONS,
    errorClipboardText,
    percent,
    progressClass,
    restSeconds,
    routeText,
    stateText,
  } from './transferText';

  interface Props {
    vm: TransfersViewModel;
  }

  let { vm }: Props = $props();

  const totals = $derived(vm.totals);
  const counts = $derived(vm.counts);
  const sumText = $derived(`${formatBytes(totals.doneBytes)} von ${formatBytes(totals.totalBytes)}`);
  const speedDirections = $derived(Object.keys(totals.speeds) as TransferDirection[]);
  const restText = $derived(Number.isFinite(totals.restSeconds) ? `noch ${formatRest(totals.restSeconds)}` : '');

  let scrollTop = $state(0);
  let listHeight = $state(0);
  const vp = $derived(
    computeViewport({
      scrollTop,
      clientHeight: listHeight,
      headerHeight: 0,
      rowHeight: ROW_HEIGHT,
      rowCount: vm.rows.length,
    }),
  );
  const windowRows = $derived(vm.rows.slice(vp.start, vp.end));

  function copy(text: string) {
    void navigator.clipboard?.writeText(text);
  }
</script>

{#snippet toggleButton(expanded: boolean)}
  <button class="s3-btn s3-btn-ghost s3-btn-sm" aria-expanded={expanded} onclick={() => vm.toggle()}>
    <SpriteIcon name={expanded ? 'chevron-down' : 'chevron-up'} />Transfers<span class="s3-kbd">Strg+J</span>
  </button>
{/snippet}

{#snippet totalBar(width: number)}
  <span class="s3-muted s3-num">{sumText}</span>
  <span
    class="s3-progress"
    role="progressbar"
    aria-label="Gesamtfortschritt"
    aria-valuenow={totals.percent}
    aria-valuemin="0"
    aria-valuemax="100"
    style:width="{width}px"
    style:--value="{totals.percent}%"><i></i></span
  >
  <span class="s3-num pct">{totals.percent} %</span>
  <span class="s3-tsep"></span>
  {#each speedDirections as direction (direction)}
    <span class="s3-num speed"
      ><SpriteIcon
        name={DIRECTION_ICONS[direction].icon}
        label={DIRECTION_ICONS[direction].label}
        class="s3-ico-sm"
      />{formatSpeed(totals.speeds[direction] ?? 0)}</span
    >
  {:else}
    <span class="s3-num">{formatSpeed(0)}</span>
  {/each}
  <span class="s3-muted s3-num">{restText}</span>
{/snippet}

{#if vm.error}
  <div class="s3-banner s3-banner-error" role="alert">
    <SpriteIcon name="circle-x" /><span>{vm.error.message}</span>
  </div>
{/if}

{#if !vm.expanded && vm.transfers.length > 0}
  <div class="s3-qbar" role="region" aria-label="Transfers">
    {@render toggleButton(false)}
    {#if counts.active}<span class="s3-badge s3-badge-info"><SpriteIcon name="arrow-up" />{counts.active} aktiv</span
      >{/if}
    {#if counts.waiting}<span class="s3-badge">{counts.waiting} wartend</span>{/if}
    {#if counts.failed}<span class="s3-badge s3-badge-error"><SpriteIcon name="circle-x" />{counts.failed} Fehler</span
      >{/if}
    <span class="s3-ellipsis s3-muted grow">
      {#if vm.current}{vm.current.name} · {stateText(vm.current, 0)}{/if}
    </span>
    {@render totalBar(160)}
  </div>
{:else if vm.expanded}
  <section class="panel" aria-label="Transfers">
    <div class="panel-head">
      {@render toggleButton(true)}
      <div class="s3-tabs s3-tabs-plain tabs" role="tablist" aria-label="Transferfilter">
        {#each TRANSFER_FILTERS as filter (filter.id)}
          <button
            class="s3-tab"
            class:is-active={vm.filter === filter.id}
            role="tab"
            aria-selected={vm.filter === filter.id}
            onclick={() => (vm.filter = filter.id)}
          >
            {filter.label}<span
              class="s3-badge"
              class:s3-badge-info={filter.id === 'active'}
              class:s3-badge-success={filter.id === 'done'}
              class:s3-badge-error={filter.id === 'failed'}>{formatCount(counts[filter.id])}</span
            >
          </button>
        {/each}
      </div>
      <span class="grow"></span>
      {@render totalBar(180)}
      <span class="s3-tsep"></span>
      <button class="s3-btn s3-btn-ghost s3-btn-sm" disabled={!vm.canPauseAll} onclick={vm.pauseAll}>
        <SpriteIcon name="pause" />Alle pausieren
      </button>
      <button class="s3-btn s3-btn-ghost s3-btn-sm" disabled={!vm.canResumeAll} onclick={vm.resumeAll}>
        <SpriteIcon name="play" />Fortsetzen
      </button>
      <button class="s3-btn s3-btn-ghost s3-btn-sm" disabled={!vm.canRemoveFinished} onclick={vm.removeFinished}>
        <SpriteIcon name="circle-check" />Fertige entfernen
      </button>
    </div>
    <div class="s3-xfer s3-xfer-head" role="row">
      <span></span><span role="columnheader">Objekt</span><span role="columnheader" class="s3-xfer-num">Größe</span>
      <span role="columnheader">Fortschritt</span><span role="columnheader">Status</span>
      <span role="columnheader" class="s3-xfer-num">Tempo</span><span role="columnheader" class="s3-xfer-num">Rest</span
      ><span></span>
    </div>
    <div
      class="s3-transfers list"
      role="grid"
      tabindex="0"
      aria-label="Transfer-Liste"
      bind:clientHeight={listHeight}
      onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
    >
      {#if vm.rows.length === 0}
        <p class="empty">Keine Transfers in dieser Ansicht.</p>
      {:else}
        <div class="spacer" style:height="{vp.spacerPx}px">
          <div class="window" style:transform="translateY({vp.offsetPx}px)">
            <!-- Ohne Schlüssel: DOM-Knoten werden weiterverwendet, nur Inhalte getauscht. -->
            <!-- eslint-disable-next-line svelte/require-each-key -->
            {#each windowRows as slot}
              {@const row = decodeRowSlot(slot)}
              {@const t = vm.visible[row.index]}
              {@const pct = percent(t)}
              {#if !row.errorLine}
                <!-- Zeilen sind über Mausklick wählbar; die Aktionen haben eigene Knöpfe. -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
                <div
                  class="s3-xfer is-{t.state === 'active' ? 'running' : t.state}"
                  class:is-selected={vm.selectedId === t.id}
                  role="row"
                  aria-selected={vm.selectedId === t.id}
                  onclick={() => (vm.selectedId = t.id)}
                >
                  <span class="s3-xfer-dir"
                    ><SpriteIcon
                      name={DIRECTION_ICONS[t.direction].icon}
                      label={DIRECTION_ICONS[t.direction].label}
                    /></span
                  >
                  <span class="s3-xfer-name s3-ellipsis name" title={t.localPath}
                    >{t.name} <span class="s3-muted">{routeText(t)}</span></span
                  >
                  <span class="s3-xfer-num">{formatBytes(t.totalBytes)}</span>
                  <span class="s3-xfer-bar">
                    <span
                      class="s3-progress {progressClass(t.state)}"
                      role="progressbar"
                      aria-label="Fortschritt {t.name}"
                      aria-valuenow={pct}
                      style:--value="{pct}%"><i></i></span
                    >
                    <span class="s3-pct">{pct} %</span>
                  </span>
                  <span class="s3-xfer-state">
                    {#if t.state === 'active'}<SpriteIcon name="loader" class="s3-ico-sm active-icon" />
                    {:else if t.state === 'paused'}<SpriteIcon name="pause" class="s3-ico-sm" />
                    {:else if t.state === 'done'}<SpriteIcon name="circle-check" class="s3-ico-sm" />
                    {:else if t.state === 'failed'}<SpriteIcon name="circle-x" class="s3-ico-sm" />{/if}
                    {stateText(t, vm.waitingPosition(t.id))}
                  </span>
                  <span class="s3-xfer-num">{t.state === 'active' ? formatSpeed(t.bytesPerSec) : '—'}</span>
                  <span class="s3-xfer-num">{t.state === 'active' ? formatRest(restSeconds(t)) : '—'}</span>
                  <span class="s3-xfer-actions">
                    {#if t.state === 'active' || t.state === 'waiting'}
                      <button
                        class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
                        aria-label="Pausieren"
                        onclick={() => vm.pause(t.id)}
                      >
                        <SpriteIcon name="pause" />
                      </button>
                    {/if}
                    {#if t.state === 'paused'}
                      <button
                        class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
                        aria-label="Fortsetzen"
                        onclick={() => vm.resume(t.id)}
                      >
                        <SpriteIcon name="play" />
                      </button>
                    {/if}
                    {#if !FINISHED_STATES.includes(t.state)}
                      <button
                        class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
                        class:is-pinned={t.state === 'failed'}
                        aria-label="Abbrechen"
                        onclick={() => vm.cancel(t.id)}
                      >
                        <SpriteIcon name="x" />
                      </button>
                    {/if}
                  </span>
                </div>
              {:else if t.error}
                <div class="s3-xfer-errline" role="row">
                  <span>
                    {#if t.error.service}<strong>{t.error.service.code}</strong> · {t.error.service.message}{:else}{t
                        .error.message}{/if}
                    {#if errorDetail(t.error)}<span class="s3-mono"> · {errorDetail(t.error)}</span>{/if}
                  </span>
                  <button
                    class="s3-btn s3-btn-ghost s3-btn-sm s3-btn-icon"
                    aria-label="Fehlerdetails kopieren"
                    onclick={() => t.error && copy(errorClipboardText(t.error))}
                  >
                    <SpriteIcon name="copy" />
                  </button>
                  <button class="s3-btn s3-btn-secondary s3-btn-sm" onclick={() => vm.retry(t.id)}>
                    <SpriteIcon name="rotate-cw" />Erneut versuchen
                  </button>
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </section>
{/if}

<style>
  .panel {
    height: 280px;
    flex: none;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-panel);
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    height: 36px;
    padding: 0 var(--space-8) 0 var(--space-4);
    background: var(--bg-app);
    border-bottom: 1px solid var(--border-subtle);
    flex: none;
    font-size: var(--text-12);
  }
  .tabs {
    border-bottom: 0;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .spacer {
    position: relative;
  }
  .window {
    position: absolute;
    inset: 0 0 auto;
  }
  .name {
    display: block;
  }
  .grow {
    flex: 1;
  }
  /* Summen, Tempo und Restzeit bleiben einzeilig; wird es eng, gibt der Gesamtbalken nach. */
  .s3-num {
    white-space: nowrap;
  }
  .speed {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .pct {
    width: 36px;
    text-align: right;
  }
  .empty {
    margin: var(--space-12) var(--space-16);
    color: var(--fg-secondary);
  }
  .panel :global(.active-icon) {
    color: var(--info-fg);
  }
</style>
