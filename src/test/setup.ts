import '@testing-library/jest-dom/vitest';

// jsdom kennt keinen ResizeObserver. Svelte nutzt ihn für bind:clientHeight und
// liest den Startwert zusätzlich direkt aus dem Element; ein leerer Ersatz genügt.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom kennt kein matchMedia.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
