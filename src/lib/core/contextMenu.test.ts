import { describe, expect, it, vi } from 'vitest';
import { ContextMenuController } from './contextMenu.svelte';
import { SEPARATOR } from './menu';

describe('ContextMenuController', () => {
  it('zeigt Einträge an einer Position, schließt und führt Aktionen aus', () => {
    const open = vi.fn();
    const menu = new ContextMenuController<'open', 'folder'>({ open });
    expect(menu.state).toBeNull();
    const entries = [{ id: 'open' as const, label: 'Öffnen', icon: 'folder' as const }, SEPARATOR];
    menu.show(3, 4, entries);
    expect(menu.state).toEqual({ x: 3, y: 4, entries });
    menu.run('open');
    expect(open).toHaveBeenCalledOnce();
    expect(menu.state).toBeNull();
    menu.show(1, 1, entries);
    menu.close();
    expect(menu.state).toBeNull();
  });
});
