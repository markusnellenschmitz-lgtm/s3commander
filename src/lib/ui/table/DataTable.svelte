<script lang="ts" generics="T">
  // Virtuelle Datentabelle (UI-SPEC §4). Reine Ansicht:
  // Viewport-Mathe in core/table/viewport, Cursor und Auswahl im TableController,
  // Spaltenlogik in core/table/columns.
  import type { Snippet } from 'svelte';
  import type { Column, RowSource, SortState } from '../../core/table/types';
  import type { Selection } from '../../core/table/selection.svelte';
  import { TableController } from '../../core/table/tableController.svelte';
  import {
    computeViewport,
    HEADER_HEIGHT,
    ROW_HEIGHT,
    ROW_HEIGHT_COMPACT,
    scrollTopForRowHeightChange,
    scrollTopToReveal,
  } from '../../core/table/viewport';
  import {
    clampColumnWidth,
    gridTemplate,
    isResizable,
    visibleColumns,
    type WidthOverrides,
  } from '../../core/table/columns';
  import { nextSort } from '../../core/table/sort';
  import { dragResize } from '../actions/dragResize';
  import SpriteIcon from '../icons/SpriteIcon.svelte';

  interface Props {
    source: RowSource<T>;
    columns: Column<T>[];
    selection: Selection;
    sort?: SortState;
    compact?: boolean;
    label: string;
    onsort?: (sort: SortState) => void;
    onopen?: (row: T, index: number) => void;
    oncontextmenu?: (position: { x: number; y: number }, row: T, index: number) => void;
    rowClass?: (row: T) => string;
    /** Maustaste auf einer Zeile gedrückt, z. B. um sie in das andere Panel zu ziehen. */
    onrowpointerdown?: (e: PointerEvent, row: T) => void;
    /** Ganze Tabelle als Drop-Ziel hervorheben (Drag and Drop aus dem Explorer). */
    dropTarget?: boolean;
    empty?: Snippet;
  }

  let {
    source,
    columns,
    selection,
    sort,
    compact = false,
    label,
    onsort,
    onopen,
    oncontextmenu,
    rowClass,
    onrowpointerdown,
    dropTarget = false,
    empty,
  }: Props = $props();

  const uid = `dt${Math.random().toString(36).slice(2, 8)}`;
  const rowId = (index: number) => `${uid}-r${index}`;

  const controller = new TableController(
    () => source,
    () => selection,
  );

  let container: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let clientHeight = $state(0);
  let windowWidth = $state(window.innerWidth);
  let widthOverrides = $state<WidthOverrides>({});

  const rowHeight = $derived(compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT);
  const shownColumns = $derived(visibleColumns(columns, windowWidth));
  const cols = $derived(gridTemplate(shownColumns, widthOverrides));
  const rowCount = $derived.by(() => {
    void source.version;
    return source.length;
  });
  const vp = $derived(computeViewport({ scrollTop, clientHeight, headerHeight: HEADER_HEIGHT, rowHeight, rowCount }));

  // Sichtbare Zeilen; abhängig von source.version, damit Sortieren und Nachladen neu zeichnen.
  const visible = $derived.by(() => {
    void source.version;
    const out: { index: number; row: T | undefined }[] = [];
    for (let i = vp.start; i < vp.end; i++) out.push({ index: i, row: source.get(i) });
    return out;
  });

  const cursorIndex = $derived(controller.cursorIndex);
  const headState = $derived(controller.headState);
  const activeId = $derived(cursorIndex >= vp.start && cursorIndex < vp.end ? rowId(cursorIndex) : undefined);
  const pageSize = $derived(Math.max(1, Math.floor(vp.visibleRows) - 1));

  $effect(() => {
    if (vp.end > vp.start) source.ensureRange?.(vp.start, vp.end);
  });

  let previousRowHeight = ROW_HEIGHT;
  $effect(() => {
    const height = rowHeight;
    if (container && height !== previousRowHeight && !vp.scaled) {
      setScrollTop(scrollTopForRowHeightChange(scrollTop, previousRowHeight, height));
    }
    previousRowHeight = height;
  });

  function setScrollTop(value: number) {
    if (!container) return;
    container.scrollTop = value;
    scrollTop = container.scrollTop;
  }

  function reveal(index: number) {
    const top = scrollTopToReveal(vp, index, rowHeight);
    if (top !== null) setScrollTop(top);
  }

  function focusTable() {
    container?.focus({ preventScroll: true });
  }

  function modifiers(e: MouseEvent | KeyboardEvent) {
    return { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
  }

  function openRow(index: number) {
    const row = source.get(index);
    if (row !== undefined) onopen?.(row, index);
  }

  function showContextMenu(index: number, x: number, y: number) {
    const row = source.get(index);
    if (row !== undefined) oncontextmenu?.({ x, y }, row, index);
  }

  function onKeyDown(e: KeyboardEvent) {
    // Alt-Kombinationen sind Kürzel der Anwendung (Alt+Enter, Alt+↑), nicht der Tabelle.
    if (e.altKey) return;
    const result = controller.keyDown(e.key, modifiers(e), pageSize);
    if (!result.handled) return;
    e.preventDefault();
    if (result.reveal !== undefined) reveal(result.reveal);
    if (result.open !== undefined) openRow(result.open);
    if (result.contextMenu !== undefined) {
      const rect = document.getElementById(rowId(result.contextMenu))?.getBoundingClientRect();
      showContextMenu(result.contextMenu, rect ? rect.left + 40 : 0, rect ? rect.bottom : 0);
    }
  }

  function onRowClick(e: MouseEvent, index: number) {
    controller.click(index, modifiers(e));
    focusTable();
  }

  function onCheckClick(e: MouseEvent, index: number) {
    e.stopPropagation();
    controller.toggle(index);
    focusTable();
  }

  function onRowContextMenu(e: MouseEvent, index: number) {
    if (!oncontextmenu) return;
    e.preventDefault();
    controller.contextClick(index);
    showContextMenu(index, e.clientX, e.clientY);
  }

  function onHeaderClick(column: Column<T>) {
    if (column.sortable && onsort) onsort(nextSort(sort, column.id));
  }

  function resizeColumn(column: Column<T>, width: number) {
    widthOverrides = { ...widthOverrides, [column.id]: clampColumnWidth(column, width) };
  }
</script>

<svelte:window bind:innerWidth={windowWidth} />

<div
  bind:this={container}
  bind:clientHeight
  class="s3-table is-scroll"
  class:is-compact={compact}
  style:--cols={cols}
  role="grid"
  tabindex="0"
  aria-label={label}
  aria-multiselectable="true"
  aria-rowcount={rowCount + 1}
  aria-activedescendant={activeId}
  onscroll={() => (scrollTop = container?.scrollTop ?? 0)}
  onkeydown={onKeyDown}
>
  <div class="s3-thead" role="row" aria-rowindex="1">
    <div class="s3-th has-btn" role="columnheader" style="justify-content: center;">
      <button
        class="s3-chk"
        tabindex="-1"
        onclick={() => controller.toggleAll()}
        aria-label={headState === 'none' ? 'Alle auswählen' : 'Auswahl aufheben'}
      >
        <span class="s3-check-box" class:is-checked={headState === 'all'} class:is-mixed={headState === 'mixed'}>
          <SpriteIcon name="check" class="i-check" />
          <SpriteIcon name="minus" class="i-minus" />
        </span>
      </button>
    </div>
    {#each shownColumns as column (column.id)}
      {@const sorted = sort?.column === column.id}
      <div
        class="s3-th"
        class:has-btn={column.sortable}
        class:is-num={column.align === 'end'}
        class:is-sorted={sorted}
        role="columnheader"
        aria-sort={sorted ? (sort?.dir === 1 ? 'ascending' : 'descending') : column.sortable ? 'none' : undefined}
      >
        {#if column.sortable}
          <button class="s3-th-btn" tabindex="-1" onclick={() => onHeaderClick(column)}>
            {column.label}
            {#if sorted}<SpriteIcon name={sort?.dir === 1 ? 'chevron-up' : 'chevron-down'} class="s3-sort" />{/if}
          </button>
        {:else}
          {column.label}
        {/if}
        {#if isResizable(column)}
          <span class="s3-col-resize" use:dragResize={{ onresize: (w) => resizeColumn(column, w) }}></span>
        {/if}
      </div>
    {/each}
  </div>

  <div class="s3-tbody is-virtual" role="rowgroup" style:height="{vp.spacerPx}px">
    <div class="s3-rows" style:transform="translateY({vp.offsetPx}px)">
      <!-- Ohne Schlüssel: DOM-Knoten werden weiterverwendet, nur Inhalte getauscht.
           Bei großen Sprüngen ein Vielfaches schneller als Zeilen neu zu bauen. -->
      <!-- eslint-disable-next-line svelte/require-each-key -->
      {#each visible as { index, row }}
        {#if row === undefined}
          <div
            class="s3-tr is-loading"
            role="row"
            aria-busy="true"
            aria-rowindex={index + 2}
            style:--i={index - vp.start}
          >
            <div class="s3-td"></div>
            {#each shownColumns as column, ci (column.id)}
              <div class="s3-td" class:is-num={column.align === 'end'}>
                <span class="s3-skel" style:width={ci === 0 ? `${48 + ((index * 37) % 30)}%` : '64px'}></span>
              </div>
            {/each}
          </div>
        {:else}
          {@const selected = controller.isSelected(index)}
          <!-- Zeilen sind über aria-activedescendant erreichbar, nicht über tabindex. -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
          <div
            id={rowId(index)}
            data-row-index={index}
            class="s3-tr {rowClass?.(row) ?? ''}"
            class:is-selected={selected}
            class:is-active={index === cursorIndex}
            role="row"
            aria-selected={selected}
            aria-rowindex={index + 2}
            style:--i={index - vp.start}
            onclick={(e) => onRowClick(e, index)}
            ondblclick={() => openRow(index)}
            oncontextmenu={(e) => onRowContextMenu(e, index)}
            onpointerdown={(e) => onrowpointerdown?.(e, row)}
          >
            <div class="s3-td" role="gridcell">
              <button
                class="s3-chk"
                tabindex="-1"
                onclick={(e) => onCheckClick(e, index)}
                aria-label={selected ? 'Abwählen' : 'Auswählen'}
              >
                <span class="s3-check-box" class:is-checked={selected}><SpriteIcon name="check" class="i-check" /></span
                >
              </button>
            </div>
            {#each shownColumns as column (column.id)}
              <div
                class="s3-td"
                class:is-num={column.align === 'end'}
                class:is-meta={column.meta}
                class:s3-mono={column.mono}
                class:s3-num={column.meta && column.align !== 'end'}
                style:font-size={column.small ? 'var(--text-12)' : undefined}
                role="gridcell"
              >
                {#if column.cell}
                  {@render column.cell(row)}
                {:else}
                  <span>{column.text?.(row) ?? ''}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
    {#if rowCount === 0 && empty}
      {@render empty()}
    {/if}
  </div>
  {#if dropTarget}
    <!-- Eigenes Element statt outline: der sticky Kopf würde die obere Kante verdecken. -->
    <div class="s3-drop-frame" aria-hidden="true" style:top="{scrollTop}px" style:height="{clientHeight}px"></div>
  {/if}
</div>
