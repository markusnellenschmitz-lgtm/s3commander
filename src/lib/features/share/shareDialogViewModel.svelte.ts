// View-Model des Dialogs „Teilen“: Gültigkeit wählen, dann den Link über den Teilen-Dialog von
// Windows weitergeben (Mail, Messenger, Umgebungsfreigabe, QR-Code) oder kopieren.

import type { ObjectAt } from '../../core/backend';
import { baseName } from '../../core/objectName';
import { ShareLink, type ShareLinkDeps } from './shareLink.svelte';

export class ShareDialogViewModel {
  isOpen = $state(false);
  /** Dateiname; erscheint als Titel im Teilen-Dialog von Windows. */
  name = $state('');
  readonly link: ShareLink;

  constructor(deps: ShareLinkDeps) {
    this.link = new ShareLink(deps);
  }

  open(at: ObjectAt): void {
    this.name = baseName(at.key);
    this.isOpen = true;
    void this.link.load(at);
  }

  close(): void {
    this.isOpen = false;
    this.link.clear();
  }

  /** Übergibt an Windows und schließt; bei einem Fehler bleibt der Dialog mit Hinweis offen. */
  async share(): Promise<void> {
    if (await this.link.share(this.name)) this.close();
  }
}
