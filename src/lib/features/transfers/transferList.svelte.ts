// Alle bekannten Transfers in Reihenfolge ihrer IDs. Meldungen des Backends enthalten nur
// Änderungen; die Liste führt sie zusammen und meldet jede Änderung über einen Versionszähler.

import type { TransferSnapshot, TransferUpdate } from '../../core/backend';

export class TransferList {
  /** Steigt mit jeder Änderung; Ableitungen hängen nur hiervon ab. */
  version = $state(0);

  readonly #byId = new Map<number, TransferSnapshot>();

  /** Alle Transfers aufsteigend nach ID; je Version einmal erzeugt. */
  readonly all: readonly TransferSnapshot[] = $derived.by(() => {
    void this.version;
    return [...this.#byId.values()];
  });

  /** Ersetzt den gesamten Stand, z. B. beim Start. */
  replace(transfers: readonly TransferSnapshot[]): void {
    this.#byId.clear();
    for (const t of [...transfers].sort((a, b) => a.id - b.id)) this.#byId.set(t.id, t);
    this.version++;
  }

  /** Übernimmt eine Meldung. Neue IDs sind immer größer als bekannte und kommen ans Ende. */
  apply(update: TransferUpdate): void {
    for (const t of update.changed) this.#byId.set(t.id, t);
    for (const id of update.removed) this.#byId.delete(id);
    this.version++;
  }
}
