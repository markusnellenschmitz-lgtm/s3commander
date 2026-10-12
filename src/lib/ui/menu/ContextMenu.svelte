<script lang="ts" generics="Id extends string">
  // Kontextmenü an einer Fensterposition. Rein darstellend: Einträge und Aktionen kommen von außen.
  // Tastatur: ↑/↓, Pos1/Ende wandern über wählbare Einträge, Enter/Leertaste wählt, Esc/Tab schließt.
  // Ein Klick außerhalb, Scrollen oder Fensterwechsel schließen ebenfalls.
  import { onMount } from 'svelte';
  import SpriteIcon from '../icons/SpriteIcon.svelte';
  import type { SpriteIconName } from '../icons/sprite';
  import { isMenuItem, nextEnabledIndex, type MenuEntry } from '../../core/menu';

  interface Props {
    entries: MenuEntry<Id, SpriteIconName>[];
    x: number;
    y: number;
    label?: string;
    onselect: (id: Id) => void;
    onclose: () => void;
  }

  let { entries, x, y, label = 'Kontextmenü', onselect, onclose }: Props = $props();

  /** Abstand zum Fensterrand, wenn das Menü sonst hinausragen würde. */
  const EDGE = 4;

  let menu: HTMLDivElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);

  onMount(() => {
    const rect = menu?.getBoundingClientRect();
    left = Math.max(EDGE, Math.min(x, window.innerWidth - (rect?.width ?? 0) - EDGE));
    top = Math.max(EDGE, Math.min(y, window.innerHeight - (rect?.height ?? 0) - EDGE));
    focusIndex(nextEnabledIndex(entries, -1, 1));
  });

  function items(): HTMLButtonElement[] {
    return [...(menu?.querySelectorAll<HTMLButtonElement>('[data-index]') ?? [])];
  }

  function focusIndex(index: number) {
    items()
      .find((item) => Number(item.dataset.index) === index)
      ?.focus();
  }

  function currentIndex(): number {
    const active = document.activeElement as HTMLElement | null;
    return active?.dataset.index === undefined ? -1 : Number(active.dataset.index);
  }

  function onkeydown(e: KeyboardEvent) {
    const moves: Record<string, () => number> = {
      ArrowDown: () => nextEnabledIndex(entries, currentIndex(), 1),
      ArrowUp: () => nextEnabledIndex(entries, currentIndex(), -1),
      Home: () => nextEnabledIndex(entries, -1, 1),
      End: () => nextEnabledIndex(entries, -1, -1),
    };
    if (moves[e.key]) {
      e.preventDefault();
      focusIndex(moves[e.key]());
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      onclose();
    }
    // Enter und Leertaste lösen den fokussierten Button selbst aus.
    e.stopPropagation();
  }

  function onpointerdown(e: PointerEvent) {
    if (!menu?.contains(e.target as Node)) onclose();
  }

  function choose(id: Id, disabled: boolean | undefined) {
    if (!disabled) onselect(id);
  }
</script>

<svelte:window {onpointerdown} onblur={onclose} onresize={onclose} />
<svelte:document onscrollcapture={onclose} />

<div
  bind:this={menu}
  class="s3-menu context-menu"
  role="menu"
  aria-label={label}
  tabindex="-1"
  style:left="{left}px"
  style:top="{top}px"
  {onkeydown}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each entries as entry, index (index)}
    {#if isMenuItem(entry)}
      <button
        type="button"
        class="s3-menu-item"
        class:is-disabled={entry.disabled}
        class:is-danger={entry.danger}
        role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
        tabindex="-1"
        aria-checked={entry.checked}
        aria-disabled={entry.disabled ? 'true' : undefined}
        data-index={index}
        onclick={() => choose(entry.id, entry.disabled)}
      >
        {#if entry.checked !== undefined}
          <span class="s3-menu-check"
            >{#if entry.checked}<SpriteIcon name="check" />{/if}</span
          >
        {:else if entry.icon}
          <SpriteIcon name={entry.icon} />
        {/if}
        <span class="s3-label">{entry.label}</span>
        {#if entry.kbd}<span class="s3-kbd">{entry.kbd}</span>{/if}
      </button>
    {:else}
      <hr class="s3-sep" />
    {/if}
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    outline: none;
  }
</style>
