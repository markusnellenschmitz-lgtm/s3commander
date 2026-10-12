// Einträge von Menüs (Kontextmenü) und die Tastaturnavigation darin, ohne DOM.

/** `Icon` legt die Schicht fest, die das Menü anzeigt (z. B. die Sprite-Namen der UI). */
export interface MenuItem<Id extends string = string, Icon extends string = string> {
  id: Id;
  label: string;
  icon?: Icon;
  /** Auswahlmenü: Häkchen-Spalte statt Icon; true markiert die aktive Option. */
  checked?: boolean;
  /** Tastenkürzel in deutscher Beschriftung, z. B. "Strg+D". */
  kbd?: string;
  disabled?: boolean;
  /** Destruktive Aktion (Löschen), rot dargestellt. */
  danger?: boolean;
}

export const SEPARATOR = 'separator' as const;
export type MenuEntry<Id extends string = string, Icon extends string = string> = MenuItem<Id, Icon> | typeof SEPARATOR;

export function isMenuItem<Id extends string, Icon extends string>(
  entry: MenuEntry<Id, Icon>,
): entry is MenuItem<Id, Icon> {
  return entry !== SEPARATOR;
}

/**
 * Nächster wählbarer Eintrag ab `from` in Richtung `step` (+1 / -1), mit Umlauf.
 * `from` -1 heißt „noch keiner“: +1 liefert den ersten, -1 den letzten wählbaren Eintrag.
 * -1, wenn keiner wählbar ist.
 */
export function nextEnabledIndex(entries: readonly MenuEntry[], from: number, step: 1 | -1): number {
  const count = entries.length;
  const start = from < 0 && step < 0 ? count : from;
  for (let offset = 1; offset <= count; offset++) {
    const index = (((start + step * offset) % count) + count) % count;
    const entry = entries[index];
    if (isMenuItem(entry) && !entry.disabled) return index;
  }
  return -1;
}

/** Entfernt Trennlinien am Anfang, am Ende und doppelte hintereinander. */
export function tidySeparators<Id extends string, Icon extends string>(
  entries: readonly MenuEntry<Id, Icon>[],
): MenuEntry<Id, Icon>[] {
  const tidy: MenuEntry<Id, Icon>[] = [];
  for (const entry of entries) {
    if (entry === SEPARATOR && (tidy.length === 0 || tidy[tidy.length - 1] === SEPARATOR)) continue;
    tidy.push(entry);
  }
  if (tidy[tidy.length - 1] === SEPARATOR) tidy.pop();
  return tidy;
}
