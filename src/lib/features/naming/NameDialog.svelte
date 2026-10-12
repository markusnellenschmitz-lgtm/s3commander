<script lang="ts">
  // Namensdialog für „Neuer Ordner“ und „Umbenennen“. Enter bestätigt, Esc schließt.
  import Loader from '@lucide/svelte/icons/loader';
  import { focusTrap } from '../../ui/actions/focusTrap';
  import type { NameDialogViewModel } from './nameDialogViewModel.svelte';

  interface Props {
    vm: NameDialogViewModel;
  }

  let { vm }: Props = $props();

  /** Beim Umbenennen ist der Name ohne Dateiendung markiert, wie im Explorer. */
  function selectName(input: HTMLInputElement) {
    const dot = vm.item && !vm.item.isFolder ? input.value.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }

  function onsubmit(e: SubmitEvent) {
    e.preventDefault();
    void vm.submit();
  }
</script>

{#if vm.isOpen}
  <div class="s3-scrim">
    <div
      class="s3-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="name-title"
      use:focusTrap={{ onescape: () => vm.close() }}
    >
      <form {onsubmit}>
        <div class="s3-dialog-body">
          <h2 id="name-title" class="s3-dialog-title">{vm.title}</h2>
          <div class="s3-field">
            <label class="s3-field-label" for="name-input">Name <span class="s3-muted">{vm.locationText}</span></label>
            <span class="s3-input" class:is-invalid={vm.fieldError}>
              <input
                id="name-input"
                data-autofocus
                autocomplete="off"
                spellcheck="false"
                value={vm.name}
                disabled={vm.phase !== 'editing'}
                aria-invalid={vm.fieldError !== null}
                aria-describedby="name-error"
                oninput={(e) => vm.input(e.currentTarget.value)}
                onfocus={(e) => selectName(e.currentTarget)}
              />
            </span>
            <span id="name-error" class="s3-field-error" role="alert">{vm.fieldError ?? ''}</span>
          </div>
          {#if vm.phase === 'working'}
            <p class="s3-muted busy">
              <Loader class="s3-ico" />{vm.mode === 'rename' && vm.progress ? vm.progressText : 'Bitte warten …'}
            </p>
          {:else if vm.warning}
            <p class="warning" role="status">{vm.warning}</p>
          {/if}
        </div>
        <div class="s3-dialog-foot">
          {#if vm.phase === 'warning'}
            <button type="button" class="s3-btn s3-btn-secondary" onclick={() => vm.close()}>Schließen</button>
          {:else}
            <button
              type="button"
              class="s3-btn s3-btn-ghost"
              disabled={vm.phase === 'working'}
              onclick={() => vm.close()}>Abbrechen</button
            >
            <button type="submit" class="s3-btn s3-btn-primary" disabled={!vm.canSubmit && vm.touched}
              >{vm.submitLabel}</button
            >
          {/if}
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .busy {
    display: flex;
    align-items: center;
    gap: var(--space-8);
  }
  .warning {
    color: var(--warning-fg);
  }
  .s3-field-error:empty {
    display: none;
  }
</style>
