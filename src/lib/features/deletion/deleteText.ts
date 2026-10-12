// Texte des Löschdialogs. Destruktive Aktionen nennen Ziel und Menge (DESIGN-SYSTEM.md).

import type { DeleteOutcome, DeletePreview, DeleteProgress, ObjectSelection } from '../../core/backend';
import { formatBytes, formatCount } from '../../core/format';
import { objectCountText } from '../objects/statusText';

/** Letztes Segment eines Keys, Ordner mit "/". */
function displayName(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return key.endsWith('/') ? `${name}/` : name;
}

/** "„daily/“ löschen?" oder "3 Einträge löschen?" */
export function deleteTitle(selection: ObjectSelection): string {
  const [first] = selection.items;
  return selection.items.length === 1
    ? `„${displayName(first.key)}“ löschen?`
    : `${formatCount(selection.items.length)} Einträge löschen?`;
}

/** "4.210 Objekte (38,6 GiB) in prod-backups-eu/backups/ werden endgültig gelöscht." */
export function deleteSummary(preview: DeletePreview, selection: ObjectSelection): string {
  if (preview.objects === 0) return 'Hier gibt es keine Objekte zu löschen.';
  const target = `${selection.folder.bucket}/${selection.folder.prefix}`;
  const finality = preview.versioned === false ? 'endgültig ' : '';
  const verb = preview.objects === 1 ? 'wird' : 'werden';
  return `${objectCountText(preview.objects, 0)} (${formatBytes(preview.bytes)}) in ${target} ${verb} ${finality}gelöscht.`;
}

/** Hinweis zu älteren Versionen; null, wenn der Bucket nicht versioniert ist. */
export function versionNote(preview: DeletePreview): string | null {
  if (preview.versioned === true) {
    return 'Der Bucket ist versioniert: Ältere Versionen bleiben erhalten und lassen sich wiederherstellen.';
  }
  return preview.versioned === null ? 'Ob ältere Versionen erhalten bleiben, ließ sich nicht prüfen.' : null;
}

/** "1.000 von 4.210 gelöscht" */
export function progressText(progress: DeleteProgress): string {
  return `${formatCount(progress.processed)} von ${formatCount(progress.total)} gelöscht`;
}

/** Ganzzahliger Fortschritt in Prozent; ohne Objekte 100. */
export function progressPercent(progress: DeleteProgress): number {
  return progress.total > 0 ? Math.floor((progress.processed / progress.total) * 100) : 100;
}

/** Ergebnis, wenn nicht alles glatt ging: abgebrochen oder einzelne Keys abgelehnt. */
export function outcomeText(outcome: DeleteOutcome): string {
  const deleted = `${objectCountText(outcome.deleted, 0)} gelöscht`;
  if (outcome.cancelled) return `Abgebrochen. ${deleted}.`;
  return `${deleted}, ${formatCount(outcome.failedCount)} nicht gelöscht.`;
}
