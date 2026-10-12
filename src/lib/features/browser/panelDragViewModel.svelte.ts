// Ziehen zwischen den Seiten der Zwei-Panel-Ansicht (Screen 3). Über Pointer-Events statt HTML5
// Drag and Drop, weil Tauri unter Windows die HTML5-Ereignisse für den Explorer-Drop abfängt.
// Ziel ist die Ordnerzeile unter dem Mauszeiger, sonst der offene Ordner der anderen Seite.

import { countText, formatBytes } from '../../core/format';
import type { Selection } from '../../core/table/selection.svelte';
import { dropRowClass, folderAt } from '../objects/dropTarget';
import type { S3Entry } from '../objects/entry';
import type { ObjectSource } from '../objects/objectSource';
import type { LocalPanelViewModel } from '../local/localPanelViewModel.svelte';
import type { BrowserViewModel } from './browserViewModel.svelte';
import type { PanelSide, SplitViewModel } from './splitViewModel.svelte';

/** Was die Ansicht unter dem Mauszeiger findet. */
export interface PanelPoint {
  side: PanelSide | null;
  rowIndex: number | null;
}

export type PanelHitTest = (x: number, y: number) => PanelPoint;

/** Erst ab dieser Strecke wird aus einem Klick ein Ziehen. */
export const DRAG_THRESHOLD_PX = 5;

const NOWHERE: PanelPoint = { side: null, rowIndex: null };

export interface PanelDragDeps {
  split: SplitViewModel;
  browser: BrowserViewModel;
  local: LocalPanelViewModel;
}

export class PanelDragViewModel {
  /** Seite, von der gerade gezogen wird; null, solange nicht gezogen wird. */
  from = $state<PanelSide | null>(null);
  x = $state(0);
  y = $state(0);
  point = $state<PanelPoint>(NOWHERE);

  readonly #deps: PanelDragDeps;
  #pressed: { side: PanelSide; x: number; y: number } | null = null;
  #hitTest: PanelHitTest = () => NOWHERE;

  constructor(deps: PanelDragDeps) {
    this.#deps = deps;
  }

  setHitTest(hitTest: PanelHitTest): void {
    this.#hitTest = hitTest;
  }

  get active(): boolean {
    return this.from !== null;
  }

  /**
   * Maustaste auf einer Zeile gedrückt. Eine nicht ausgewählte Zeile wird allein ausgewählt, damit
   * sie gezogen werden kann; mit Strg oder Umschalt bleibt die Auswahl dem Klick überlassen.
   */
  press(side: PanelSide, entry: S3Entry, x: number, y: number, withModifier: boolean): void {
    if (withModifier) return;
    const selection = this.#selection(side);
    if (!selection.has(entry.key)) {
      selection.clear();
      selection.set(entry.key, true);
    }
    this.#pressed = { side, x, y };
  }

  move(x: number, y: number): void {
    const pressed = this.#pressed;
    if (!this.from && pressed && Math.hypot(x - pressed.x, y - pressed.y) >= DRAG_THRESHOLD_PX) {
      if (this.#count(pressed.side) > 0) this.from = pressed.side;
    }
    if (!this.from) return;
    this.x = x;
    this.y = y;
    this.point = this.#hitTest(x, y);
  }

  /** Maustaste losgelassen: auf der anderen Seite abgelegt wird kopiert. */
  release(): void {
    const from = this.from;
    const target = this.targetSide;
    const folder = this.folder?.key;
    this.cancel();
    if (from && target) this.#deps.split.copyFrom(from, folder);
  }

  cancel(): void {
    this.#pressed = null;
    this.from = null;
    this.point = NOWHERE;
  }

  /** Die andere Seite unter dem Mauszeiger; über der eigenen Seite wird nichts abgelegt. */
  get targetSide(): PanelSide | null {
    const side = this.point.side;
    return this.from && side && side !== this.from ? side : null;
  }

  get folder(): S3Entry | undefined {
    const side = this.targetSide;
    return side ? folderAt(this.#source(side), this.point.rowIndex) : undefined;
  }

  rowClass(side: PanelSide, entry: S3Entry): string {
    return this.targetSide === side ? dropRowClass(this.folder, entry) : '';
  }

  /** Ganze Tabelle hervorheben, wenn in ihren offenen Ordner abgelegt wird. */
  highlights(side: PanelSide): boolean {
    return this.targetSide === side && this.folder === undefined;
  }

  /** Erste Zeile der Vorschau: „2 Elemente · 610,7 MiB“. */
  get countText(): string {
    const side = this.from ?? 'local';
    const bytes = side === 'local' ? this.#deps.local.selectedBytes : this.#deps.browser.selectedBytes;
    return `${countText(this.#count(side), 'Element', 'Elemente')} · ${formatBytes(bytes)}`;
  }

  /** Zweite Zeile der Vorschau. */
  get targetText(): string {
    const side = this.targetSide;
    const folder = this.folder?.key;
    if (side === 'local') return `Speichern nach ${folder ?? this.#deps.local.path ?? ''}`;
    const target = side === 'bucket' ? this.#deps.split.uploadTarget(folder) : null;
    return target ? `Kopieren nach ${target.bucket}/${target.prefix}` : 'Zum Kopieren auf der anderen Seite ablegen';
  }

  #selection(side: PanelSide): Selection {
    return side === 'local' ? this.#deps.local.selection : this.#deps.browser.selection;
  }

  #source(side: PanelSide): ObjectSource {
    return side === 'local' ? this.#deps.local.source : this.#deps.browser.source;
  }

  #count(side: PanelSide): number {
    return side === 'local' ? this.#deps.local.selectedPaths.length : this.#deps.browser.selectedCount;
  }
}
