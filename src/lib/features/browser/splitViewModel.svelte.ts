// Zwei-Panel-Ansicht (Screen 3): lokal links, Bucket rechts, Kopieren in beide Richtungen über
// die Leiste in der Mitte oder per Ziehen zwischen den Seiten.

import type { FolderLocation } from '../../core/backend';
import type { LocalPanelViewModel } from '../local/localPanelViewModel.svelte';
import type { TransfersViewModel } from '../transfers/transfersViewModel.svelte';
import type { BrowserViewModel } from './browserViewModel.svelte';

export type PanelSide = 'local' | 'bucket';

export interface SplitDeps {
  browser: BrowserViewModel;
  local: LocalPanelViewModel;
  transfers: TransfersViewModel;
}

export class SplitViewModel {
  active = $state(false);

  readonly #deps: SplitDeps;

  constructor(deps: SplitDeps) {
    this.#deps = deps;
  }

  /** Ansicht umschalten; die lokale Seite lädt beim ersten Zeigen die Laufwerke. */
  toggle(active = !this.active): void {
    this.active = active;
    if (active) this.#deps.local.ensureStarted();
  }

  /** „→ in den Bucket kopieren“ */
  get canUpload(): boolean {
    return this.#deps.browser.uploadTarget !== null && this.#deps.local.selectedPaths.length > 0;
  }

  /** „← lokal speichern“ */
  get canDownload(): boolean {
    return this.#deps.local.path !== null && this.#deps.browser.hasSelection;
  }

  /** Lokale Auswahl in den offenen Ordner oder in `prefix` des Buckets hochladen. */
  upload(prefix?: string): void {
    const target = this.uploadTarget(prefix);
    const paths = this.#deps.local.selectedPaths;
    if (target && paths.length > 0) void this.#deps.transfers.uploadPaths(target, paths);
  }

  /** Bucket-Auswahl in den offenen lokalen Ordner oder in `dir` speichern. */
  download(dir?: string): void {
    const targetDir = dir ?? this.#deps.local.path;
    if (!targetDir) return;
    void this.#deps.browser.resolveSelection().then((selection) => {
      if (selection) void this.#deps.transfers.downloadTo(selection, targetDir);
    });
  }

  /** Abgelegt auf der anderen Seite: dorthin kopieren, wo gezogen wurde. */
  copyFrom(side: PanelSide, folder?: string): void {
    if (side === 'local') this.upload(folder);
    else this.download(folder);
  }

  uploadTarget(prefix?: string): FolderLocation | null {
    const base = this.#deps.browser.uploadTarget;
    return base && prefix !== undefined ? { ...base, prefix } : base;
  }

  /** Lokaler Ordner und Bucket-Ordner für „Abgleichen“; null, solange eine Seite fehlt. */
  get syncPlace(): { folder: FolderLocation; localDir: string } | null {
    const folder = this.#deps.browser.uploadTarget;
    const localDir = this.#deps.local.path;
    return folder && localDir ? { folder, localDir } : null;
  }

  /** Strg+U auf der lokalen Seite kopiert die Auswahl in den Bucket; true, wenn behandelt. */
  handleLocalShortcut(key: string, ctrl: boolean): boolean {
    if (!ctrl || key.toLowerCase() !== 'u') return false;
    this.upload();
    return true;
  }
}
