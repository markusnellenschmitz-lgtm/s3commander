// Adapter für Datei-Drops aus dem Windows-Explorer.
// Tauri meldet Positionen in physischen Pixeln; die Oberfläche rechnet in CSS-Pixeln.

import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import type { FileDropEvent, FileDropPort } from '../core/backend';

type DropSource = Pick<ReturnType<typeof getCurrentWebview>, 'onDragDropEvent'>;

/** Wandelt ein Tauri-Ereignis um; `scale` ist das Verhältnis physischer zu CSS-Pixeln. */
export function toFileDropEvent(payload: DragDropEvent, scale: number): FileDropEvent {
  if (payload.type === 'leave') return { type: 'leave', paths: [], x: 0, y: 0 };
  const paths = payload.type === 'over' ? [] : payload.paths;
  return { type: payload.type, paths, x: payload.position.x / scale, y: payload.position.y / scale };
}

export function createTauriFileDrop(
  webview: () => DropSource = getCurrentWebview,
  scale: () => number = () => window.devicePixelRatio || 1,
): FileDropPort {
  return {
    onFileDrop: (listener) => webview().onDragDropEvent((event) => listener(toFileDropEvent(event.payload, scale()))),
  };
}

/** Browser-Vorschau: HTML5-Drops liefern keine Dateipfade, daher gibt es hier keine Ereignisse. */
export function createNoFileDrop(): FileDropPort {
  return { onFileDrop: async () => () => {} };
}
