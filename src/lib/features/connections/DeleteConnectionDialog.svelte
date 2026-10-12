<script lang="ts">
  // Rückfrage vor dem Löschen einer Verbindung (Ziel und Folgen benennen, DESIGN-SYSTEM.md).
  import ConfirmDialog from '../../ui/dialog/ConfirmDialog.svelte';
  import type { ConnectionActionsViewModel } from './connectionActionsViewModel.svelte';

  interface Props {
    vm: ConnectionActionsViewModel;
  }

  let { vm }: Props = $props();
</script>

{#if vm.pendingDelete}
  <ConfirmDialog
    title="Verbindung löschen?"
    message="„{vm.pendingDelete.name}“ wird mit den gespeicherten Zugangsdaten entfernt."
    note="Die Daten im Bucket bleiben unberührt. Die Verbindung lässt sich jederzeit neu anlegen."
    confirmLabel="Verbindung löschen"
    danger
    busy={vm.deleting}
    error={vm.deleteError?.message ?? null}
    onconfirm={() => vm.confirmDelete()}
    oncancel={() => vm.cancelDelete()}
  />
{/if}
