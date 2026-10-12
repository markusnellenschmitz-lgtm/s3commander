// Aktionen für Verbindungen und Buckets im Verbindungsbaum: Kontextmenü und das Löschen
// einer Verbindung mit Rückfrage. Gelöscht werden nur Profil und Zugangsdaten, nie Daten im Bucket.

import type { BackendError, ConnectionProfile } from '../../core/backend';
import { toBackendError } from '../../core/backend';
import { ContextMenuController } from '../../core/contextMenu.svelte';
import { SEPARATOR, type MenuEntry, type MenuItem } from '../../core/menu';
import type { SpriteIconName } from '../../ui/icons/sprite';
import type { BrowserViewModel, TreeTarget } from '../browser/browserViewModel.svelte';

export type ConnectionActionId =
  'connect' | 'disconnect' | 'reconnect' | 'edit' | 'delete' | 'openBucket' | 'openBucketInNewTab' | 'copyBucketPath';

type ConnectionMenuItem = MenuItem<ConnectionActionId, SpriteIconName>;
type ConnectionMenuEntry = MenuEntry<ConnectionActionId, SpriteIconName>;

export interface PendingDelete {
  profileId: string;
  name: string;
}

export interface ConnectionActionsDeps {
  browser: BrowserViewModel;
  /** Öffnet den Verbindungsdialog zum Bearbeiten. */
  edit: (profile: ConnectionProfile) => void;
  /** Text in die Zwischenablage von Windows schreiben. */
  writeText: (text: string) => Promise<void>;
  /** Bucket in einem neuen Tab öffnen. */
  openInNewTab: (profileId: string, bucket: string) => void;
}

export class ConnectionActionsViewModel {
  readonly menu: ContextMenuController<ConnectionActionId, SpriteIconName>;
  pendingDelete = $state<PendingDelete | null>(null);
  deleting = $state(false);
  deleteError = $state<BackendError | null>(null);

  readonly #deps: ConnectionActionsDeps;
  /** Knoten, für den das Menü zuletzt geöffnet wurde. */
  #target: TreeTarget | null = null;

  constructor(deps: ConnectionActionsDeps) {
    this.#deps = deps;
    this.menu = new ContextMenuController({
      connect: () => this.#withProfile((id) => void deps.browser.connect(id)),
      reconnect: () => this.#withProfile((id) => void deps.browser.connect(id)),
      disconnect: () => this.#withProfile((id) => deps.browser.disconnect(id)),
      edit: () => this.#withProfile((id) => this.edit(id)),
      delete: () => this.#withProfile((id) => this.requestDelete(id)),
      openBucket: () => this.#withBucket((id, bucket) => deps.browser.openBucket(id, bucket)),
      openBucketInNewTab: () => this.#withBucket((id, bucket) => deps.openInNewTab(id, bucket)),
      copyBucketPath: () => this.#withBucket((_, bucket) => void deps.writeText(`s3://${bucket}`)),
    });
  }

  /** Rechtsklick oder Umschalt+F10 auf einen Knoten des Baums. */
  openForNode(nodeId: string, x: number, y: number): void {
    const target = this.#deps.browser.treeTarget(nodeId);
    if (!target) return;
    this.#target = target;
    this.#deps.browser.activeTreeId = nodeId;
    this.menu.show(
      x,
      y,
      target.bucket === undefined ? this.#connectionEntries(target.profileId) : this.#bucketEntries(),
    );
  }

  edit(profileId: string): void {
    const connection = this.#deps.browser.connections.find((c) => c.profile.id === profileId);
    if (connection) this.#deps.edit(connection.profile);
  }

  /** Fragt vor dem Löschen nach. */
  requestDelete(profileId: string): void {
    const connection = this.#deps.browser.connections.find((c) => c.profile.id === profileId);
    if (!connection) return;
    this.pendingDelete = { profileId, name: connection.profile.name };
    this.deleteError = null;
  }

  async confirmDelete(): Promise<void> {
    const pending = this.pendingDelete;
    if (!pending || this.deleting) return;
    this.deleting = true;
    try {
      await this.#deps.browser.deleteProfile(pending.profileId);
      this.pendingDelete = null;
    } catch (error) {
      this.deleteError = toBackendError(error);
    } finally {
      this.deleting = false;
    }
  }

  cancelDelete(): void {
    if (!this.deleting) this.pendingDelete = null;
  }

  #connectionEntries(profileId: string): ConnectionMenuEntry[] {
    const status = this.#deps.browser.connections.find((c) => c.profile.id === profileId)?.status;
    const connection: ConnectionMenuItem[] =
      status === 'connected'
        ? [item('disconnect', 'Trennen', 'unplug'), item('reconnect', 'Neu verbinden', 'refresh-cw')]
        : [{ ...item('connect', 'Verbinden', 'plug'), disabled: status === 'connecting' }];
    return [
      ...connection,
      SEPARATOR,
      item('edit', 'Bearbeiten …', 'pencil'),
      SEPARATOR,
      { ...item('delete', 'Verbindung löschen …', 'trash-2'), danger: true },
    ];
  }

  #bucketEntries(): ConnectionMenuEntry[] {
    return [
      item('openBucket', 'Öffnen', 'folder-open'),
      item('openBucketInNewTab', 'In neuem Tab öffnen', 'plus'),
      item('copyBucketPath', 'Pfad kopieren', 'clipboard-copy'),
    ];
  }

  #withProfile(action: (profileId: string) => void): void {
    if (this.#target) action(this.#target.profileId);
  }

  #withBucket(action: (profileId: string, bucket: string) => void): void {
    const target = this.#target;
    if (target?.bucket !== undefined) action(target.profileId, target.bucket);
  }
}

function item(id: ConnectionActionId, label: string, icon: SpriteIconName): ConnectionMenuItem {
  return { id, label, icon };
}
