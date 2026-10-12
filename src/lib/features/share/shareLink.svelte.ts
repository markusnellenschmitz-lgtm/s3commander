// Vorsignierter Link mit wählbarer Gültigkeit: erzeugen, kopieren und an den Teilen-Dialog von
// Windows geben. Gemeinsam für den Abschnitt „Freigabe“ der Eigenschaften und den Teilen-Dialog.

import type { BackendError, BackendPort, ObjectAt } from '../../core/backend';
import { toBackendError } from '../../core/backend';
import { hasShareSheet } from '../../core/platform';
import { DEFAULT_SHARE_SECS, shareUntilText } from './shareRules';

export interface ShareLinkDeps {
  backend: Pick<BackendPort, 'platform' | 'presignObject' | 'shareLink'>;
  writeText: (text: string) => Promise<void>;
  now?: () => number;
}

export class ShareLink {
  secs = $state(DEFAULT_SHARE_SECS);
  url = $state<string | null>(null);
  error = $state<BackendError | null>(null);

  readonly #deps: ShareLinkDeps;
  readonly #now: () => number;
  #target: ObjectAt | null = null;
  /** Erhöht sich bei jedem neuen Link; verspätete Antworten werden verworfen. */
  #token = 0;

  constructor(deps: ShareLinkDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Ob es einen Teilen-Dialog des Systems gibt; sonst bleibt nur das Kopieren. */
  get canShare(): boolean {
    return hasShareSheet(this.#deps.backend.platform);
  }

  /** "bis 12.10.2026 15:23:08" */
  get untilText(): string {
    return shareUntilText(this.#now(), this.secs);
  }

  /** Erzeugt den Link für ein Objekt mit der gewählten Gültigkeit. */
  load(at: ObjectAt): Promise<void> {
    this.#target = at;
    return this.#presign();
  }

  setDuration(secs: number): Promise<void> {
    this.secs = secs;
    return this.#presign();
  }

  clear(): void {
    this.#target = null;
    this.#token++;
    this.url = null;
    this.error = null;
  }

  async copy(): Promise<void> {
    if (this.url) await this.#deps.writeText(this.url);
  }

  /** Öffnet den Teilen-Dialog von Windows; liefert true, wenn er sich geöffnet hat. */
  async share(title: string): Promise<boolean> {
    if (!this.url) return false;
    try {
      await this.#deps.backend.shareLink(title, this.url);
      this.error = null;
      return true;
    } catch (error) {
      this.error = toBackendError(error);
      return false;
    }
  }

  async #presign(): Promise<void> {
    const at = this.#target;
    if (!at) return;
    const token = ++this.#token;
    try {
      const url = await this.#deps.backend.presignObject(at, this.secs);
      if (token === this.#token) [this.url, this.error] = [url, null];
    } catch (error) {
      if (token === this.#token) [this.url, this.error] = [null, toBackendError(error)];
    }
  }
}
