<script lang="ts">
  // Objekttabelle (Screen 2): Spalten Name, Größe, Geändert, Storage Class, ETag.
  import DataTable from '../../ui/table/DataTable.svelte';
  import SpriteIcon from '../../ui/icons/SpriteIcon.svelte';
  import type { Column, RowSource, SortState } from '../../core/table/types';
  import type { Selection } from '../../core/table/selection.svelte';
  import { formatBytes, formatDate } from '../../core/format';
  import { ENTRY_COLUMN_LABELS as L, ICON_BY_KIND, kindOf, type S3Entry } from './entry';

  interface Props {
    source: RowSource<S3Entry>;
    selection: Selection;
    sort: SortState;
    compact?: boolean;
    label: string;
    onsort: (sort: SortState) => void;
    onopen?: (entry: S3Entry) => void;
    rowClass?: (entry: S3Entry) => string;
    onrowpointerdown?: (e: PointerEvent, entry: S3Entry) => void;
    dropTarget?: boolean;
    /** Ausgeblendete Spalten; der Name bleibt immer sichtbar. */
    hiddenColumns?: readonly string[];
  }

  let {
    source,
    selection,
    sort,
    compact = false,
    label,
    onsort,
    onopen,
    rowClass,
    onrowpointerdown,
    dropTarget = false,
    hiddenColumns = [],
  }: Props = $props();

  /** ETag-Spalte unter dieser Fensterbreite ausblenden (UI-SPEC §1). */
  const ETAG_MIN_WINDOW_WIDTH = 1440;

  const allColumns: Column<S3Entry>[] = [
    { id: 'name', label: L.name, width: 'minmax(260px, 1fr)', sortable: true, cell: nameCell },
    { id: 'size', label: L.size, width: '104px', align: 'end', sortable: true, text: (e) => formatBytes(e.size) },
    {
      id: 'modified',
      label: L.modified,
      width: '140px',
      meta: true,
      sortable: true,
      text: (e) => formatDate(e.lastModified),
    },
    {
      id: 'storageClass',
      label: L.storageClass,
      width: '120px',
      meta: true,
      small: true,
      sortable: true,
      text: (e) => e.storageClass ?? '',
    },
    {
      id: 'etag',
      label: L.etag,
      width: '300px',
      meta: true,
      mono: true,
      small: true,
      minWindowWidth: ETAG_MIN_WINDOW_WIDTH,
      text: (e) => e.etag ?? '',
    },
  ];
  const visibleColumns = $derived(allColumns.filter((column) => !hiddenColumns.includes(column.id)));
</script>

{#snippet nameCell(entry: S3Entry)}
  {@const kind = kindOf(entry)}
  <SpriteIcon name={ICON_BY_KIND[kind]} class={kind === 'folder' ? 'is-folder' : ''} />
  <span>{entry.name}</span>
{/snippet}

<DataTable
  {source}
  columns={visibleColumns}
  {selection}
  {sort}
  {compact}
  {label}
  {onsort}
  {rowClass}
  {onrowpointerdown}
  {dropTarget}
  onopen={(entry) => onopen?.(entry)}
/>
