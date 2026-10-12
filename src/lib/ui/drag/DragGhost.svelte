<script lang="ts">
  // Schwebende Drag-Vorschau (Screen 3): was gezogen wird und wohin es kommt.
  interface Props {
    x: number;
    y: number;
    title: string;
    detail: string;
  }

  let { x, y, title, detail }: Props = $props();

  /** Abstand zum Mauszeiger, damit die Vorschau das Ziel nicht verdeckt. */
  const OFFSET_PX = 16;
</script>

<div class="s3-drag-ghost" aria-hidden="true" style:left="{x + OFFSET_PX}px" style:top="{y + OFFSET_PX}px">
  <strong class="title">{title}</strong>
  <span class="s3-muted">{detail}</span>
</div>

<style>
  .title {
    font-size: var(--text-13);
    line-height: var(--leading-20);
    font-weight: var(--weight-semibold);
  }
</style>
