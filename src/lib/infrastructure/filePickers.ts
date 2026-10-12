// Adapter für die Datei- und Ordnerauswahl: Windows-Dialoge in Tauri, feste Beispiele im Browser.

import { open } from '@tauri-apps/plugin-dialog';
import type { FilePickerPort } from '../core/backend';

type Open = typeof open;

export function createTauriFilePicker(openDialog: Open = open): FilePickerPort {
  return {
    async pickFiles() {
      const picked = await openDialog({ multiple: true, directory: false, title: 'Dateien hochladen' });
      if (picked === null) return [];
      return Array.isArray(picked) ? picked : [picked];
    },
    async pickFolder() {
      const picked = await openDialog({ multiple: false, directory: true, title: 'Zielordner wählen' });
      return typeof picked === 'string' ? picked : null;
    },
  };
}

/** Beispieldateien für die Browser-Vorschau; Größen erzeugt das Fake-Backend aus dem Namen. */
export const FAKE_PICKED_FILES = [
  'D:\\Exporte\\media-export-2026-10.zip',
  'D:\\Backups\\db-prod\\db-incr-20261012-0600.tar.zst',
  'D:\\Backups\\db-prod\\fehler-test.log',
];

export const FAKE_TARGET_FOLDER = 'D:\\Downloads';

/** `folder` null spielt einen abgebrochenen Ordnerdialog nach. */
export function createFakeFilePicker(
  files: string[] = FAKE_PICKED_FILES,
  folder: string | null = FAKE_TARGET_FOLDER,
): FilePickerPort {
  return { pickFiles: async () => [...files], pickFolder: async () => folder };
}
