import { describe, expect, it, vi } from 'vitest';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { createNoFileDrop, createTauriFileDrop, toFileDropEvent } from './fileDrop';
import type { FileDropEvent } from '../core/backend';

describe('toFileDropEvent', () => {
  const position = new PhysicalPosition(300, 150);

  it('rechnet physische in CSS-Pixel um und übernimmt Pfade', () => {
    expect(toFileDropEvent({ type: 'enter', paths: ['C:\\a'], position }, 1.5)).toEqual({
      type: 'enter',
      paths: ['C:\\a'],
      x: 200,
      y: 100,
    });
    expect(toFileDropEvent({ type: 'drop', paths: ['C:\\b'], position }, 1)).toMatchObject({
      paths: ['C:\\b'],
      x: 300,
    });
  });

  it('liefert für over keine Pfade und für leave keine Position', () => {
    expect(toFileDropEvent({ type: 'over', position }, 2)).toEqual({ type: 'over', paths: [], x: 150, y: 75 });
    expect(toFileDropEvent({ type: 'leave' }, 2)).toEqual({ type: 'leave', paths: [], x: 0, y: 0 });
  });
});

describe('Drop-Adapter', () => {
  it('abonniert die Drops der WebView und rechnet mit dem Skalierungsfaktor', async () => {
    const unlisten = vi.fn();
    const onDragDropEvent = vi.fn().mockResolvedValue(unlisten);
    const port = createTauriFileDrop(
      () => ({ onDragDropEvent }),
      () => 2,
    );
    const events: FileDropEvent[] = [];
    expect(await port.onFileDrop((e) => events.push(e))).toBe(unlisten);
    onDragDropEvent.mock.calls[0][0]({ payload: { type: 'over', position: new PhysicalPosition(40, 20) } });
    expect(events).toEqual([{ type: 'over', paths: [], x: 20, y: 10 }]);
  });

  it('nutzt ohne Angabe den Skalierungsfaktor des Fensters', async () => {
    const onDragDropEvent = vi.fn().mockResolvedValue(() => {});
    const port = createTauriFileDrop(() => ({ onDragDropEvent }));
    const events: FileDropEvent[] = [];
    await port.onFileDrop((e) => events.push(e));
    onDragDropEvent.mock.calls[0][0]({ payload: { type: 'over', position: new PhysicalPosition(10, 10) } });
    expect(events[0].x).toBe(10 / (window.devicePixelRatio || 1));
  });

  it('liefert im Browser keine Ereignisse', async () => {
    const unsubscribe = await createNoFileDrop().onFileDrop(() => {
      throw new Error('darf nicht aufgerufen werden');
    });
    expect(unsubscribe()).toBeUndefined();
  });
});
