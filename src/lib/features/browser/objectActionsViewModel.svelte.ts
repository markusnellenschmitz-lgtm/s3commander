// Datei-Aktionen im offenen Ordner an einer Stelle: Werkzeugleiste, Tastenkürzel und Kontextmenü
// nutzen dieselben Methoden. Das Kontextmenü zeigt nur, was zur Auswahl passt.

import type { ObjectSelection } from '../../core/backend';
import { ContextMenuController } from '../../core/contextMenu.svelte';
import { SEPARATOR, tidySeparators, type MenuEntry, type MenuItem } from '../../core/menu';
import type { SpriteIconName } from '../../ui/icons/sprite';
import type { ClipboardViewModel } from '../clipboard/clipboardViewModel.svelte';
import type { DeleteViewModel } from '../deletion/deleteViewModel.svelte';
import type { DetailsViewModel } from '../details/detailsViewModel.svelte';
import type { NameDialogViewModel } from '../naming/nameDialogViewModel.svelte';
import type { TransfersViewModel } from '../transfers/transfersViewModel.svelte';
import type { BrowserViewModel } from './browserViewModel.svelte';

export type ObjectActionId =
  | 'open'
  | 'download'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'rename'
  | 'copyPath'
  | 'newFolder'
  | 'upload'
  | 'refresh'
  | 'properties'
  | 'presignedUrl'
  | 'delete';

export type ObjectMenuItem = MenuItem<ObjectActionId, SpriteIconName>;
export type ObjectMenuEntry = MenuEntry<ObjectActionId, SpriteIconName>;

export interface ObjectActionsDeps {
  browser: BrowserViewModel;
  transfers: TransfersViewModel;
  deletion: DeleteViewModel;
  naming: NameDialogViewModel;
  clipboard: ClipboardViewModel;
  details: DetailsViewModel;
  /** Text in die Zwischenablage von Windows schreiben. */
  writeText: (text: string) => Promise<void>;
}

/** Kürzel aus DESIGN-SYSTEM.md, wie sie im Menü stehen. */
const KBD: Partial<Record<ObjectActionId, string>> = {
  open: 'Enter',
  download: 'Strg+D',
  copy: 'Strg+C',
  cut: 'Strg+X',
  paste: 'Strg+V',
  rename: 'F2',
  upload: 'Strg+U',
  refresh: 'F5',
  properties: 'Alt+Enter',
  delete: 'Entf',
};

export class ObjectActionsViewModel {
  readonly menu: ContextMenuController<ObjectActionId, SpriteIconName>;

  readonly #deps: ObjectActionsDeps;

  constructor(deps: ObjectActionsDeps) {
    this.#deps = deps;
    this.menu = new ContextMenuController({
      open: () => this.open(),
      download: () => this.download(),
      copy: () => this.copy(),
      cut: () => this.cut(),
      paste: () => this.paste(),
      rename: () => this.rename(),
      copyPath: () => this.copyPath(),
      newFolder: () => this.newFolder(),
      upload: () => this.upload(),
      refresh: () => deps.browser.refresh(),
      properties: () => (deps.details.isOpen = true),
      presignedUrl: () => this.copyPresignedUrl(),
      delete: () => this.remove(),
    });
  }

  // ---------- Aktionen ----------

  /** Öffnet einen einzeln gewählten Ordner. */
  open(): void {
    const [entry, ...rest] = this.#deps.browser.selectedEntries;
    if (entry?.isPrefix && rest.length === 0) this.#deps.browser.open(entry);
  }

  download(): void {
    this.#withSelection((s) => void this.#deps.transfers.download(s));
  }

  copy(): void {
    this.#withSelection((s) => this.#deps.clipboard.store('copy', s));
  }

  cut(): void {
    this.#withSelection((s) => this.#deps.clipboard.store('cut', s));
  }

  paste(): void {
    this.#deps.clipboard.pasteInto(this.#deps.browser.uploadTarget);
  }

  rename(): void {
    this.#withSelection((s) => this.#deps.naming.openRename(s));
  }

  remove(): void {
    this.#withSelection((s) => void this.#deps.deletion.open(s));
  }

  newFolder(): void {
    const target = this.#deps.browser.uploadTarget;
    if (target) this.#deps.naming.openCreateFolder(target);
  }

