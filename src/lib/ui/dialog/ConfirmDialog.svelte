<script lang="ts">
  // Rückfrage vor einer Aktion. Rein darstellend; der Fokus startet auf „Abbrechen“,
  // damit Enter nie versehentlich bestätigt. Esc bricht ab.
  import { focusTrap } from '../actions/focusTrap';

  interface Props {
    title: string;
    message: string;
    /** Zusätzlicher Hinweis in gedämpfter Schrift. */
    note?: string;
    confirmLabel: string;
    /** Destruktive Aktion: Bestätigen in Rot. */
    danger?: boolean;
    busy?: boolean;
    error?: string | null;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    title,
    message,
    note,
    confirmLabel,
    danger = false,
    busy = false,
    error = null,
    onconfirm,
    oncancel,
  }: Props = $props();
</script>

<div class="s3-scrim">
  <div
    class="s3-dialog"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    aria-describedby="confirm-text"
    use:focusTrap={{ onescape: oncancel }}
  >
    <div class="s3-dialog-body">
      <h2 id="confirm-title" class="s3-dialog-title">{title}</h2>
      <p id="confirm-text">{message}</p>
      {#if note}<p class="s3-muted">{note}</p>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <div class="s3-dialog-foot">
      <button type="button" class="s3-btn s3-btn-ghost" data-autofocus disabled={busy} onclick={oncancel}
        >Abbrechen</button
      >
      <button
        type="button"
        class="s3-btn"
        class:s3-btn-danger={danger}
        class:s3-btn-primary={!danger}
        disabled={busy}
        onclick={onconfirm}>{confirmLabel}</button
      >
    </div>
  </div>
</div>

<style>
  .error {
    color: var(--error-fg);
  }
</style>
