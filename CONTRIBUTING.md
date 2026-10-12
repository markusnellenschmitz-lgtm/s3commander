# Mitwirken an S3 Commander

Danke für dein Interesse! Fehlerberichte, Ideen und Pull Requests sind willkommen. Damit der Code
lange wartbar bleibt, gelten ein paar feste Regeln. Dokumentation und UI-Texte sind auf Deutsch,
Code-Bezeichner auf Englisch.

## Verbindliche Regeln

1. **Clean Code.** Kleine Funktionen mit einer Aufgabe, sprechende Namen, keine Seiteneffekte in Abfragen,
   keine magischen Zahlen ohne benannte Konstante.
2. **Kein doppelter Code.** Vor neuem Code nach vorhandenen Helfern suchen. Gemeinsame Logik extrahieren, nie kopieren.
3. **Architektur konsequent einhalten** (siehe unten). Abhängigkeiten zeigen immer nach innen.
4. **Tests für alles.** Kein Code ohne Test. Ein Fehler wird zuerst mit einem fehlschlagenden Test nachgestellt,
   dann behoben.
5. **Design-System ist verbindlich.** `src/lib/styles/tokens.css` und `components.css` entsprechen 1:1 den Vorlagen
   unter `design/s3-client-ui-handoff/design/` (Spezifikation: `design/s3-client-ui-handoff/docs/UI-SPEC.md`).
   Ergänzungen nur in `src/lib/styles/fixes.css`.

## Architektur

### Backend (Rust): Hexagonale Architektur (Ports & Adapters)

```
src-tauri/src/
  domain/        Reine Typen und Regeln (Teilgrößen, Pfade, Fehler). Kein IO, keine Abhängigkeit nach außen.
  application/   Anwendungsfälle (Listing, Upload, Download, Sync). Sprechen nur mit Ports.
  ports/         Traits: ObjectStore, ListingCache, CredentialStore, Clock, FileSystem.
  adapters/      Implementierungen: S3 über HTTP (SigV4), SQLite-Cache, Windows Credential Manager,
                 lokales Dateisystem. Treibender Adapter: Tauri-Commands und Events.
  lib.rs         Komposition: verdrahtet Adapter mit Anwendungsfällen.
```

Tests: `domain` und `application` mit Unit-Tests und Fake-Ports (`application/test_support.rs`).
Der S3-Adapter wird in `src-tauri/tests/` gegen einen S3-Mock (wiremock) getestet, die Signatur
gegen die offiziellen AWS-Testvektoren.

Backend-Regeln:

- Kein AWS-SDK: S3-REST-API mit eigener SigV4-Signatur (`adapters/s3/sigv4.rs`).
- TLS über SChannel (`native-tls`), damit der Windows-Zertifikatspeicher gilt.
- Zugangsdaten nur im Windows-Anmeldeinformationsspeicher (`adapters/credential_store.rs`), nie in Dateien oder Logs.
- Clippy mit `pedantic` und `-D warnings`; `unwrap`/`expect` nur in Tests.
- Bei wenig freiem Arbeitsspeicher mit `CARGO_BUILD_JOBS=2` bauen.

### Frontend (Svelte): Schichten mit View-Models (MVVM)

```
src/
  App.svelte          Kompositionswurzel: erzeugt Adapter und View-Models, rendert Features.
  lib/core/           Reine Logik ohne DOM und IO (Formatierung, Viewport-Mathe, Auswahlmodell,
                      Tabellen-Controller). Runes erlaubt, Browser-APIs nicht.
  lib/features/<x>/   Fachliche Features. <name>ViewModel.svelte.ts = View-Model (Zustand + Logik, ohne DOM testbar),
                      *.svelte = Ansicht des Features.
  lib/ui/             Wiederverwendbare, rein darstellende Komponenten (DataTable, Icons).
                      Logik gehört in core oder in ein View-Model, nicht in die Komponente.
  lib/infrastructure/ Adapter zu Browser und Tauri (localStorage, matchMedia, IPC) hinter
                      Interfaces aus core bzw. features. In Tests durch Fakes ersetzt.
  lib/styles/         tokens.css, components.css (Design-System, 1:1), fixes.css, layout.css.
```

Abhängigkeitsrichtung: `ui` und `features` → `core`; `infrastructure` implementiert Interfaces aus
`core`/`features`; nur `App.svelte` kennt `infrastructure`.

Im normalen Browser (`npm run dev`) und in Tests läuft die Oberfläche gegen `infrastructure/fakeBackend.ts`
mit Testdaten; in Tauri gegen `infrastructure/tauriBackend.ts`. Die gemeinsame Schnittstelle ist
`lib/core/backend.ts` und spiegelt `src-tauri/src/adapters/commands.rs`.

### Performance-Regeln für Listen

- Virtuelle Listen rendern Zeilen ohne `{#each}`-Schlüssel über eine versionsabhängige abgeleitete Liste.
- Icons in Zeilen nur über das Sprite (`<svg><use href="#i-…"/></svg>`), keine Icon-Komponenten.
- Große Datenmengen in typisierten Arrays oder im Backend halten, Zeilenobjekte erst beim Anzeigen erzeugen.
- Datenquellen nutzen normale `Map`/`Set` und melden Änderungen über einen `$state`-Versionszähler,
  keine `SvelteMap`/`SvelteSet` (ESLint-Regel `svelte/prefer-svelte-reactivity` ist deshalb aus).
- Jede Lint-Ausnahme im Code bekommt einen Kommentar mit Begründung.

## Werkzeuge

| Befehl                        | Zweck                                                                  |
| ----------------------------- | ---------------------------------------------------------------------- |
| `npm run tauri dev`           | App im Entwicklungsmodus                                               |
| `npm run tauri build`         | Release-EXE und Installer                                              |
| `npm run dev`                 | Nur die Oberfläche im Browser, gegen das Fake-Backend                  |
| `npm test`                    | Alle Frontend-Tests (Vitest)                                           |
| `npm run test:coverage`       | Tests mit Abdeckungsbericht und Schwellen                              |
| `npm run lint`                | ESLint + svelte-check                                                  |
| `npm run format`              | Prettier                                                               |
| `npm run icons`               | SVG-Sprite aus Lucide neu erzeugen                                     |
| `cargo test` / `cargo clippy` | Backend-Tests und Lints (in `src-tauri/`)                              |
| `cargo test --test live_s3`   | Live-Tests gegen einen echten Bucket; braucht `src-tauri/.live-s3.env` |

Frontend-Tests liegen neben dem Code als `*.test.ts`, Komponenten-Tests nutzen `@testing-library/svelte`.

Für die Live-Tests `src-tauri/.live-s3.env.example` nach `.live-s3.env` kopieren und mit Zugangsdaten
eines **Test-Buckets** füllen. Diese Datei ist in `.gitignore` eingetragen und darf nie eingecheckt werden.

## Vor einem Pull Request

```
npm run lint
npm run format:check
npm run test:coverage
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Die GitHub-Actions-Pipeline führt dieselben Prüfungen aus.

## Feature-Board

Planung und Stand der Features stehen in `docs/FEATURE-BOARD.md`. Neue Wünsche gern als Issue.
