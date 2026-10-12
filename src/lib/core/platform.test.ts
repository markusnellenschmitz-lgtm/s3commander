import { describe, expect, it } from 'vitest';
import { credentialStoreName, detectPlatform, hasShareSheet } from './platform';

const WEBVIEW2 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const WEBKITGTK =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('Plattform', () => {
  it('erkennt Windows und Linux am User-Agent der WebView', () => {
    expect(detectPlatform(WEBVIEW2)).toBe('windows');
    expect(detectPlatform(WEBKITGTK)).toBe('linux');
  });

  it('nennt den Speicher für Zugangsdaten und ob es einen Teilen-Dialog gibt', () => {
    expect(credentialStoreName('windows')).toBe('Windows-Anmeldeinformationsspeicher');
    expect(credentialStoreName('linux')).toBe('Schlüsselbund des Systems');
    expect([hasShareSheet('windows'), hasShareSheet('linux')]).toEqual([true, false]);
  });
});
