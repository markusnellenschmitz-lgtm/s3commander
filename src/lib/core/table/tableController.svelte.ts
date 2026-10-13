// Cursor und Auswahl einer Liste (Logik aus Prototyp.dc.html, UI-SPEC §5).
// Unabhängig vom DOM: die Ansicht übersetzt Ereignisse in Aufrufe und setzt
// zurückgegebene Effekte (Scrollen, Öffnen) um.

import { isNavKey, navigationTarget, navMode, type NavMode } from './navigation';
import type { Selection } from './selection.svelte';
import type { RowSource } from './types';

export interface Modifiers {
  ctrl: boolean;
  shift: boolean;
}

export type HeadState = 'none' | 'mixed' | 'all';

export interface KeyResult {
  handled: boolean;
  /** Zeile, die sichtbar gemacht werden soll. */
  reveal?: number;
  /** Zeile, die geöffnet werden soll (Enter). */
  open?: number;
  /** Kontextmenü für diese Zeile öffnen (Umschalt+F10). */
  contextMenu?: number;
}

const NOT_HANDLED: KeyResult = { handled: false };

export class TableController {
  /** Schlüsselbasiert, damit Cursor und Anker Umsortieren überleben. */
  cursorKey = $state<string | null>(null);
  anchorKey = $state<string | null>(null);

  readonly #source: () => RowSource<unknown>;
  readonly #selection: () => Selection;

  constructor(source: () => RowSource<unknown>, selection: () => Selection) {
    this.#source = source;
    this.#selection = selection;
  }

  get cursorIndex(): number {
    const source = this.#source();
    void source.version;
    return this.cursorKey === null ? -1 : source.indexOfKey(this.cursorKey);
  }

  get headState(): HeadState {
    const source = this.#source();
    const selection = this.#selection();
    void selection.version;
    void source.version;
    const count = selection.count(source.length);
    if (count === 0) return 'none';
    return count >= source.length ? 'all' : 'mixed';
  }

  isSelected(index: number): boolean {
    const selection = this.#selection();
    void selection.version;
    const key = this.#keyOf(index);
    return key !== undefined && selection.has(key);
  }

  click(index: number, mods: Modifiers): void {
    const key = this.#keyOf(index);
    if (key === undefined) return;
    const anchor = this.#anchorIndex();
    if (mods.shift && anchor >= 0) {
      this.#selectRange(anchor, index, mods.ctrl);
      this.cursorKey = key;
    } else if (mods.ctrl) {
      this.toggle(index);
    } else {
      this.#selection().only(key);
      this.#setCursorAndAnchor(key);
    }
  }

  /** Checkbox oder Leertaste: wie Strg+Klick. */
  toggle(index: number): void {
    const key = this.#keyOf(index);
    if (key === undefined) return;
    this.#selection().toggle(key);
    this.#setCursorAndAnchor(key);
  }

  /** Rechtsklick: nicht gewählte Zeile wird alleinige Auswahl, gewählte bleibt Teil der Auswahl. */
  contextClick(index: number): void {
    const key = this.#keyOf(index);
    if (key === undefined) return;
    if (!this.#selection().has(key)) {
      this.#selection().only(key);
      this.anchorKey = key;
    }
    this.cursorKey = key;
  }

  /** Kopf-Checkbox: keine → alle, gemischt oder alle → keine. */
  toggleAll(): void {
    if (this.headState === 'none') this.#selection().selectAll();
    else this.#selection().clear();
  }

  keyDown(key: string, mods: Modifiers, pageSize: number): KeyResult {
    const rowCount = this.#source().length;
    if (rowCount === 0) return NOT_HANDLED;
    const current = this.cursorIndex;
    if (isNavKey(key)) return this.#navigate(navigationTarget(key, current, rowCount, pageSize), mods);
    const command = this.#commands[key];
    return command ? command(current, mods) : NOT_HANDLED;
  }

  /** Tastenbefehle außer Navigation (UI-SPEC §6). */
  readonly #commands: Readonly<Record<string, (current: number, mods: Modifiers) => KeyResult>> = {
    ' ': (current) => {
      if (current >= 0) this.toggle(current);
      return { handled: true };
    },
    Enter: (current) => (current >= 0 ? { handled: true, open: current } : NOT_HANDLED),
    Escape: () => {
      this.#selection().clear();
      return { handled: true };
    },
    a: (_, mods) => this.#selectAllWithCtrl(mods),
    A: (_, mods) => this.#selectAllWithCtrl(mods),
    F10: (current, mods) => (mods.shift && current >= 0 ? { handled: true, contextMenu: current } : NOT_HANDLED),
  };

  #navigate(target: number | null, mods: Modifiers): KeyResult {
    if (target === null) return NOT_HANDLED;
    this.#moveCursor(target, navMode(mods.shift, mods.ctrl));
    return { handled: true, reveal: target };
  }

  #selectAllWithCtrl(mods: Modifiers): KeyResult {
    if (!mods.ctrl) return NOT_HANDLED;
    this.#selection().selectAll();
    return { handled: true };
  }

  #moveCursor(index: number, mode: NavMode): void {
    const key = this.#keyOf(index);
    if (key === undefined) return;
    if (mode === 'single') {
      this.#selection().only(key);
      this.anchorKey = key;
    } else if (mode === 'extend' || mode === 'extendAdd') {
      const anchor = this.#anchorIndex();
      this.#selectRange(anchor >= 0 ? anchor : index, index, mode === 'extendAdd');
      if (anchor < 0) this.anchorKey = key;
    }
    this.cursorKey = key;
  }

  /**
   * Bereichsauswahl. Quellen, die nur Fenster geladen haben, laden den Bereich erst vollständig,
   * damit keine Zeile dazwischen fehlt; ein Bereich über alles braucht keine Schlüssel.
   */
  #selectRange(a: number, b: number, additive: boolean): void {
    const source = this.#source();
    const select = () => this.#selection().selectRange(source, a, b, additive);
    const coversAll = !additive && Math.min(a, b) === 0 && Math.max(a, b) >= source.length - 1;
    if (!source.ensureLoaded || coversAll) select();
    else void source.ensureLoaded(Math.min(a, b), Math.max(a, b)).then(select);
  }

  #setCursorAndAnchor(key: string): void {
    this.cursorKey = key;
    this.anchorKey = key;
  }

  #anchorIndex(): number {
    return this.anchorKey === null ? -1 : this.#source().indexOfKey(this.anchorKey);
  }

  #keyOf(index: number): string | undefined {
    const source = this.#source();
    return index >= 0 && index < source.length ? source.keyAt(index) : undefined;
  }
}
