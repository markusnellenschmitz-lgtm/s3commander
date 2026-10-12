/** Deterministische Pseudo-Hexfolge für realistische ETags in Testdaten (wie im Prototyp). */
export function pseudoHex(seed: number, length: number): string {
  let x = Math.imul(seed + 7, 2654435761) >>> 0;
  let out = '';
  while (out.length < length) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += (x >>> 8).toString(16).padStart(6, '0');
  }
  return out.slice(0, length);
}
