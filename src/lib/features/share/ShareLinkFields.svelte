<script lang="ts">
  // Gültigkeit, Link und Kopieren für einen vorsignierten Link; optional mit „Teilen…“.
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import type { ShareLink } from './shareLink.svelte';
  import { SHARE_DURATIONS } from './shareRules';

  interface Props {
    link: ShareLink;
    /** Zeigt den Knopf „Teilen…“ neben „Kopieren“. */
    onshare?: () => void;
  }

  let { link, onshare }: Props = $props();
</script>

<div class="share">
  <div class="share-row">
    <span class="s3-muted share-label">Gültig für</span>
    <label class="s3-input s3-input-sm s3-select duration">
      <select
        aria-label="Gültigkeit des Links"
        value={link.secs}
        onchange={(e) => link.setDuration(Number(e.currentTarget.value))}
      >
        {#each SHARE_DURATIONS as duration (duration.secs)}
          <option value={duration.secs}>{duration.label}</option>
        {/each}
      </select>
    </label>
    <span class="s3-muted s3-num">{link.untilText}</span>
  </div>
  <label class="s3-input s3-input-sm">
    <SpriteIcon name="link" />
    <input class="s3-mono" readonly value={link.url ?? ''} aria-label="Presigned URL" />
    <button
      class="s3-btn s3-btn-ghost s3-btn-sm"
      aria-label="Presigned URL kopieren"
      disabled={!link.url}
      onclick={() => link.copy()}><SpriteIcon name="copy" />Kopieren</button
    >
  </label>
  {#if onshare}
    <div class="share-row">
      <button class="s3-btn s3-btn-secondary s3-btn-sm" disabled={!link.url} onclick={onshare}
        ><SpriteIcon name="share" />Teilen …</button
      >
    </div>
  {/if}
  {#if link.error}
    <p class="s3-field-error" role="alert">{link.error.message}</p>
  {/if}
</div>

<style>
  .share {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    font-size: var(--text-12);
  }
  .share-row {
    display: flex;
    align-items: center;
    gap: var(--space-8);
  }
  .share-label {
    width: 72px;
  }
  .duration {
    width: 120px;
  }
</style>
