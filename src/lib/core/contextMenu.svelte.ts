// Zustand eines Kontextmenüs: Position, Einträge und die Aktionen dahinter.
// Geteilt von Objektliste und Verbindungsbaum.

import type { MenuEntry } from './menu';

export interface ContextMenuState<Id extends string, Icon extends string> {
  x: number;
  y: number;
  entries: MenuEntry<Id, Icon>[];
}

export class ContextMenuController<Id extends string, Icon extends string> {
  state = $state<ContextMenuState<Id, Icon> | null>(null);

  readonly #actions: Record<Id, () => void>;

  constructor(actions: Record<Id, () => void>) {
    this.#actions = actions;
  }

  show(x: number, y: number, entries: MenuEntry<Id, Icon>[]): void {
    this.state = { x, y, entries };
  }

  close(): void {
    this.state = null;
  }

  /** Schließt das Menü und führt die Aktion aus. */
  run(id: Id): void {
    this.close();
    this.#actions[id]();
  }
}
