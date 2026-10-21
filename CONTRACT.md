# JARVIS OS — Staff Board v2 · Bauvertrag

Verbindlich für alle Teile. Nicht abweichen; bei Unklarheit die vorhandene Datei lesen, nicht raten.

## 1. Was gebaut wird

- **`site/`** — statische Weboberfläche (HTML/CSS/JS, kein Build-Schritt), läuft auf GitHub Pages.
  Öffentliche URL: `https://janbleile09-lab.github.io/jarvis-os/`
- **`staffd/`** — Daemon auf Jans Mac, verbindet Hermes (Kanban, Profile, Token-Verbrauch,
  Watchdog) mit Supabase. Läuft unter launchd, nur ausgehende HTTPS-Verbindungen.
- **`supabase/migrations/`** — bereits angewendet, nicht ändern.

## 2. Sicherheitsmodell (nicht verhandelbar)

- Im Browser liegt **nur** der Publishable Key. Kein service_role, keine Passwörter, keine Tokens
  im Code.
- Der Mensch liest und schreibt **ausschließlich über RPCs** (`POST /rest/v1/rpc/<name>`).
  Tabellen direkt zu lesen ist verboten — die RLS liefert dort bewusst null Zeilen.
- Jeder RPC außer der Geräte-Anmeldung verlangt den Header `x-device-token` mit dem
  Gerätetoken des Browsers. Ohne freigeschaltetes Gerät: `{"ok":false,"reason":"device_not_trusted"}`.
- Ein Gerät wird erst nach korrekter Antwort auf die Sicherheitsfrage `trusted`.
- Der Daemon meldet sich als eigener Auth-User an (E-Mail + Passwort aus `~/.jarvis-os/secrets.env`),
  Rolle `agent` in `staff.members`. Er darf schreiben, aber **keine** Freigabe entscheiden
  (`decide_approval` verlangt ein Gerät).

## 3. Zugangsdaten

```
SUPABASE_URL=https://eggrvcohkaizbcsxtywi.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_3-q2CXobEwsMTTzUFk82hw_17NEfCdt
Schema: staff  (bei PostgREST: Header Accept-Profile: staff / Content-Profile: staff)
```

Lokal für den Daemon (bereits vorhanden, `chmod 600`, nie einchecken):
`~/.jarvis-os/secrets.env` mit `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`,
`STAFF_AGENT_EMAIL`, `STAFF_AGENT_PASSWORD`.

## 4. Auth-Ablauf im Browser

1. `supabase.createClient(URL, PUBLISHABLE_KEY, {auth:{detectSessionInUrl:true, persistSession:true}})`
2. Login: `signInWithOtp({ email, options:{ shouldCreateUser:false, emailRedirectTo: SITE_URL } })`
   → Supabase schickt einen Magic Link. Nach Klick landet der Nutzer mit Session auf der Seite.
   Fallback-Text in der UI: „Link in der Mail öffnen, dann hier weiter."
3. `rpc('device_status')` → `{authenticated, member, role, trusted, has_question, owner_claimed}`
4. `member=false` und `owner_claimed=false` → Eingabefeld „Zugangscode" → `rpc('claim_owner',{p_code})`
5. `member=true, trusted=false`:
   - `has_question=false` → Formular Frage + Antwort → `rpc('set_security_question',{p_question,p_answer})`
   - dann `rpc('register_device',{p_label, p_ua, p_token})` → `{device_id, question}`
   - Antwort eingeben → `rpc('answer_device',{p_device,p_answer})`
     - `{ok:true}` → Token in `localStorage['jarvis_device_token']`, Board laden
     - `{ok:false, reason:'wrong', attempts_left:n}` → Hinweis, 3 Versuche
     - `{reason:'locked', until}` → Sperrzeit anzeigen
6. Gerätetoken: einmal pro Browser erzeugen (`crypto.getRandomValues`, 32 Byte, hex), in
   `localStorage['jarvis_device_token']` halten, **bei jedem RPC als Header mitsenden**.
