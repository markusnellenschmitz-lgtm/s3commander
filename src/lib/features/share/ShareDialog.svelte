<script lang="ts">
  // Dialog „Teilen“: Gültigkeit wählen, dann öffnet „Teilen …“ den Teilen-Dialog von Windows.
  import { focusTrap } from '../../ui/actions/focusTrap';
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import ShareLinkFields from './ShareLinkFields.svelte';
  import type { ShareDialogViewModel } from './shareDialogViewModel.svelte';

  interface Props {
    vm: ShareDialogViewModel;
  }

  let { vm }: Props = $props();
</script>

{#if vm.isOpen}
  <div class="s3-scrim">
    <div
      class="s3-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-title"
      use:focusTrap={{ onescape: () => vm.close() }}
    >
      <div class="s3-dialog-body">
        <h2 id="share-title" class="s3-dialog-title">„{vm.name}“ teilen</h2>
        <ShareLinkFields link={vm.link} />
        <p class="s3-muted hint">
          Wer den Link erhält, kann die Datei bis zum Ablauf herunterladen, auch wenn er weitergeleitet wird. Vorher
          zurückziehen lässt er sich nur, indem die Zugangsdaten dieser Verbindung gewechselt werden.
        </p>
      </div>
      <div class="s3-dialog-foot">
        <button type="button" class="s3-btn s3-btn-ghost" onclick={() => vm.close()}>Schließen</button>
        <button
          type="button"
          class="s3-btn s3-btn-primary"
          data-autofocus
          disabled={!vm.link.url}
          onclick={() => vm.share()}><SpriteIcon name="share" />Teilen …</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .hint {
    margin: var(--space-12) 0 0;
    font-size: var(--text-12);
    line-height: 1.5;
  }
</style>
