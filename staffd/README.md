# staffd — JARVIS OS Staff-Board-Daemon

Dauerlaeufer, der Hermes (Kanban, Agent-Profile, Token-Verbrauch, Watchdog) mit dem
Supabase-Schema `staff` verbindet. Vertrag: `../CONTRACT.md`, Abschnitte 8–10.

Reines Python 3.14, ausschliesslich Standardbibliothek, keine Installation noetig.

## Dateien

| Datei | Zweck |
|---|---|
| `staffd.py` | Daemon (ein Durchlauf alle 5 s, Watchdog 60 s, Metriken 300 s) |
| `com.jarvis.staffd.plist` | launchd-Job `com.jarvis.staffd` |
| `README.md` | diese Datei |

Laufzeitdaten (nicht im Repo):

* `~/.jarvis-os/secrets.env` — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STAFF_AGENT_EMAIL`, `STAFF_AGENT_PASSWORD` (chmod 600, wird nur gelesen)
* `~/.jarvis-os/staffd.log` — eine Zeile pro Lauf, Rotation bei > 5 MB nach `staffd.log.1`
* `~/.jarvis-os/staffd_state.json` — Access-/Refresh-Token, Zeitstempel der Intervalle, letzter Check-Status (chmod 600)

## Betrieb

```sh
# Testlauf: genau ein Durchlauf, danach Exit 0 (bzw. 1 bei Fehlern)
python3 staffd/staffd.py --once

# Dauerbetrieb von Hand
python3 staffd/staffd.py

# Installation als launchd-Job (macht der Betreiber, nicht der Daemon selbst)
cp staffd/com.jarvis.staffd.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.staffd.plist
launchctl print gui/$(id -u)/com.jarvis.staffd | head -20
# Deinstallation
launchctl bootout gui/$(id -u)/com.jarvis.staffd
```

Log live: `tail -f ~/.jarvis-os/staffd.log`

Die Plist startet den Daemon bei Login (`RunAtLoad`) und haelt ihn am Leben
(`KeepAlive`, `ThrottleInterval` 30 s). `PATH` fuehrt `/usr/local/bin` vor `/usr/bin`,
weil `/usr/bin/python3` unter macOS 3.9 ist und der Vertrag 3.14 verlangt; das
Hermes-CLI liegt ebenfalls im `PATH`, damit `hermes kanban`/`hermes cron` gefunden werden.

## Was ein Durchlauf tut

Jede Teilaufgabe ist einzeln abgesichert: eine Ausnahme beendet den Lauf nicht, sondern
schreibt eine `incidents`-Zeile mit `severity=warn` und macht mit der naechsten Aufgabe
weiter. Fehler stehen zusaetzlich im Log (`step_failed ...`).

1. **Auth** — Passwort-Grant gegen `/auth/v1/token`, Token im State gecacht; bei < 5 min
   Restzeit Refresh-Grant, bei Fehlschlag Neuanmeldung. Alle PostgREST-Aufrufe mit
   `Accept-Profile: staff`, `Content-Profile: staff`, `apikey` = ANON_KEY,
   `Authorization: Bearer <Agent-JWT>`.
2. **`rpc/expire_approvals`** — abgelaufene Freigaben nach Standard-Entscheidung schliessen.
3. **Anweisungen** — `instructions` mit `status=queued` → `taken` → Kanban-Karte auf Board
   `savood` (`hermes kanban --board savood create --title … --assignee … --body … --json`)
   → `status=done`, `result` = Karten-ID. Fehler → `status=failed`, `result` = Fehlertext.
4. **Freigaben** — `approvals` mit `status=approved` und `applied_at is null`:
   * `kind=subagents`: Anzahl Karten = `cost_tokens/1000`, geklemmt auf 1…5, zugewiesen an
     `requested_by`; danach `rpc/mark_approval_applied`.
   * andere Arten: `events`-Eintrag + `rpc/mark_approval_applied`.
   Ohne `mark_approval_applied` wuerde derselbe Datensatz alle 5 s erneut Karten erzeugen,
   deshalb wird auch der Subagent-Fall als ausgefuehrt markiert.
5. **Kanban-Spiegelung** — `hermes kanban --board savood list --json`, maximal 40 Karten je
   Lauf, neueste zuerst. Upsert ueber `kanban_id` (die Tabelle hat keinen Unique-Index,
   daher SELECT → PATCH bzw. INSERT). Statusabbildung: `triage|todo→todo`,
   `scheduled→scheduled`, `ready|running→running`, `review→review`, `blocked→blocked`,
   `done→done`; `progress` folgt dem Status (0/25/50/75/100), `started_at`/`finished_at`
   aus der Karte. `agent_key` nur, wenn der Assignee ein bekannter Agent ist.
6. **Heartbeats** — sechs Zeilen (Upsert auf `agent_key`): `last_seen=now()`,
   `status` aus den Karten des Agents (`running` → `running`, `blocked`/`review` →
   `waiting`, sonst `idle`), `tokens_today` und `cost_eur_today` aus den Hermes-DBs
   (siehe unten), `meta` mit Karten-/Quellhinweisen.
7. **Watchdog** (alle 60 s) — fuenf Checks, alle Zeilen gemeinsam in `staff.watchdog_checks`:

   | Check | Kriterium | Status bei Problem |
   |---|---|---|
   | `hub` | `GET http://127.0.0.1:8000/healthz`, Timeout 2 s | `fail` → Incident `critical`, einmaliger `launchctl kickstart gui/<uid>/com.jarvis.briefinghub` (fruehestens alle 10 min), `action_taken` gesetzt |
   | `provider` | `GET https://api.oneprovider.dev/v1/models` mit Key aus `~/.hermes/.env` | `fail` |
   | `cron` | `hermes cron list`, Suche nach `error:` / `not delivered` je Job-Block | `warn` |
   | `disk` | freier Platz auf `/` | `warn` unter 10 % (per `settings.watchdog.disk_warn_percent` aenderbar) |
   | `staffd` | Selbstcheck des Laufs | `warn` bei Teilfehlern |

   Statuswechsel `ok → fail` erzeugt zusaetzlich eine `incidents`-Zeile (`critical`,
   `needs_jan=true`, ausser der Hub-Kickstart lief erfolgreich) und ein `events`-Eintrag.
