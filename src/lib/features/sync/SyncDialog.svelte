<script lang="ts">
  // Abgleich lokal ↔ Bucket: Richtung wählen, Vorschau prüfen, starten.
  import Loader from '@lucide/svelte/icons/loader';
  import X from '@lucide/svelte/icons/x';
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import { focusTrap } from '../../ui/actions/focusTrap';
  import { countText, formatBytes } from '../../core/format';
  import type { SyncDirection } from '../../core/backend';
  import { SYNC_REASON_LABELS, type SyncViewModel } from './syncViewModel.svelte';

  interface Props {
    vm: SyncViewModel;
  }

  let { vm }: Props = $props();

  const remote = $derived(vm.place ? `${vm.place.folder.bucket}/${vm.place.folder.prefix}` : '');
  const local = $derived(vm.place?.localDir ?? '');

  const DIRECTIONS: readonly { id: SyncDirection; label: (local: string, remote: string) => string }[] = [
    { id: 'upload', label: (l, r) => `Lokal → Bucket: ${l} nach ${r}` },
    { id: 'download', label: (l, r) => `Bucket → Lokal: ${r} nach ${l}` },
  ];
</script>

{#if vm.isOpen}
  <div class="s3-scrim">
    <div
      class="s3-dialog sync"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-title"
      use:focusTrap={{ onescape: () => vm.close() }}
    >
      <div class="head">
        <h2 id="sync-title" class="s3-dialog-title grow">Abgleichen</h2>
        <button class="s3-btn s3-btn-ghost s3-btn-icon" aria-label="Dialog schließen" onclick={() => vm.close()}>
          <X class="s3-ico" />
        </button>
      </div>
      <div class="s3-dialog-body body">
        <fieldset class="options">
          <legend class="s3-sr">Richtung</legend>
          {#each DIRECTIONS as direction (direction.id)}
            <label class="s3-radio">
              <input
                type="radio"
                name="sync-direction"
                checked={vm.direction === direction.id}
                onchange={() => vm.setDirection(direction.id)}
              />
              <span class="s3-radio-dot"></span><span class="s3-ellipsis">{direction.label(local, remote)}</span>
            </label>
          {/each}
        </fieldset>
        <p class="s3-muted note">
          Übertragen wird, was im Ziel fehlt, eine andere Größe hat oder in der Quelle neuer ist.
        </p>

        {#if vm.error}<p class="s3-field-error" role="alert">{vm.error.message}</p>{/if}
        {#if vm.comparing}
          <p class="status"><Loader class="s3-ico" />Vergleiche …</p>
        {:else if vm.preview}
          <p class="status"><strong>{vm.summaryText}</strong></p>
          {#if vm.preview.items.length > 0}
            <ul class="items" aria-label="Zu übertragen">
              {#each vm.preview.items as item (item.relative)}
                <li>
                  <SpriteIcon name="file" />
                  <span class="s3-ellipsis grow s3-mono">{item.relative}</span>
                  <span class="s3-badge">{SYNC_REASON_LABELS[item.reason]}</span>
                  <span class="s3-num size">{formatBytes(item.size)}</span>
                </li>
              {/each}
            </ul>
            {#if vm.hiddenCount > 0}
              <p class="s3-muted note">und {countText(vm.hiddenCount, 'weitere Datei', 'weitere Dateien')}</p>
            {/if}
          {/if}
          {#if vm.preview.remoteExtras.length > 0}
            <label class="s3-check extras">
              <input
                type="checkbox"
                checked={vm.deleteRemoteExtras}
                onchange={(e) => (vm.deleteRemoteExtras = e.currentTarget.checked)}
              />
              <span class="s3-check-box"><SpriteIcon name="check" /></span>
              Danach im Bucket löschen, was lokal fehlt ({countText(
                vm.preview.remoteExtras.length,
                'Objekt',
                'Objekte',
              )}, mit Rückfrage)
            </label>
          {/if}
          {#if vm.preview.localExtras > 0}
            <p class="s3-muted note">
              {countText(vm.preview.localExtras, 'Datei liegt', 'Dateien liegen')} nur lokal und
              {vm.preview.localExtras === 1 ? 'bleibt' : 'bleiben'} unverändert.
            </p>
          {/if}
        {/if}
      </div>
      <div class="s3-dialog-foot">
        <button class="s3-btn s3-btn-ghost" disabled={vm.comparing} onclick={() => vm.compare()}>Neu vergleichen</button
        >
        <span class="grow"></span>
        <button class="s3-btn s3-btn-secondary" disabled={vm.starting} onclick={() => vm.close()}>Abbrechen</button>
        <button class="s3-btn s3-btn-primary" disabled={!vm.canStart} onclick={() => vm.start()}>Abgleichen</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sync {
    width: 640px;
    max-width: calc(100vw - 48px);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-16) var(--space-12) 0 var(--space-24);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin: 0;
    padding: 0;
    border: 0;
    font-size: var(--text-13);
    min-width: 0;
  }
  .note {
    margin: 0;
    font-size: var(--text-12);
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    margin: var(--space-4) 0 0;
    font-size: var(--text-13);
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 260px;
    overflow: auto;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    font-size: var(--text-12);
  }
  .items li {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    height: var(--row-height);
    padding: 0 var(--space-8);
  }
  .size {
    width: 80px;
    text-align: right;
    color: var(--fg-secondary);
  }
  .extras {
    font-size: var(--text-13);
  }
</style>