7. Logout: `auth.signOut()` + Token aus localStorage entfernen ist falsch (Token gehört zum Gerät).
   Logout entfernt nur die Session; das Gerät bleibt freigeschaltet.
8. In „Einstellungen": Geräteliste mit `revoke_device`, Sicherheitsfrage ändern
   (`set_security_question`), Abmelden.

RPC-Aufruf im JS immer mit Header:
```js
await sb.rpc('board', {}, { headers: { 'x-device-token': deviceToken } })
```

## 5. RPCs (alle POST, alle liefern JSON)

| RPC | Parameter | Rückgabe |
|---|---|---|
| `device_status` | – | `{authenticated, member, role, trusted, has_question, owner_claimed}` |
| `claim_owner` | `p_code` | `{ok}` oder `{ok:false, reason}` |
| `set_security_question` | `p_question`, `p_answer` | `{ok}` |
| `register_device` | `p_label`, `p_ua`, `p_token` | `{ok, device_id, question, needs_question}` |
| `answer_device` | `p_device`, `p_answer` | `{ok}` / `{ok:false, reason, attempts_left?, until?}` |
| `revoke_device` | `p_device` | `{ok}` |
| `board` | – | siehe 6. |
| `decide_approval` | `p_id`, `p_decision` (`approved`/`denied`/`withdrawn`), `p_note` | `{ok}` |
| `instruct` | `p_target`, `p_body` | `{ok}` |
| `update_readiness` | `p_key`, `p_score` (0–5), `p_note`, `p_url` | `{ok}` |
| `set_setting` | `p_key`, `p_value` (jsonb) | `{ok}` |
| `upsert_task` | `p_id` (null = neu), `p_agent`, `p_title`, `p_detail`, `p_status`, `p_progress`, `p_step` | `{ok, id}` |

## 6. `board()` — Form der Antwort

```json
{
  "ok": true, "now": "…",
  "agents": [{"key":"jarvis","name":"JARVIS","role":"COO","level":2,"personality":"…","mandate":"…",
              "limits":"…","model":"…","budget_eur_day":12.0,"reports_to":null,"sort":10,
              "last_seen":"…","status":"idle|running|waiting|error","tokens_today":0,
              "cost_eur_today":0,"meta":{}}],
  "tasks": [{"id":"…","agent_key":"peter","title":"…","detail":"…","status":"todo|scheduled|running|blocked|review|done",
             "progress":0,"current_step":"…","priority":2,"updated_at":"…"}],
  "approvals": [{"id":"…","requested_by":"charlie","kind":"subagents|deploy|purchase|delete|external|other",
                 "title":"…","question":"…","recommendation":"…","cost_tokens":180000,"cost_eur":1.6,
                 "risk":"low|medium|high","status":"open|approved|denied|expired|withdrawn",
                 "default_decision":"approve|deny","expires_at":"…","decided_at":"…",
                 "decision_note":"…","created_at":"…"}],
  "events": [{"id":1,"ts":"…","agent_key":"…","kind":"…","message":"…"}],
  "incidents": [{"id":1,"ts":"…","severity":"info|warn|critical","source":"…","summary":"…",
                 "action_taken":"…","needs_jan":false,"resolved_at":null}],
  "watchdog": [{"check_key":"hub","status":"ok|warn|fail","detail":"…","latency_ms":31,"ts":"…"}],
  "metrics": [{"hour":"…","agent_key":"peter","tasks_done":2,"tokens":142000,"cost_eur":0.02,"blocked_minutes":0}],
  "readiness": [{"key":"produkt","label":"Produkt funktioniert im Feld","weight":0.25,"score":3,
                 "evidence_url":null,"evidence_note":"…","updated_at":"…"}],
  "readiness_score": 38.0,
  "settings": {"night_policy":{…},"budgets":{…},"watchdog":{…}},
  "devices": [{"id":"…","label":"…","status":"pending|trusted|revoked","created_at":"…",
               "trusted_at":"…","last_seen_at":"…"}],
  "instructions": [{"id":"…","target":"peter","body":"…","status":"queued|taken|done|failed",
                    "created_at":"…","result":"…"}]
}
```

