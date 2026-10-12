<script lang="ts">
  // Bestätigungsdialog für das Löschen: nennt Ziel und Menge, zeigt Fortschritt und Ergebnis.
  // Der Fokus startet auf „Abbrechen“, damit Enter nie versehentlich löscht.
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Loader from '@lucide/svelte/icons/loader';
  import { errorDetail } from '../../core/backend';
  import { focusTrap } from '../../ui/actions/focusTrap';
  import type { DeleteViewModel } from './deleteViewModel.svelte';
  import { deleteSummary, deleteTitle, outcomeText, progressPercent, progressText, versionNote } from './deleteText';

  interface Props {
    vm: DeleteViewModel;
  }

  let { vm }: Props = $props();

  const note = $derived(vm.preview ? versionNote(vm.preview) : null);
  const percent = $derived(vm.progress ? progressPercent(vm.progress) : 0);
  const detail = $derived(vm.error ? errorDetail(vm.error) : null);
</script>

{#if vm.isOpen && vm.selection}
  <div class="s3-scrim">
    <div
      class="s3-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      aria-describedby="delete-text"
      use:focusTrap={{ onescape: () => vm.cancel() }}
    >
      <div class="s3-dialog-body">
        <h2 id="delete-title" class="s3-dialog-title">{deleteTitle(vm.selection)}</h2>
        <div id="delete-text" class="text">
          {#if vm.phase === 'preparing'}
            <p class="s3-muted busy"><Loader class="s3-ico" />Ermittle die betroffenen Objekte …</p>
          {:else if vm.phase === 'confirm' && vm.preview}
            <p>{deleteSummary(vm.preview, vm.selection)}</p>
            {#if note}<p class="s3-muted">{note}</p>{/if}
          {:else if vm.phase === 'deleting' && vm.progress}
            <span
              class="s3-progress"
              role="progressbar"
              aria-label="Löschfortschritt"
              aria-valuenow={percent}
              aria-valuemin="0"
              aria-valuemax="100"
              style:--value="{percent}%"><i></i></span
            >
            <p class="s3-muted">{progressText(vm.progress)}</p>
          {:else if vm.error}
            <p class="error">{vm.error.message}</p>
            {#if detail}<p class="s3-muted">{detail}</p>{/if}
          {:else if vm.outcome}
            <p>{outcomeText(vm.outcome)}</p>
            {#if vm.outcome.failures.length > 0}
              <ul class="failures" aria-label="Nicht gelöschte Objekte">
                {#each vm.outcome.failures as failure (failure.key)}
                  <li><span class="s3-mono">{failure.key}</span> · {failure.code}</li>
                {/each}
              </ul>
            {/if}
          {/if}
        </div>
      </div>
      <div class="s3-dialog-foot">
        {#if vm.phase === 'result'}
          <button class="s3-btn s3-btn-secondary" data-autofocus onclick={() => vm.cancel()}>Schließen</button>
        {:else}
          <button class="s3-btn s3-btn-ghost" data-autofocus onclick={() => vm.cancel()}>Abbrechen</button>
          {#if vm.phase !== 'deleting'}
            <button class="s3-btn s3-btn-danger" disabled={!vm.canConfirm} onclick={() => vm.confirm()}>
              <Trash2 class="s3-ico" />Löschen
            </button>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .text {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }
  .busy {
    display: flex;
    align-items: center;
    gap: var(--space-8);
  }
  .error {
    color: var(--error-fg);
  }
  .failures {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 160px;
    overflow: auto;
    font-size: var(--text-12);
    line-height: var(--leading-16);
  }
</style>
