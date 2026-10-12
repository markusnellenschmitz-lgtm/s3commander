# S3 Commander

**Ein schneller, nativer Windows-Client für Amazon S3 und jeden S3-kompatiblen Object Storage.**

S3 Commander fühlt sich an wie ein Dateimanager, nicht wie ein Web-Dashboard: Tabs, Zwei-Panel-Ansicht,
Drag and Drop, Tastatursteuerung und eine Objektliste, die auch Buckets mit Millionen von Objekten
flüssig darstellt. Die App ist eine einzelne, rund 15 MB große EXE und braucht weder .NET noch Java
oder eine andere Laufzeitumgebung.

> _English summary:_ S3 Commander is a fast, native Windows 11 desktop client for Amazon S3 and any
> S3-compatible storage (MinIO, Cloudflare R2, Backblaze B2, Wasabi, Hetzner, Ceph, Garage, …).
> Built with Rust, Tauri 2 and Svelte 5. The user interface is currently German only. MIT licensed.

[![CI](https://github.com/markusnellenschmitz-lgtm/s3commander/actions/workflows/ci.yml/badge.svg)](https://github.com/markusnellenschmitz-lgtm/s3commander/actions/workflows/ci.yml)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-blue.svg)](LICENSE)

## Download

Fertige Versionen gibt es unter **[Releases](https://github.com/markusnellenschmitz-lgtm/s3commander/releases)**:

| Datei                                     | Für wen                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `S3 Commander_<version>_x64-setup.exe`    | Installer (empfohlen): Startmenü-Eintrag, Deinstallation, installiert bei Bedarf WebView2 |
| `S3-Commander_<version>_x64-portable.exe` | Portable EXE ohne Installation, einfach starten                                           |

**Voraussetzungen:** Windows 10 oder 11 (64 Bit). Die portable EXE braucht die Microsoft Edge
WebView2 Runtime, die unter Windows 11 bereits vorhanden ist.

> **Hinweis zu SmartScreen:** Die Releases sind (noch) nicht code-signiert. Windows zeigt deshalb beim
> ersten Start „Der Computer wurde durch Windows geschützt“. Über _Weitere Informationen › Trotzdem
> ausführen_ lässt sich die App starten. Wer sichergehen will, baut sie selbst aus dem Quellcode (siehe unten).

## Funktionen

**Verbindungen**

- Vorlagen für AWS S3, MinIO, Backblaze B2, Cloudflare R2, Wasabi, Hetzner, Ceph, Garage und beliebige
  eigene Endpoints; Vorlage und Region werden aus der Endpoint-URL erkannt.
- Path-Style oder Virtual-Hosted-Adressierung, Proxy, eigene Stammzertifikate, Session-Token.
- Mehrere Verbindungen gleichzeitig im Verbindungsbaum, Tabs je Bucket (Strg+T / Strg+W / Strg+Tab).

**Durchsuchen**

- Virtuelle Objektliste für Millionen Einträge mit Sortierung, Mehrfachauswahl und Tastatursteuerung.
- Gestreamtes Listing mit Abbruch; ein lokaler SQLite-Cache zeigt bekannte Ordner sofort an und
  aktualisiert sie im Hintergrund.
- Suche mit Platzhaltern und Filter nach Typ, Größe und Datum.
- Zwei-Panel-Ansicht: links der lokale Rechner, rechts der Bucket, Dateien per Maus hin und her ziehen.

**Übertragen**

- Uploads und Downloads parallel und in Teilen (Multipart / Range-Requests), direkt von und auf die Platte.
- Pausieren und Fortsetzen, automatische Wiederholung bei vorübergehenden Fehlern.
- Bandbreitenlimit, einstellbare Parallelität und Teilgröße.
- Drag and Drop aus dem Windows-Explorer, auch ganze Ordner.
- Kopieren und Verschieben (Strg+C / Strg+X / Strg+V) serverseitig innerhalb einer Verbindung und
  auch zwischen verschiedenen Verbindungen oder Anbietern.
- Prüfsummen: Uploads prüft der Dienst per CRC32C oder MD5, Downloads werden gegen den ETag geprüft.
- Abgleich (Sync) zwischen lokalem Ordner und Bucket in beide Richtungen, mit Vorschau. Lokal wird nie gelöscht.

**Verwalten**

- Neuer Ordner, Umbenennen (F2), Löschen mit Vorschau, auch für große Mengen in Paketen.
- Eigenschaften (Alt+Enter): Metadaten bearbeiten, Tags, Versionen, Zugriffsrechte (ACL),
  Verschlüsselung und vorsignierte Links zum Teilen.

**Oberfläche**

- Helles und dunkles Design (folgt auf Wunsch Windows), kompakte Zeilenhöhe, ausblendbare Spalten.

### Tastenkürzel

| Kürzel                     | Aktion                                   |
| -------------------------- | ---------------------------------------- |
| Enter / Rücktaste          | Ordner öffnen / eine Ebene höher         |
| Alt+← / Alt+→ / Alt+↑      | Zurück / Vor / Übergeordneter Ordner     |
| F5                         | Neu laden (immer frisch vom Server)      |
| Strg+F                     | Suchen                                   |
| Strg+U / Strg+D            | Hochladen / Herunterladen                |
| Strg+C / Strg+X / Strg+V   | Kopieren / Ausschneiden / Einfügen       |
| F2 / Entf                  | Umbenennen / Löschen                     |
| Alt+Enter                  | Eigenschaften                            |
| Strg+T / Strg+W / Strg+Tab | Neuer Tab / Tab schließen / Tab wechseln |
| Strg+J                     | Transfer-Panel ein- und ausblenden       |
| Strg+,                     | Einstellungen                            |

## Sicherheit und Datenschutz

- **Zugangsdaten** liegen ausschließlich in der Windows-Anmeldeinformationsverwaltung (Credential Manager),
  nie in Konfigurationsdateien oder Logs.
- **TLS** läuft über SChannel, also den Windows-eigenen TLS-Stack. Es gilt der Windows-Zertifikatspeicher,
  Firmen-Stammzertifikate funktionieren ohne Zusatzaufwand.
- **Kein AWS-SDK, keine Telemetrie.** Die App spricht direkt mit der S3-REST-API und schickt nichts an
  Dritte. Die Signatur (AWS Signature V4) ist selbst implementiert und gegen die offiziellen
  AWS-Testvektoren geprüft.
- Einstellungen und der Listing-Cache liegen unter `%LOCALAPPDATA%\app.s3commander\`;
  der Cache lässt sich in den Einstellungen abschalten und leeren.

Sicherheitslücken bitte nicht als öffentliches Issue melden, sondern über
[GitHub Security Advisories](https://github.com/markusnellenschmitz-lgtm/s3commander/security/advisories/new).

## Selbst bauen

**Voraussetzungen**

- Windows 10/11 mit den [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  (Workload „Desktopentwicklung mit C++“)
- [Rust](https://rustup.rs/) 1.90 oder neuer
- [Node.js](https://nodejs.org/) 24 oder neuer

**Bauen und starten**

```
git clone https://github.com/markusnellenschmitz-lgtm/s3commander.git
cd s3commander
npm ci
npm run tauri dev      # Entwicklungsmodus mit Hot Reload
npm run tauri build    # Release: EXE und Installer unter src-tauri/target/release/
```

Nur die Oberfläche lässt sich mit `npm run dev` im Browser starten. Sie läuft dann gegen ein
Fake-Backend mit Testdaten, ganz ohne S3-Zugang.

**Tests**

```
npm run lint && npm run test:coverage       # Frontend: ESLint, svelte-check, Vitest
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test   # Backend
```

Der S3-Adapter wird gegen einen HTTP-Mock getestet. Optionale Live-Tests gegen einen echten Bucket
beschreibt [CONTRIBUTING.md](CONTRIBUTING.md).

## Technik

| Bereich    | Umsetzung                                                                    |
| ---------- | ---------------------------------------------------------------------------- |
| Backend    | Rust, Tauri 2, hexagonale Architektur (Ports & Adapters)                     |
| S3         | Eigene REST-Implementierung mit SigV4, `reqwest` mit `native-tls` (SChannel) |
| Cache      | SQLite (eingebaut über `rusqlite`)                                           |
| Frontend   | Svelte 5, TypeScript, reines CSS, MVVM mit View-Models                       |
| Oberfläche | WebView2 (Teil von Windows 11)                                               |
| Tests      | `cargo test` mit wiremock, Vitest mit Testing Library                        |

Aufbau, Regeln und Werkzeuge im Detail: [CONTRIBUTING.md](CONTRIBUTING.md).
Geplante Funktionen: [docs/FEATURE-BOARD.md](docs/FEATURE-BOARD.md).

## Neue Version veröffentlichen

1. Version in `package.json`, `src-tauri/Cargo.toml` und `src-tauri/tauri.conf.json` erhöhen.
2. Tag setzen und pushen: `git tag v0.2.0 && git push origin v0.2.0`.
3. GitHub Actions baut Installer und portable EXE und legt einen Release-Entwurf an. Dort Text prüfen
   und auf _Publish release_ klicken.

## Status

S3 Commander ist jung (Version 0.x). Die Kernfunktionen sind umfassend automatisiert getestet, aber
noch wenig im Alltag gegen alle Anbieter erprobt. Bitte wichtige Daten nicht ohne Sicherung bewegen und
Probleme gern als [Issue](https://github.com/markusnellenschmitz-lgtm/s3commander/issues) melden.

## Lizenz

[MIT](LICENSE) © 2026 S3 Commander contributors

Icons: [Lucide](https://lucide.dev) (ISC-Lizenz). „Amazon S3“ ist eine Marke von Amazon.com, Inc.;
dieses Projekt steht in keiner Verbindung zu Amazon.