Aktualisierung: `board()` alle 5 s pollen (nur wenn Tab sichtbar), kein Realtime (Tabellen sind
für den Menschen gesperrt). Kein Polling, wenn `document.hidden`.

## 7. Oberfläche — sechs Ansichten, dunkel, ohne Build

Design-Vorbild: `site/../docs/staffboard_v2_mockup.html` (liegt unter
`~/jarvis-briefing-hub/docs/staffboard-v2/staffboard_v2_mockup.html`). Farben: Hintergrund `#0b0d10`,
Karten `#14171c`, Linien `#262c35`, Text `#e8ecf2`, gedämpft `#8b95a5`, Akzent `#4da3ff`,
ok `#35d07f`, warn `#ffb02e`, bad `#ff5c5c`. Systemschrift. Responsive bis 390 px.

1. **Übersicht** — Organigramm (Inhaber → COO → 5 Bereichsleiter mit Persönlichkeit als Zitat),
   darunter Live-Karten der Agenten (Aufgabe, Schritt, Heartbeat-Alter, Token/Kosten heute, Ampel).
2. **Live-Board** — pro Agent: aktuelle Karten, Verlauf, Feld „Anweisung an <agent>" (`instruct`),
   Buttons „Pausieren" (Karte auf `blocked` via `upsert_task`), „Neu starten".
3. **Freigaben** — offene Karten mit Kosten/Risiko/Frist/Empfehlung, Buttons Genehmigen/Ablehnen/
   Mit Anweisung, Restzeit bis Frist, Entscheidungen der letzten 7 Tage darunter.
4. **Analytik** — KPI-Kacheln (Karten heute, Nachtfortschritt 22–07, Kosten heute, blockiert),
   SVG-Diagramm Durchsatz + Token je Tag (aus `metrics`), Tabelle je Agent.
5. **Marktreife** — Gauge mit `readiness_score`, Kriterientabelle mit Gewicht/Score/Evidenz,
   Score ändern (`update_readiness`) mit Pflicht-Evidenztext.
6. **Watchdog & Einstellungen** — letzte Checks, Incidents, Geräte, Sicherheitsfrage ändern,
   Budgets/Nacht-Policy (`set_setting`).

