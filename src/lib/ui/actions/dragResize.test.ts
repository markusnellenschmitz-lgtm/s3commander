import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_CLASS, dragResize } from './dragResize';

function setup() {
  const parent = document.createElement('div');
  parent.getBoundingClientRect = () => ({ width: 100 }) as DOMRect;
  const handle = document.createElement('span');
  parent.append(handle);
  const onresize = vi.fn();
  const action = dragResize(handle, { onresize })!;
  return { handle, onresize, action };
}

const pointer = (type: string, clientX = 0) => new MouseEvent(type, { clientX, bubbles: true, cancelable: true });

describe('dragResize', () => {
  it('meldet die neue Breite relativ zur Startbreite', () => {
    const { handle, onresize } = setup();
    handle.dispatchEvent(pointer('pointerdown', 50));
    expect(handle).toHaveClass(ACTIVE_CLASS);
    handle.dispatchEvent(pointer('pointermove', 80));
    expect(onresize).toHaveBeenLastCalledWith(130);
    handle.dispatchEvent(pointer('pointerup'));
    expect(handle).not.toHaveClass(ACTIVE_CLASS);
    handle.dispatchEvent(pointer('pointermove', 200));
    expect(onresize).toHaveBeenCalledTimes(1);
  });

  it('nutzt nach update den neuen Callback', () => {
    const { handle, action } = setup();
    const next = vi.fn();
    action.update?.({ onresize: next });
    handle.dispatchEvent(pointer('pointerdown', 0));
    handle.dispatchEvent(pointer('pointermove', 10));
    expect(next).toHaveBeenCalledWith(110);
  });

  it('ignoriert Griffe ohne Elternelement und reagiert nach destroy nicht mehr', () => {
    const handle = document.createElement('span');
    const onresize = vi.fn();
    const action = dragResize(handle, { onresize })!;
    handle.dispatchEvent(pointer('pointerdown'));
    expect(handle).not.toHaveClass(ACTIVE_CLASS);
    action.destroy?.();
    const { handle: h2, action: a2, onresize: r2 } = setup();
    a2.destroy?.();
    h2.dispatchEvent(pointer('pointerdown'));
    h2.dispatchEvent(pointer('pointermove', 5));
    expect(r2).not.toHaveBeenCalled();
  });
});