8. **Metriken** (alle 300 s) — je Agent eine Zeile in `staff.metrics_hourly`
   (Upsert auf `hour,agent_key`): Tokens des Stundenfensters, `tasks_done` aus Karten mit
   `completed_at` in dieser Stunde, `cost_eur` = Tokens × `rate_eur_per_mtok` / 1e6
   (Default 0,14 €/Mio, ueberschreibbar ueber `settings.rate_eur_per_mtok`).

## Tokenquellen

`jarvis` → `~/.hermes/state.db`, alle anderen Agenten → `~/.hermes/profiles/<key>/state.db`,
jeweils **nur lesend** (`file:…?mode=ro` + `PRAGMA query_only`). Gezaehlt werden
`input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens`
aus `sessions.started_at` im jeweiligen Zeitfenster. Fehlt eine Profil-DB, wird die Zeile
trotzdem geschrieben (0 Tokens) und in `heartbeats.meta.source_missing` markiert.

## Grenzen / bewusste Entscheidungen

* `metrics_hourly.blocked_minutes` bleibt `0`: `hermes kanban list --json` liefert keinen
  „blockiert seit"-Zeitstempel, und aus der Kartenliste laesst sich keine ehrliche Zahl
  ableiten. Lieber 0 als geraten.
* Es wird kein `service-role`-Key verwendet und keiner erwartet — der Daemon laeuft als
  Agent-User; RLS-Policies mit `staff.is_agent()` greifen.
* Der Kanban-Aufruf schlaegt fehl, wenn der Prozess in einem `delegate_task`-Kindkontext
  laeuft (`HERMES_DELEGATED_CHILD_CONTEXT` gesetzt, Hermes sperrt dort Board-Zugriffe).
  Unter launchd ist die Variable nicht gesetzt; im Zweifel den Lauf mit
  `env -u HERMES_DELEGATED_CHILD_CONTEXT …` starten.
* Schreibt nur `staff.*` und die eigenen Dateien unter `~/.jarvis-os/`; Hermes-Datenbanken
  werden nie veraendert.

## Fehlersuche

```sh
tail -50 ~/.jarvis-os/staffd.log          # letzte Laeufe, step_failed-Zeilen
python3 staffd/staffd.py --once           # Einzellauf mit JSON-Ausgabe
plutil -lint staffd/com.jarvis.staffd.plist
```

Haeufige Ursachen: `secrets.env` fehlt/falsch (Exit 2, `fatal login`), Hermes-CLI nicht im
`PATH` (`kanban list fehlgeschlagen`), Supabase nicht erreichbar (SSL/Netz — der Daemon
laedt zusaetzlich `/etc/ssl/cert.pem`, weil python.org-Builds keinen CA-Store mitbringen).
