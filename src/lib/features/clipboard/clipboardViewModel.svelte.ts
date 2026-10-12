// Zwischenablage für Objekte: Strg+C merkt zum Kopieren, Strg+X zum Verschieben,
// Strg+V fügt in den offenen Ordner ein. Nach dem Verschieben ist die Ablage leer, wie im Explorer.

import type { FolderLocation, ObjectSelection } from '../../core/backend';
import { countText } from '../../core/format';

export type ClipboardMode = 'copy' | 'cut';

export interface ClipboardContent {
  mode: ClipboardMode;
  selection: ObjectSelection;
}

/** Was die Kürzel gerade betreffen würden. */
export interface ClipboardContext {
  /** Erst beim Kürzel ausgewertet, weil die Auswahl sehr groß sein kann. */
  selection: () => ObjectSelection | null;
  target: FolderLocation | null;
}

export interface ClipboardDeps {
  /** Fügt ein; `move` löscht die Originale nach dem Kopieren. */
  paste: (selection: ObjectSelection, target: FolderLocation, move: boolean) => Promise<void>;
}

const MODE_BY_KEY: Readonly<Record<string, ClipboardMode>> = { c: 'copy', x: 'cut' };

export class ClipboardViewModel {
  content = $state<ClipboardContent | null>(null);

  readonly #paste: ClipboardDeps['paste'];

  constructor(deps: ClipboardDeps) {
    this.#paste = deps.paste;
  }

  /** Strg+C, Strg+X und Strg+V; liefert true, wenn das Kürzel behandelt wurde. */
  handleShortcut(key: string, ctrl: boolean, context: ClipboardContext): boolean {
    if (!ctrl) return false;
    const lower = key.toLowerCase();
    if (lower === 'v') return this.pasteInto(context.target);
    const mode = MODE_BY_KEY[lower];
    if (!mode) return false;
    const selection = context.selection();
    if (!selection) return false;
    this.store(mode, selection);
    return true;
  }

  /** Merkt die Auswahl zum Kopieren oder Verschieben. */
  store(mode: ClipboardMode, selection: ObjectSelection): void {
    this.content = { mode, selection };
  }

  get canPaste(): boolean {
    return this.content !== null;
  }

  /** Fügt in den Ordner ein; liefert false, wenn nichts gemerkt ist oder kein Ziel offen ist. */
  pasteInto(target: FolderLocation | null): boolean {
    const { content } = this;
    if (!content || !target) return false;
    const move = content.mode === 'cut';
    if (move) this.content = null;
    void this.#paste(content.selection, target, move);
    return true;
  }

  clear(): void {
    this.content = null;
  }

  /** Statusleiste: "3 Einträge zum Kopieren gemerkt" */
  get statusText(): string {
    if (!this.content) return '';
    const count = this.content.selection.items.length;
    const what = countText(count, 'Eintrag', 'Einträge');
    return `${what} zum ${this.content.mode === 'copy' ? 'Kopieren' : 'Verschieben'} gemerkt`;
  }
}
