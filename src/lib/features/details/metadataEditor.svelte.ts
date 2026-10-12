// Bearbeiten der Metadaten eines Objekts: Zeilen ändern, hinzufügen, entfernen und
// zählen, was sich gegenüber dem gespeicherten Stand geändert hat.

import type { MetadataEntry } from '../../core/backend';
import { metadataNameError, metadataValueError } from './detailsRules';

export interface MetadataRow {
  id: number;
  name: string;
  value: string;
  /** Gespeicherter Stand; null für neue Zeilen. */
  original: MetadataEntry | null;
  editing: boolean;
}

/** Vorbelegung neuer Zeilen. */
export const NEW_METADATA_NAME = 'x-amz-meta-';

export class MetadataEditor {
  rows = $state<MetadataRow[]>([]);
  #saved: MetadataEntry[] = [];
  #nextId = 1;

  /** Übernimmt den gespeicherten Stand und verwirft alle Änderungen. */
  load(entries: readonly MetadataEntry[]): void {
    this.#saved = entries.map((e) => ({ ...e }));
    this.rows = this.#saved.map((entry) => this.#row(entry.name, entry.value, entry, false));
  }

  discard(): void {
    this.load(this.#saved);
  }

  add(): void {
    this.rows.push(this.#row(NEW_METADATA_NAME, '', null, true));
  }

  edit(id: number): void {
    const row = this.#find(id);
    if (row) row.editing = true;
  }

  setName(id: number, name: string): void {
    const row = this.#find(id);
    if (row?.original === null) row.name = name;
  }

  setValue(id: number, value: string): void {
    const row = this.#find(id);
    if (row) row.value = value;
  }

  remove(id: number): void {
    this.rows = this.rows.filter((r) => r.id !== id);
  }

  isDirty(row: MetadataRow): boolean {
    return row.original === null || row.original.value !== row.value;
  }

  /** Fehler einer Zeile: ungültiger Name, ungültiger Wert oder doppelter Name. */
  error(row: MetadataRow): string | null {
    const name = row.name.trim().toLowerCase();
    const duplicate = this.rows.some((r) => r.id !== row.id && r.name.trim().toLowerCase() === name);
    if (duplicate) return `„${row.name.trim()}“ kommt mehrfach vor`;
    return metadataNameError(row.name) ?? metadataValueError(row.value);
  }

  /** Geänderte, neue und entfernte Einträge zusammen. */
  get changeCount(): number {
    const removed = this.#saved.filter((s) => !this.rows.some((r) => r.original?.name === s.name)).length;
    return removed + this.rows.filter((r) => this.isDirty(r)).length;
  }

  get isValid(): boolean {
    return this.rows.every((r) => this.error(r) === null);
  }

  get entries(): MetadataEntry[] {
    return this.rows.map((r) => ({ name: r.name.trim().toLowerCase(), value: r.value.trim() }));
  }

  #row(name: string, value: string, original: MetadataEntry | null, editing: boolean): MetadataRow {
    return { id: this.#nextId++, name, value, original, editing };
  }

  #find(id: number): MetadataRow | undefined {
    return this.rows.find((r) => r.id === id);
  }
}
