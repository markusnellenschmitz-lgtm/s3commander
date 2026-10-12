// View-Model von Suchfeld und Filtern (Typ, Größe, Datum) über der Objektliste.
// Der Filter wirkt in der Datenquelle; Auswahl und Aktionen sehen nur die Treffer.

import type { MenuEntry } from '../../core/menu';
import type { SpriteIconName } from '../../ui/icons/sprite';
import type { Selection } from '../../core/table/selection.svelte';
import {
  DATE_OPTIONS,
  KIND_OPTIONS,
  NO_FILTER,
  SIZE_OPTIONS,
  filterPredicate,
  isActive,
  type DateFilter,
  type KindFilter,
  type ObjectFilter,
  type SizeFilter,
} from './objectFilter';
import type { ObjectSource } from './objectSource';

export type FilterGroup = 'kind' | 'size' | 'date';

export const FIND_KEY = 'f';

interface Option<Id extends string> {
  id: Id;
  label: string;
}

const OPTIONS: { [G in FilterGroup]: readonly Option<ObjectFilter[G]>[] } = {
  kind: KIND_OPTIONS,
  size: SIZE_OPTIONS,
  date: DATE_OPTIONS,
};

const BUTTON_LABELS: Record<FilterGroup, string> = { kind: 'Typ', size: 'Größe', date: 'Datum' };

export interface FilterMenuState {
  group: FilterGroup;
  x: number;
  y: number;
  entries: MenuEntry<string, SpriteIconName>[];
}

export interface ObjectFilterDeps {
  source: ObjectSource;
  selection: Selection;
  now?: () => number;
}

export class ObjectFilterViewModel {
  filter = $state<ObjectFilter>({ ...NO_FILTER });
  menu = $state<FilterMenuState | null>(null);

  readonly #source: ObjectSource;
  readonly #selection: Selection;
  readonly #now: () => number;

  constructor(deps: ObjectFilterDeps) {
    this.#source = deps.source;
    this.#selection = deps.selection;
    this.#now = deps.now ?? Date.now;
  }

  get isActive(): boolean {
    return isActive(this.filter);
  }

  setText(text: string): void {
    this.#update({ text });
  }

  setKind(kind: KindFilter): void {
    this.#update({ kind });
  }

  setSize(size: SizeFilter): void {
    this.#update({ size });
  }

  setDate(date: DateFilter): void {
    this.#update({ date });
  }

  /** Alle Filter zurücksetzen. */
  clear(): void {
    this.#update({ ...NO_FILTER });
  }

  /** Beim Wechsel des Ordners gilt der Suchtext nicht mehr; Typ, Größe und Datum bleiben. */
  onNavigate(): void {
    if (this.filter.text !== '') this.setText('');
  }

  /** Beschriftung des Filterknopfs: "Typ" oder "Typ: Archive". */
  buttonLabel(group: FilterGroup): string {
    const value = this.filter[group];
    if (value === 'all') return BUTTON_LABELS[group];
    const option = OPTIONS[group].find((o) => o.id === value);
    return `${BUTTON_LABELS[group]}: ${option?.label ?? value}`;
  }

  openMenu(group: FilterGroup, x: number, y: number): void {
    const current = this.filter[group];
    const entries = OPTIONS[group].map((o) => ({ id: o.id, label: o.label, checked: o.id === current }));
    this.menu = { group, x, y, entries };
  }

  closeMenu(): void {
    this.menu = null;
  }

  choose(id: string): void {
    const group = this.menu?.group;
    this.closeMenu();
    if (group) this.#update({ [group]: id } as Partial<ObjectFilter>);
  }

  #update(change: Partial<ObjectFilter>): void {
    this.filter = { ...this.filter, ...change };
    this.#source.setFilter(filterPredicate(this.filter, this.#now()));
    this.#selection.prune(this.#source);
  }
}