Regeln: keine Inline-Handler (CSP!), `addEventListener`, kein Framework, kein externes CSS.
Nur `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm` als externe Ressource.
Meta-CSP in `index.html`:
`default-src 'self'; connect-src 'self' https://eggrvcohkaizbcsxtywi.supabase.co; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'`
Leere Zustände ehrlich beschriften („Noch keine Daten"), keine erfundenen Zahlen.

## 8. Daemon `staffd`

Python 3.14, nur Standardbibliothek (`urllib`, `json`, `sqlite3`, `subprocess`, `ssl`).
Schleife 5 s; Watchdog 60 s; Metriken 300 s. Zustand in `~/.jarvis-os/staffd_state.json`.

Aufgaben je Durchlauf:

1. **Anmelden** beim Agent-User (Passwort-Grant), Token erneuern, wenn < 5 min Restzeit.
2. `rpc/expire_approvals` aufrufen (schließt abgelaufene Freigaben nach Standard-Entscheidung).
3. **Anweisungen** holen: `GET /rest/v1/instructions?status=eq.queued&select=*&order=created_at.asc`.
   Für jede: `status=taken` setzen, dann an Hermes übergeben:
   - Karte anlegen: `hermes kanban create --title "…" --assignee <target> --body "<body>"` (siehe
     `hermes kanban create --help`, Flags vorher prüfen!)
   - danach `status=done`, `result` = Karten-ID.
4. **Freigaben ausführen**: `status=eq.approved&applied_at=is.null`:
   - `kind=subagents` → `cost_tokens`/1000 (min 1, max 5) Karten für `requested_by` anlegen
   - andere Arten → Event schreiben „freigegeben, Ausführung durch Agent" und
     `rpc/mark_approval_applied` aufrufen
5. **Kanban spiegeln**: `hermes kanban list --json` (Board `savood`), Karten auf `staff.tasks`
   abbilden (Status-Mapping: todo/triage→todo, scheduled→scheduled, ready/running→running,
   review→review, blocked→blocked, done→done). Vorhandene Karten per `kanban_id` aktualisieren,
   neue einfügen (Spalte `kanban_id` = Karten-ID). Höchstens 40 Karten je Lauf.
6. **Heartbeat** je Agent: `last_seen=now()`, `status` aus laufenden Karten, `tokens_today` und
   `cost_eur_today` aus den Session-Datenbanken (siehe 9).
7. **Watchdog** (60 s): 
   - `hub`: `GET http://127.0.0.1:8000/healthz`, Timeout 2 s → ok/warn/fail + Latenz
   - `provider`: `GET https://api.oneprovider.dev/v1/models` mit Key aus `~/.hermes/.env` oder
     Config (nur Statuscode, kein Inhalt loggen) → ok/fail
   - `cron`: `hermes cron list` — Jobs mit „error" oder „not delivered" in der letzten Ausgabe → warn
   - `disk`: `shutil.disk_usage('/')` frei < 10 % → warn
   - `staffd`: eigener Lauf, Schreibzeit in die DB
   Jeden Check in `staff.watchdog_checks` schreiben. Bei Wechsel ok→fail einen `incidents`-Eintrag
   (severity critical, needs_jan nur wenn nicht selbst behebbar) und, wenn `hub` fail: einmal
   `launchctl kickstart -k gui/$(id -u)/com.jarvis.briefinghub` versuchen und Ergebnis in
   `action_taken` schreiben.
8. **Metriken** (300 s): Token je Agent und Stunde aus den Session-DBs, `tasks_done` aus Kanban,
   in `staff.metrics_hourly` upserten. Kosten: `tokens * 0.00000014` € (0,14 €/1M), in `settings`
   überschreibbar (`rate_eur_per_mtok`).

Fehler nie verschlucken: pro Lauf eine Zeile in `~/.jarvis-os/staffd.log` (Rotation > 5 MB),
und bei Ausnahmen einen `incidents`-Eintrag mit `severity=warn`.

## 9. Woher die Zahlen kommen

- **Kanban**: `hermes kanban list --json` (Board `savood`), Feld `assignee` = Agent-Key.
- **Token je Profil**: SQLite `~/.hermes/profiles/<key>/state.db`, Tabelle `sessions`
  (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`,
  `started_at` als Unix-Zeit). Für `jarvis` zusätzlich `~/.hermes/state.db`.
  Immer nur `mode=ro` öffnen (`sqlite3.connect('file:…?mode=ro', uri=True)`), nie schreiben.
- **Kosten**: Tokensumme × Satz aus `settings.rate_eur_per_mtok` (Standard 0,14 €/1M).
- Nichts erfinden: fehlt eine Quelle, bleibt der Wert 0 und `meta.source_missing=true`.

## 10. Startbefehl für den Daemon

```
launchd: ~/Library/LaunchAgents/com.jarvis.staffd.plist, KeepAlive true,
ProgramArguments: /usr/bin/env python3 /Users/janbleile/jarvis-os/staffd/staffd.py
StandardOut/Err: ~/.jarvis-os/staffd.log
```
Plist mitliefern, aber **nicht** selbst laden — das macht der Hauptagent.

## 11. Definition of Done

- `site/` lädt ohne Konsolenfehler, Login-Gate greift, Board zeigt echte Daten aus Supabase.
- Ohne Gerätetoken liefert die Seite keine Daten (nur die Geräteprüfung).
- `staffd` läuft einen Durchlauf fehlerfrei durch, schreibt Heartbeats, Watchdog-Checks und Metriken.
- Keine Secrets im Repo (`git grep -iE "service_role|password|sb_secret"` muss leer sein).
