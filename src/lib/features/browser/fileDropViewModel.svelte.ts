// View-Model für Drag and Drop aus dem Windows-Explorer (Screen 3: Drop-Ziel und Drag-Vorschau).
// Ziel ist die Ordnerzeile unter dem Mauszeiger, sonst irgendwo über der Tabelle der offene
// Ordner. Außerhalb der Tabelle wird nichts hochgeladen.

import type { FileDropEvent, FileDropPort, FolderLocation } from '../../core/backend';
import type { S3Entry } from '../objects/entry';
import type { BrowserViewModel } from './browserViewModel.svelte';
import { countText } from '../../core/format';
import { dropRowClass, folderAt } from '../objects/dropTarget';

/** Was die Ansicht unter dem Mauszeiger findet. */
export interface DropPoint {
  inTable: boolean;
  /** Index der Tabellenzeile unter dem Mauszeiger, sonst null. */
  rowIndex: number | null;
}

export type HitTest = (x: number, y: number) => DropPoint;

export interface FileDropDeps {
  drops: FileDropPort;
  browser: BrowserViewModel;
  upload: (target: FolderLocation, paths: string[]) => Promise<void>;
}

const NOWHERE: DropPoint = { inTable: false, rowIndex: null };

export class FileDropViewModel {
  active = $state(false);
  itemCount = $state(0);
  x = $state(0);
  y = $state(0);
  point = $state<DropPoint>(NOWHERE);

  readonly #drops: FileDropPort;
  readonly #browser: BrowserViewModel;
  readonly #upload: FileDropDeps['upload'];
  #hitTest: HitTest = () => NOWHERE;
  #unsubscribe: (() => void) | null = null;

  constructor(deps: FileDropDeps) {
    this.#drops = deps.drops;
    this.#browser = deps.browser;
    this.#upload = deps.upload;
  }

  async start(): Promise<void> {
    this.#unsubscribe = await this.#drops.onFileDrop((event) => this.handle(event));
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** Die Ansicht meldet, wie sie Koordinaten in Tabellenzeilen übersetzt. */
  setHitTest(hitTest: HitTest): void {
    this.#hitTest = hitTest;
  }

  handle(event: FileDropEvent): void {
    if (event.type === 'leave') {
      this.#reset();
      return;
    }
    if (event.type === 'enter') this.itemCount = event.paths.length;
    this.active = true;
    this.x = event.x;
    this.y = event.y;
    this.point = this.#hitTest(event.x, event.y);
    if (event.type === 'drop') {
      const target = this.target;
      this.#reset();
      if (target && event.paths.length > 0) void this.#upload(target, event.paths);
    }
  }

  /** Ordner unter dem Mauszeiger, sonst undefined. */
  get folder(): S3Entry | undefined {
    return folderAt(this.#browser.source, this.point.rowIndex);
  }

  get target(): FolderLocation | null {
    const base = this.#browser.uploadTarget;
    if (!base || !this.point.inTable) return null;
    return this.folder ? { ...base, prefix: this.folder.key } : base;
  }

  /** Ganze Tabelle hervorheben, wenn in den offenen Ordner abgelegt wird. */
  get highlightsTable(): boolean {
    return this.active && this.target !== null && this.folder === undefined;
  }

  /** CSS-Klasse für Tabellenzeilen: die Ordnerzeile unter dem Mauszeiger ist das Drop-Ziel. */
  rowClass(entry: S3Entry): string {
    return this.active ? dropRowClass(this.folder, entry) : '';
  }

  /** Erste Zeile der Drag-Vorschau: "3 Elemente". */
  get countText(): string {
    return countText(this.itemCount, 'Element', 'Elemente');
  }

  /** Zweite Zeile der Drag-Vorschau. */
  get targetText(): string {
    if (!this.#browser.uploadTarget) return 'Zuerst einen Bucket oder Ordner öffnen';
    const target = this.target;
    return target ? `Hochladen nach ${target.bucket}/${target.prefix}` : 'Zum Hochladen über der Liste ablegen';
  }

  #reset(): void {
    this.active = false;
    this.itemCount = 0;
    this.point = NOWHERE;
  }
}
