import type { RowSource } from './types';

/**
 * Schlüsselbasierte Auswahl (überlebt Umsortieren, UI-SPEC §5).
 * Für große Listen gibt es einen Invertiert-Modus: "alle außer keys".
 * Strg+A über eine Million Zeilen kostet so keinen Speicher.
 */
export class Selection {
  #all = false;
  #keys = new Set<string>();
  /** Reaktiver Zähler für Svelte. */
  version = $state(0);

  #bump() {
    this.version++;
  }

  has(key: string): boolean {
    return this.#all !== this.#keys.has(key);
  }

  count(total: number): number {
    return this.#all ? total - this.#keys.size : this.#keys.size;
  }

  get isInverted(): boolean {
    return this.#all;
  }

  /** Im normalen Modus die gewählten, im invertierten die ausgenommenen Schlüssel. */
  get rawKeys(): ReadonlySet<string> {
    return this.#keys;
  }

  clear() {
    this.#all = false;
    this.#keys.clear();
    this.#bump();
  }

  selectAll() {
    this.#all = true;
    this.#keys.clear();
    this.#bump();
  }

  only(key: string) {
    this.#all = false;
    this.#keys.clear();
    this.#keys.add(key);
    this.#bump();
  }

  set(key: string, on: boolean, notify = true) {
    if (on !== this.#all) this.#keys.add(key);
    else this.#keys.delete(key);
    if (notify) this.#bump();
  }

  toggle(key: string) {
    this.set(key, !this.has(key));
  }

  /** Bereich a..b auswählen; additive behält die bestehende Auswahl. */
  selectRange(source: RowSource<unknown>, a: number, b: number, additive: boolean) {
    if (!additive) {
      this.#all = false;
      this.#keys.clear();
    }
    const from = Math.max(0, Math.min(a, b));
    const to = Math.min(source.length - 1, Math.max(a, b));
    // Bereich über alles: invertierten Modus nutzen statt Millionen Schlüssel zu speichern.
    if (!additive && from === 0 && to === source.length - 1) {
      this.selectAll();
      return;
    }
    for (let i = from; i <= to; i++) {
      const k = source.keyAt(i);
      if (k !== undefined) this.set(k, true, false);
    }
    this.#bump();
  }

  /** Entfernt Schlüssel, die es in der Quelle nicht mehr gibt (nach Neu-Listing). */
  prune(source: RowSource<unknown>) {
    let changed = false;
    for (const k of this.#keys) {
      if (source.indexOfKey(k) < 0) {
        this.#keys.delete(k);
        changed = true;
      }
    }
    if (changed) this.#bump();
  }
}
