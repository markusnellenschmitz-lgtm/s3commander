// Svelte-Action: horizontales Ziehen an einem Griff. Meldet die neue Breite des
// Elternelements (Spaltenkopf). Begrenzung und Speicherung übernimmt der Aufrufer.

import type { Action } from 'svelte/action';

export interface DragResizeOptions {
  onresize: (width: number) => void;
}

export const ACTIVE_CLASS = 'is-active';

export const dragResize: Action<HTMLElement, DragResizeOptions> = (handle, initial) => {
  let options = initial;

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const parent = handle.parentElement;
    if (!parent) return;
    const startX = e.clientX;
    const startWidth = parent.getBoundingClientRect().width;
    handle.setPointerCapture?.(e.pointerId);
    handle.classList.add(ACTIVE_CLASS);

    const onMove = (ev: PointerEvent) => options.onresize(startWidth + ev.clientX - startX);
    const onUp = () => {
      handle.classList.remove(ACTIVE_CLASS);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  handle.addEventListener('pointerdown', onPointerDown);
  return {
    update(next) {
      options = next;
    },
    destroy() {
      handle.removeEventListener('pointerdown', onPointerDown);
    },
  };
};
