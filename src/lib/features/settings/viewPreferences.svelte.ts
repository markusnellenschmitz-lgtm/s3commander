// Ansichts-Einstellungen, die nur die Oberfläche betreffen: automatisch verbinden, Dichte,
// sichtbare Spalten. Sie liegen im lokalen Speicher der WebView.

import { ENTRY_COLUMN_LABELS, type EntryColumn } from '../objects/entry';
import type { KeyValueStore } from './themeViewModel.svelte';

export const VIEW_STORAGE_KEY = 's3client.view';

export interface ViewPrefs {
  /** Beim Start alle Verbindungen verbinden. */
  autoConnect: boolean;
  /** Zeilenhöhe 24 statt 28 px. */
  compact: boolean;
  hiddenColumns: EntryColumn[];
}

export const DEFAULT_VIEW: Readonly<ViewPrefs> = { autoConnect: true, compact: false, hiddenColumns: [] };

/** Spalten, die sich ausblenden lassen; der Name bleibt immer sichtbar. */
export const OPTIONAL_COLUMNS: readonly { id: EntryColumn; label: string }[] = (
  ['size', 'modified', 'storageClass', 'etag'] as const
).map((id) => ({ id, label: ENTRY_COLUMN_LABELS[id] }));

const COLUMN_IDS: ReadonlySet<string> = new Set(OPTIONAL_COLUMNS.map((c) => c.id));

/** Liest gespeicherte Werte; Unbekanntes und Kaputtes fällt auf die Standardwerte zurück. */
function parse(raw: string | null): ViewPrefs {
  try {
    const value = JSON.parse(raw ?? '{}') as Partial<ViewPrefs>;
    return {
      autoConnect: typeof value.autoConnect === 'boolean' ? value.autoConnect : DEFAULT_VIEW.autoConnect,
      compact: typeof value.compact === 'boolean' ? value.compact : DEFAULT_VIEW.compact,
      hiddenColumns: Array.isArray(value.hiddenColumns)
        ? value.hiddenColumns.filter((c): c is EntryColumn => COLUMN_IDS.has(c))
        : [],
    };
  } catch {
    return { ...DEFAULT_VIEW, hiddenColumns: [] };
  }
}

export class ViewPreferences {
  value = $state<ViewPrefs>({ ...DEFAULT_VIEW, hiddenColumns: [] });
  readonly #store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.#store = store;
    this.value = parse(store.get(VIEW_STORAGE_KEY));
  }

  update(change: Partial<ViewPrefs>): void {
    this.value = { ...this.value, ...change };
    this.#store.set(VIEW_STORAGE_KEY, JSON.stringify(this.value));
  }
}