  upload(): void {
    const target = this.#deps.browser.uploadTarget;
    if (target) void this.#deps.transfers.upload(target);
  }

  /** Schreibt "s3://bucket/key" der Auswahl in die Zwischenablage, eine Zeile je Eintrag. */
  copyPath(): void {
    const location = this.#deps.browser.location;
    const entries = this.#deps.browser.selectedEntries;
    if (!location || entries.length === 0) return;
    void this.#deps.writeText(entries.map((e) => `s3://${location.bucket}/${e.key}`).join('\n'));
  }

  /** Vorsignierter Link (24 Stunden) für eine einzeln gewählte Datei. */
  copyPresignedUrl(): void {
    const location = this.#deps.browser.location;
    const [entry, ...rest] = this.#deps.browser.selectedEntries;
    if (!location || !entry || entry.isPrefix || rest.length > 0) return;
    void this.#deps.details.copyPresignedUrl({
      profileId: location.profileId,
      bucket: location.bucket,
      key: entry.key,
    });
  }

  // ---------- Kontextmenü ----------

  /** Rechtsklick auf eine Zeile: Ist sie nicht gewählt, gilt das Menü nur für sie (wie im Explorer). */
  openForRow(index: number, x: number, y: number): void {
    const entry = this.#deps.browser.source.get(index);
    if (!entry) return;
    if (!this.#deps.browser.selection.has(entry.key)) this.#deps.browser.selection.only(entry.key);
    this.openAt(x, y);
  }

  /** Rechtsklick auf freie Fläche: Aktionen für den Ordner selbst. */
  openForBackground(x: number, y: number): void {
    this.#deps.browser.selection.clear();
    this.openAt(x, y);
  }

  /** Umschalt+F10 oder Menütaste: Menü für die aktuelle Auswahl. */
  openAt(x: number, y: number): void {
    if (this.#deps.browser.location) this.menu.show(x, y, this.entries);
  }

  /** Einträge passend zur Auswahl; nicht Mögliches ist gesperrt statt versteckt. */
  get entries(): ObjectMenuEntry[] {
    const selected = this.#deps.browser.selectedEntries;
    const cannotPaste = !this.#deps.clipboard.canPaste;
    if (selected.length === 0) {
      return [
        this.#item('paste', 'Einfügen', 'clipboard-paste', cannotPaste),
        this.#item('newFolder', 'Neuer Ordner', 'folder-plus'),
        this.#item('upload', 'Hochladen', 'upload'),
        SEPARATOR,
        this.#item('refresh', 'Aktualisieren', 'refresh-cw'),
      ];
    }
    const single = selected.length === 1;
    const singleFolder = single && selected[0].isPrefix;
    const singleFile = single && !selected[0].isPrefix;
    return tidySeparators<ObjectActionId, SpriteIconName>([
      ...(singleFolder ? [this.#item('open', 'Öffnen', 'folder-open')] : []),
      this.#item('download', 'Herunterladen', 'download'),
      SEPARATOR,
      this.#item('copy', 'Kopieren', 'copy'),
      this.#item('cut', 'Ausschneiden', 'scissors'),
      this.#item('paste', 'Einfügen', 'clipboard-paste', cannotPaste),
      SEPARATOR,
      this.#item('rename', 'Umbenennen', 'pencil', !single),
      this.#item('copyPath', single ? 'Pfad kopieren' : 'Pfade kopieren', 'clipboard-copy'),
      this.#item('newFolder', 'Neuer Ordner', 'folder-plus'),
      SEPARATOR,
      this.#item('presignedUrl', 'Presigned URL kopieren', 'link', !singleFile),
      this.#item('properties', 'Eigenschaften', 'panel-right'),
      SEPARATOR,
      { ...this.#item('delete', 'Löschen', 'trash-2'), danger: true },
    ]);
  }

  #item(id: ObjectActionId, label: string, icon: SpriteIconName, disabled = false): ObjectMenuItem {
    return { id, label, icon, kbd: KBD[id], disabled };
  }

  #withSelection(action: (selection: ObjectSelection) => void): void {
    const selection = this.#deps.browser.selectedObjects;
    if (selection) action(selection);
  }
}
