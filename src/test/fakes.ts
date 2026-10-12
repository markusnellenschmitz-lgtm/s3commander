// Test-Doubles, die in mehreren Testdateien gebraucht werden.

import type { RowSource } from '../lib/core/table/types';
import type { S3Entry } from '../lib/features/objects/entry';

/** Einfache Quelle über eine Liste von Schlüsseln; Zeile = Schlüssel. */
export class KeyListSource implements RowSource<string> {
  version = 0;
  #keys: string[];

  constructor(keys: string[]) {
    this.#keys = keys;
  }

  static ofSize(n: number, prefix = 'k'): KeyListSource {
    return new KeyListSource(Array.from({ length: n }, (_, i) => `${prefix}${i}`));
  }

  get length(): number {
    return this.#keys.length;
  }

  get(index: number): string | undefined {
    return this.#keys[index];
  }

  keyAt(index: number): string | undefined {
    return this.#keys[index];
  }

  indexOfKey(key: string): number {
    return this.#keys.indexOf(key);
  }

  /** Simuliert Umsortieren. */
  reverse(): void {
    this.#keys = [...this.#keys].reverse();
    this.version++;
  }
}

export function file(name: string, overrides: Partial<S3Entry> = {}): S3Entry {
  return {
    key: `p/${name}`,
    name,
    isPrefix: false,
    size: 100,
    lastModified: 0,
    storageClass: 'STANDARD',
    ...overrides,
  };
}

export function folder(name: string): S3Entry {
  return { key: `p/${name}/`, name: `${name}/`, isPrefix: true };
}

/** Setzt die von jsdom immer mit 0 gemeldete Elementhöhe für die Dauer eines Tests. */
export function mockClientHeight(height: number): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => height });
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
  };
}
