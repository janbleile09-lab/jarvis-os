#!/usr/bin/env python3
"""staffd — JARVIS OS Staff-Board-Daemon.

Verbindet Hermes (Kanban, Profile, Token-Verbrauch, Watchdog) mit Supabase.
Laeuft unter launchd, nur ausgehende HTTPS-Verbindungen.

Vertrag: jarvis-os/CONTRACT.md, Abschnitte 8-10.

Regeln, die dieser Daemon einhaelt:
  * Python-Standardbibliothek only, keine Abhaengigkeiten.
  * Zugangsdaten ausschliesslich aus ~/.jarvis-os/secrets.env (zur Laufzeit gelesen,
    nie geloggt, nie im Code).
  * Kein service-role-Key. Der Daemon ist der Auth-User mit Rolle `agent`.
  * PostgREST immer mit Accept-Profile/Content-Profile = staff.
  * Hermes-Datenbanken (~/.hermes/state.db, ~/.hermes/profiles/*/state.db) nur mode=ro.
  * Eine fehlgeschlagene Teilaufgabe beendet den Lauf nicht: Ausnahme -> incidents(warn),
    weiter mit der naechsten Aufgabe.
"""

import json
import os
import shutil
import ssl
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------------- Pfade

HOME = os.path.expanduser("~")
JARVIS_DIR = os.path.join(HOME, ".jarvis-os")
SECRETS_PATH = os.path.join(JARVIS_DIR, "secrets.env")
STATE_PATH = os.path.join(JARVIS_DIR, "staffd_state.json")
LOG_PATH = os.path.join(JARVIS_DIR, "staffd.log")
LOG_MAX_BYTES = 5 * 1024 * 1024

HERMES_HOME = os.path.join(HOME, ".hermes")
HERMES_ENV_PATH = os.path.join(HERMES_HOME, ".env")
KANBAN_BOARD = "savood"

LOOP_SECONDS = 5
WATCHDOG_SECONDS = 60
METRICS_SECONDS = 300
TOKEN_REFRESH_MARGIN = 300          # Token erneuern, wenn < 5 min Restzeit
HTTP_TIMEOUT = 15
KANBAN_MAX_CARDS = 40
DEFAULT_RATE_EUR_PER_MTOK = 0.14    # 0,14 EUR / 1 Mio Tokens

# Kanban-Status -> staff.tasks.status (Vertrag 8.5)
STATUS_MAP = {
    "todo": "todo",
    "triage": "todo",
    "scheduled": "scheduled",
    "ready": "running",
    "running": "running",
    "review": "review",
    "blocked": "blocked",
    "done": "done",
}
STATUS_STEP = {
    "todo": "offen",
    "scheduled": "geplant",
    "running": "läuft",
    "blocked": "blockiert",
    "review": "in Prüfung",
    "done": "fertig",
}
STATUS_PROGRESS = {
    "todo": 0,
    "scheduled": 0,
    "running": 50,
    "blocked": 25,
    "review": 75,
    "done": 100,
}

def _build_ssl_context():
    """TLS-Kontext mit Systemwurzelzertifikaten.

    python.org-Builds bringen unter macOS keinen CA-Store mit; /etc/ssl/cert.pem
    ist der Systembund und wird deshalb zusaetzlich geladen (nur lesend, stdlib).
    """
    ctx = ssl.create_default_context()
    for cafile in (
        "/etc/ssl/cert.pem",
        "/opt/homebrew/etc/ca-certificates/cert.pem",
        "/usr/local/etc/ca-certificates/cert.pem",
    ):
        if os.path.exists(cafile):
            try:
                ctx.load_verify_locations(cafile=cafile)
            except Exception:
                pass
    return ctx


_SSL_CTX = _build_ssl_context()


# --------------------------------------------------------------------------- Log

def _rotate_log():
    try:
        if os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
            # In-place kuerzen: launchd haelt den Schreibdeskriptor auf dieser Datei
            # (StandardOut/Err). Umbenennen wuerde den Deskriptor auf die alte Inode
            # zeigen lassen, deshalb vorher wegkopieren und dann truncaten.
            try:
                shutil.copyfile(LOG_PATH, LOG_PATH + ".1")
            except Exception:
                pass
            with open(LOG_PATH, "r+") as fh:
                fh.truncate(0)
    except FileNotFoundError:
        pass
    except Exception:
        pass


def log(message):
    """Eine Zeile pro Ereignis nach ~/.jarvis-os/staffd.log (Rotation > 5 MB)."""
    line = "%s %s\n" % (datetime.now().astimezone().isoformat(timespec="seconds"), message)
    try:
        os.makedirs(JARVIS_DIR, exist_ok=True)
        _rotate_log()
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        pass
    try:
        sys.stdout.write(line)
        sys.stdout.flush()
    except Exception:
        pass


# --------------------------------------------------------------------------- Secrets

def load_secrets():
    """Liest ~/.jarvis-os/secrets.env. Fehlende Datei -> klare Ausnahme."""
    if not os.path.exists(SECRETS_PATH):
        raise RuntimeError("secrets.env fehlt: %s" % SECRETS_PATH)
    values = {}
    with open(SECRETS_PATH, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    for required in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "STAFF_AGENT_EMAIL", "STAFF_AGENT_PASSWORD"):
        if not values.get(required):
            raise RuntimeError("secrets.env: %s fehlt" % required)
    return values


def oneprovider_key():
    """Provider-Key aus ~/.hermes/.env (nur fuer den Watchdog-Check, nie geloggt)."""
    try:
        with open(HERMES_ENV_PATH, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if line.startswith("ONEPROVIDER_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        return None
    return None


# --------------------------------------------------------------------------- Zustand

class State(object):
    """Kleiner Zustandspeicher in ~/.jarvis-os/staffd_state.json (chmod 600)."""

    def __init__(self, path=STATE_PATH):
        self.path = path
        self.data = {}
        try:
            with open(path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            if isinstance(loaded, dict):
                self.data = loaded
        except Exception:
            self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False, indent=2, sort_keys=True)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except Exception as exc:
            log("state_save_failed %s" % exc)


# --------------------------------------------------------------------------- HTTP

def http_request(method, url, headers=None, body=None, timeout=float(HTTP_TIMEOUT)):
    """Fuehrt eine HTTP-Anfrage aus. Gibt (status, bytes) zurueck; HTTP-Fehler werfen nicht."""
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        try:
            payload = exc.read()
        except Exception:
            payload = b""
        return exc.code, payload


def _json_or_none(raw):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return None


def _short(raw, limit=300):
    """Fehlerantworten fuer Log/DB kuerzen; nie Zugangsdaten enthalten."""
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        text = raw.decode("utf-8", "replace")
    else:
        text = str(raw)
    text = " ".join(text.split())
    return text[:limit]


# --------------------------------------------------------------------------- Supabase

class Supabase(object):
    """Minimaler PostgREST/Auth-Client (Standardbibliothek)."""

    def __init__(self, url, anon_key, email, password, state):
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.email = email
        self.password = password
        self.state = state
        self.access_token = state.get("access_token")
        self.refresh_token = state.get("refresh_token")
        self.expires_at = float(state.get("expires_at") or 0)
        self.writes = 0

    # -- Auth ------------------------------------------------------------
    def _store_session(self, payload):
        self.access_token = payload.get("access_token")
        self.refresh_token = payload.get("refresh_token") or self.refresh_token
        expires_in = int(payload.get("expires_in") or 3600)
        self.expires_at = time.time() + expires_in
        self.state.set("access_token", self.access_token)
        self.state.set("refresh_token", self.refresh_token)
        self.state.set("expires_at", self.expires_at)
        self.state.save()

    def login(self):
        """Passwort-Grant gegen /auth/v1/token."""
        body = json.dumps({"email": self.email, "password": self.password}).encode("utf-8")
        status, raw = http_request(
            "POST",
            self.url + "/auth/v1/token?grant_type=password",
            {"apikey": self.anon_key, "Content-Type": "application/json"},
            body,
        )
        payload = _json_or_none(raw)
        if status != 200 or not isinstance(payload, dict) or not payload.get("access_token"):
            raise RuntimeError("login fehlgeschlagen (HTTP %s): %s" % (status, _short(raw, 200)))
        self._store_session(payload)
        return True

    def _refresh(self):
        if not self.refresh_token:
            return False
        body = json.dumps({"refresh_token": self.refresh_token}).encode("utf-8")
        status, raw = http_request(
            "POST",
            self.url + "/auth/v1/token?grant_type=refresh_token",
            {"apikey": self.anon_key, "Content-Type": "application/json"},
            body,
        )
        payload = _json_or_none(raw)
        if status == 200 and isinstance(payload, dict) and payload.get("access_token"):
            self._store_session(payload)
            return True
        return False

    def ensure_auth(self):
        """Token vorhanden und > 5 min gueltig? Sonst erneuern, sonst neu anmelden."""
        if self.access_token and self.expires_at - time.time() > TOKEN_REFRESH_MARGIN:
            return True
        if self.access_token and self._refresh():
            return True
        return self.login()

    # -- PostgREST -------------------------------------------------------
    def _headers(self, extra=None):
        headers = {
            "apikey": self.anon_key,
            "Authorization": "Bearer " + (self.access_token or ""),
            "Accept-Profile": "staff",
            "Content-Profile": "staff",
            "Content-Type": "application/json",
        }
        if extra:
            headers.update(extra)
        return headers

    def request(self, method, path, payload=None, prefer=None):
        """path ist relativ zu /rest/v1/ (z. B. 'tasks?select=*'). Gibt (status, json)."""
        self.ensure_auth()
        extra = {}
        if prefer:
            extra["Prefer"] = prefer
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        url = self.url + "/rest/v1/" + path
        status, raw = http_request(method, url, self._headers(extra), body)
        if status in (401, 403) and method != "GET":
            # abgelaufenes Token mitten im Lauf: einmal erneuern und wiederholen
            self.access_token = None
            self.ensure_auth()
            status, raw = http_request(method, url, self._headers(extra), body)
        elif status == 401:
            self.access_token = None
            self.ensure_auth()
            status, raw = http_request(method, url, self._headers(extra), body)
        if method in ("POST", "PATCH", "DELETE") and 200 <= status < 300:
            self.writes += 1
        return status, _json_or_none(raw)

    def select(self, table, query=""):
        path = table + ("?" + query if query else "")
        status, data = self.request("GET", path)
        if status != 200:
            raise RuntimeError("select %s fehlgeschlagen (HTTP %s)" % (table, status))
        return data or []

    def rpc(self, name, params=None):
        status, data = self.request("POST", "rpc/" + name, params or {})
        if status not in (200, 204):
            raise RuntimeError("rpc %s fehlgeschlagen (HTTP %s)" % (name, status))
        return data

    def insert(self, table, rows, on_conflict=None, merge=False):
        query = ""
        if on_conflict:
            query = "?on_conflict=" + on_conflict
        prefer = "return=minimal"
        if merge:
            prefer = "resolution=merge-duplicates,return=minimal"
        status, _ = self.request("POST", table + query, rows, prefer)
        if status not in (200, 201, 204):
            raise RuntimeError("insert %s fehlgeschlagen (HTTP %s)" % (table, status))
        return True

    def update(self, table, query, patch):
        status, _ = self.request("PATCH", table + "?" + query, patch, "return=minimal")
        if status not in (200, 204):
            raise RuntimeError("update %s fehlgeschlagen (HTTP %s)" % (table, status))
        return True


# --------------------------------------------------------------------------- Hermes

def hermes_bin():
    """Pfad zum Hermes-CLI: PATH, dann bekannte Installationsorte."""
    found = shutil.which("hermes")
    if found:
        return found
    for candidate in (
        os.path.join(HERMES_HOME, "hermes-agent", ".hermes", "bin", "hermes"),
        os.path.join(HERMES_HOME, "bin", "hermes"),
        "/opt/homebrew/bin/hermes",
        "/usr/local/bin/hermes",
    ):
        if os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise RuntimeError("hermes-CLI nicht gefunden")


def run_hermes(args, timeout=120):
    """Ruft das Hermes-CLI auf. Gibt (returncode, stdout, stderr) zurueck."""
    env = dict(os.environ)
    env.setdefault("HOME", HOME)
    bin_dir = os.path.dirname(hermes_bin())
    env["PATH"] = bin_dir + ":" + env.get("PATH", "/usr/bin:/bin")
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.run(
        [hermes_bin()] + list(args),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        cwd=HOME,
    )
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def kanban_list(board=KANBAN_BOARD):
    code, out, err = run_hermes(["kanban", "--board", board, "list", "--json"], timeout=90)
    if code != 0:
        raise RuntimeError("kanban list fehlgeschlagen (rc=%s): %s" % (code, _short(err or out, 200)))
    try:
        data = json.loads(out)
    except Exception:
        raise RuntimeError("kanban list lieferte kein JSON: %s" % _short(out, 200))
    if not isinstance(data, list):
        raise RuntimeError("kanban list lieferte unerwartete Struktur")
    return data


def kanban_create(board, title, body, assignee):
    """Legt eine Karte an und gibt ihre ID zurueck."""
    args = [
        "kanban", "--board", board, "create",
        "--title", title[:200],
        "--body", body,
        "--json",
    ]
    if assignee:
        args += ["--assignee", assignee]
    code, out, err = run_hermes(args, timeout=150)
    if code != 0:
        raise RuntimeError("kanban create fehlgeschlagen (rc=%s): %s" % (code, _short(err or out, 200)))
    payload = _json_or_none(out.encode("utf-8"))
    if isinstance(payload, dict) and payload.get("id"):
        return payload["id"]
    raise RuntimeError("kanban create lieferte keine Karten-ID: %s" % _short(out, 200))


# --------------------------------------------------------------------------- Zeit/Tokens

def _utc(dt):
    return dt.astimezone(timezone.utc)


def iso(dt):
    return _utc(dt).isoformat(timespec="seconds").replace("+00:00", "+00:00")


def local_midnight_ts():
    now = datetime.now().astimezone()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.timestamp()


def hour_bounds(ts=None):
    now = datetime.fromtimestamp(ts if ts is not None else time.time()).astimezone()
    start = now.replace(minute=0, second=0, microsecond=0)
    return start, start + timedelta(hours=1)


def _state_db_path(agent_key):
    """Tokenquelle je Agent (Vertrag 9): jarvis -> ~/.hermes/state.db, sonst Profil-DB."""
    if agent_key == "jarvis":
        return os.path.join(HERMES_HOME, "state.db")
    return os.path.join(HERMES_HOME, "profiles", agent_key, "state.db")


def tokens_between(agent_key, start_ts, end_ts):
    """Summe aller Token-Spalten aus sessions im Zeitfenster. Gibt (tokens, source_ok)."""
    import sqlite3

    path = _state_db_path(agent_key)
    if not os.path.exists(path):
        return 0, False
    uri = "file:%s?mode=ro" % urllib.parse.quote(path)
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=5)
    except Exception:
        return 0, False
    try:
        conn.execute("PRAGMA query_only = ON")
        row = conn.execute(
            "select coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)"
            "+coalesce(cache_read_tokens,0)+coalesce(cache_write_tokens,0)"
            "+coalesce(reasoning_tokens,0)),0) from sessions "
            "where started_at >= ? and started_at < ?",
            (start_ts, end_ts),
        ).fetchone()
        return int(row[0] or 0), True
    except Exception:
        return 0, False
    finally:
        try:
            conn.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- Helfer

def incident(sb, severity, source, summary, action_taken=None, needs_jan=False):
    row = {
        "severity": severity,
        "source": source,
        "summary": summary[:500],
        "action_taken": (action_taken or None),
        "needs_jan": bool(needs_jan),
    }
    try:
        sb.insert("incidents", [row])
        return True
    except Exception as exc:
        log("incident_write_failed source=%s err=%s" % (source, _short(exc, 160)))
        return False


def event(sb, agent_key, kind, message):
    try:
        sb.insert("events", [{"agent_key": agent_key, "kind": kind, "message": message[:500]}])
    except Exception as exc:
        log("event_write_failed kind=%s err=%s" % (kind, _short(exc, 160)))


def setting_value(sb, key, default=None):
    try:
        rows = sb.select("settings", "select=value&key=eq." + urllib.parse.quote(key))
        if rows:
            return rows[0].get("value", default)
    except Exception:
        pass
    return default


def rate_eur_per_mtok(sb):
    value = setting_value(sb, "rate_eur_per_mtok", None)
    try:
        if isinstance(value, dict):
            value = value.get("value")
        if value is None:
            return DEFAULT_RATE_EUR_PER_MTOK
        return float(value)
    except (TypeError, ValueError):
        return DEFAULT_RATE_EUR_PER_MTOK


def cost_eur(tokens, rate):
    return round(tokens * rate / 1000000.0, 6)


# --------------------------------------------------------------------------- Aufgabe 2

def task_expire_approvals(sb):
    """Vertrag 8.2 — abgelaufene Freigaben nach Standard-Entscheidung schliessen."""
    result = sb.rpc("expire_approvals")
    count = 0
    if isinstance(result, int):
        count = result
    elif isinstance(result, str) and result.isdigit():
        count = int(result)
    elif isinstance(result, dict):
        for value in result.values():
            if isinstance(value, int):
                count = value
                break
    return {"expired": count}


# --------------------------------------------------------------------------- Aufgabe 3

def _title_from_body(body, target):
    for line in (body or "").splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return (line[:80] if line[:80] else "Anweisung")
    return "Anweisung an %s" % (target or "Agent")


def task_instructions(sb):
    """Vertrag 8.3 — queued-Anweisungen als Kanban-Karten an Hermes uebergeben."""
    rows = sb.select(
        "instructions",
        "status=eq.queued&select=id,target,body,created_at&order=created_at.asc&limit=10",
    )
    handled = 0
    failed = 0
    for row in rows:
        instr_id = row.get("id")
        target = row.get("target")
        body = row.get("body") or ""
        try:
            sb.update(
                "instructions",
                "id=eq." + str(instr_id),
                {"status": "taken", "taken_at": datetime.now(timezone.utc).isoformat()},
            )
        except Exception as exc:
            log("instruction_taken_failed id=%s err=%s" % (instr_id, _short(exc, 160)))
            continue
        try:
            card_id = kanban_create(KANBAN_BOARD, _title_from_body(body, target), body, target)
            sb.update("instructions", "id=eq." + str(instr_id), {"status": "done", "result": card_id})
            event(sb, target, "instruction", "Anweisung als Karte %s angelegt" % card_id)
            handled += 1
        except Exception as exc:
            failed += 1
            message = _short(exc, 300)
            try:
                sb.update("instructions", "id=eq." + str(instr_id), {"status": "failed", "result": message})
            except Exception:
                pass
            log("instruction_create_failed id=%s err=%s" % (instr_id, message))
            incident(sb, "warn", "staffd.instructions", "Anweisung %s konnte nicht als Karte angelegt werden" % instr_id)
    return {"instructions_done": handled, "instructions_failed": failed}


# --------------------------------------------------------------------------- Aufgabe 4

def task_approvals(sb):
    """Vertrag 8.4 — freigegebene, noch nicht ausgefuehrte Freigaben umsetzen."""
    rows = sb.select(
        "approvals",
        "status=eq.approved&applied_at=is.null&select=id,requested_by,kind,title,question,"
        "recommendation,cost_tokens,cost_eur,risk,expires_at,decided_at&order=decided_at.asc&limit=10",
    )
    applied = 0
    cards = 0
    for row in rows:
        approval_id = row.get("id")
        kind = row.get("kind") or "other"
        requested_by = row.get("requested_by")
        title = row.get("title") or "Freigabe"
        try:
            if kind == "subagents":
                tokens = int(row.get("cost_tokens") or 0)
                count = tokens // 1000
                count = max(1, min(5, count))
                body = "\n".join(
                    part for part in [
                        "Freigegeben von Jan (Freigabe %s)." % approval_id,
                        "Frage: %s" % (row.get("question") or "-"),
                        "Empfehlung: %s" % (row.get("recommendation") or "-"),
                        "Budget: %s Tokens / %s EUR." % (tokens, row.get("cost_eur") or 0),
                    ] if part
                )
                for index in range(1, count + 1):
                    kanban_create(
                        KANBAN_BOARD,
                        "%s (%d/%d)" % (title[:70], index, count),
                        body,
                        requested_by,
                    )
                    cards += 1
                sb.rpc("mark_approval_applied", {"p_id": approval_id})
                event(
                    sb, requested_by, "approval",
                    "Freigabe %s ausgefuehrt: %d Subagent-Karte(n)" % (approval_id, count),
                )
            else:
                event(
                    sb, requested_by, "approval",
                    "Freigabe %s (%s) freigegeben, Ausfuehrung durch Agent" % (approval_id, kind),
                )
                sb.rpc("mark_approval_applied", {"p_id": approval_id})
            applied += 1
        except Exception as exc:
            log("approval_apply_failed id=%s err=%s" % (approval_id, _short(exc, 200)))
            incident(sb, "warn", "staffd.approvals", "Freigabe %s konnte nicht ausgefuehrt werden" % approval_id)
    return {"approvals_applied": applied, "approval_cards": cards}


# --------------------------------------------------------------------------- Aufgabe 5

def task_mirror_kanban(sb, known_agents):
    """Vertrag 8.5 — Kanban-Karten (Board savood) nach staff.tasks spiegeln."""
    cards = kanban_list(KANBAN_BOARD)
    # Neueste zuerst, harte Obergrenze je Lauf.
    cards = sorted(cards, key=lambda c: c.get("completed_at") or c.get("started_at") or c.get("created_at") or 0, reverse=True)
    cards = cards[:KANBAN_MAX_CARDS]

    existing = {}
    try:
        rows = sb.select("tasks", "select=id,kanban_id,status,progress&kanban_id=not.is.null&limit=500")
        for row in rows:
            existing[str(row.get("kanban_id"))] = row
    except Exception as exc:
        log("task_index_failed err=%s" % _short(exc, 160))

    inserted = 0
    updated = 0
    errors = 0
    for card in cards:
        kanban_id = str(card.get("id") or "")
        if not kanban_id:
            continue
        mapped = STATUS_MAP.get(str(card.get("status") or "").lower(), "todo")
        assignee = card.get("assignee")
        agent_key = assignee if assignee in known_agents else None
        fields = {
            "agent_key": agent_key,
            "title": (card.get("title") or "ohne Titel")[:300],
            "detail": card.get("body") or "",
            "status": mapped,
            "current_step": STATUS_STEP.get(mapped, "offen"),
            "priority": int(card.get("priority") or 2) if isinstance(card.get("priority"), (int, float)) else 2,
            "kanban_id": kanban_id,
        }
        if card.get("started_at"):
            fields["started_at"] = iso(datetime.fromtimestamp(card["started_at"]))
        if card.get("completed_at"):
            fields["finished_at"] = iso(datetime.fromtimestamp(card["completed_at"]))
        try:
            current = existing.get(kanban_id)
            if current:
                patch = dict(fields)
                if current.get("status") != mapped:
                    patch["progress"] = STATUS_PROGRESS.get(mapped, 0)
                sb.update("tasks", "id=eq." + str(current.get("id")), patch)
                updated += 1
            else:
                fields["progress"] = STATUS_PROGRESS.get(mapped, 0)
                sb.insert("tasks", [fields])
                inserted += 1
        except Exception as exc:
            errors += 1
            log("task_mirror_failed kanban_id=%s err=%s" % (kanban_id, _short(exc, 160)))
    if errors:
        incident(sb, "warn", "staffd.kanban", "%d Karte(n) konnten nicht gespiegelt werden" % errors)
    return {
        "kanban_cards": len(cards),
        "tasks_inserted": inserted,
        "tasks_updated": updated,
        "tasks_failed": errors,
        "cards": cards,
    }


# --------------------------------------------------------------------------- Aufgabe 6

def _agent_status(cards_by_agent, agent_key):
    statuses = cards_by_agent.get(agent_key, [])
    if "running" in statuses:
        return "running"
    if "blocked" in statuses or "review" in statuses:
        return "waiting"
    return "idle"


def task_heartbeats(sb, agents, cards, rate):
    """Vertrag 8.6 — Heartbeat je Agent mit Status und Tagesverbrauch."""
    now = time.time()
    day_start = local_midnight_ts()
    cards_by_agent = {}
    for card in cards:
        mapped = STATUS_MAP.get(str(card.get("status") or "").lower(), "todo")
        cards_by_agent.setdefault(card.get("assignee"), []).append(mapped)

    rows = []
    missing = []
    for agent in agents:
        key = agent.get("key")
        tokens, source_ok = tokens_between(key, day_start, now)
        if not source_ok:
            missing.append(key)
        rows.append({
            "agent_key": key,
            "last_seen": datetime.now(timezone.utc).isoformat(),
            "status": _agent_status(cards_by_agent, key),
            "tokens_today": int(tokens),
            "cost_eur_today": round(cost_eur(tokens, rate), 3),
            "meta": {
                "source_missing": not source_ok,
                "tokens_total": int(tokens),
                "rate_eur_per_mtok": rate,
                "kanban_running": cards_by_agent.get(key, []).count("running"),
                "kanban_blocked": cards_by_agent.get(key, []).count("blocked"),
                "kanban_review": cards_by_agent.get(key, []).count("review"),
                "kanban_open": sum(1 for s in cards_by_agent.get(key, []) if s != "done"),
                "daemon": "staffd",
            },
        })
    if not rows:
        return {"heartbeats": 0}
    sb.insert("heartbeats", rows, on_conflict="agent_key", merge=True)
    return {"heartbeats": len(rows), "heartbeat_missing_sources": missing}


# --------------------------------------------------------------------------- Aufgabe 7

def _check_hub(timeout=2):
    started = time.time()
    try:
        status, _ = http_request("GET", "http://127.0.0.1:8000/healthz", {}, timeout=float(timeout))
        latency = int((time.time() - started) * 1000)
        if status == 200:
            return "ok", "HTTP 200", latency
        return "fail", "HTTP %s" % status, latency
    except Exception as exc:
        latency = int((time.time() - started) * 1000)
        return "fail", "nicht erreichbar: %s" % type(exc).__name__, latency


def _check_provider():
    started = time.time()
    key = oneprovider_key()
    if not key:
        return "warn", "kein Provider-Key in ~/.hermes/.env", int((time.time() - started) * 1000)
    try:
        status, _ = http_request(
            "GET",
            "https://api.oneprovider.dev/v1/models",
            {"Authorization": "Bearer " + key},
            timeout=8,
        )
        latency = int((time.time() - started) * 1000)
        if 200 <= status < 300:
            return "ok", "HTTP %s" % status, latency
        return "fail", "HTTP %s" % status, latency
    except Exception as exc:
        return "fail", "nicht erreichbar: %s" % type(exc).__name__, int((time.time() - started) * 1000)


def _check_cron():
    import re

    started = time.time()
    try:
        code, out, err = run_hermes(["cron", "list"], timeout=90)
    except Exception as exc:
        return "warn", "cron list nicht ausfuehrbar: %s" % type(exc).__name__, int((time.time() - started) * 1000)
    latency = int((time.time() - started) * 1000)
    text = (out or "") + "\n" + (err or "")
    # Job-Bloecke beginnen mit "  <12 hex> [status]"; Marker innerhalb eines Blocks zaehlen.
    job_start = re.compile(r"^\s{2}([0-9a-f]{12})\s+\[")
    current = None
    problem_jobs = {}
    for line in text.splitlines():
        match = job_start.match(line)
        if match:
            current = match.group(1)
            continue
        low = line.lower()
        if "error:" in low or "not delivered" in low or "nicht zugestellt" in low:
            if current:
                problem_jobs[current] = True
            else:
                problem_jobs["_unknown_%d" % len(problem_jobs)] = True
    if code != 0 and not problem_jobs:
        return "warn", "cron list rc=%s" % code, latency
    if problem_jobs:
        return "warn", "%d Job(s) mit Fehler oder nicht zugestellter Ausgabe" % len(problem_jobs), latency
    return "ok", "keine Fehler in der letzten Ausgabe", latency


def _check_disk(warn_percent=10.0):
    started = time.time()
    try:
        usage = shutil.disk_usage("/")
        free_percent = usage.free / float(usage.total) * 100.0
        latency = int((time.time() - started) * 1000)
        detail = "%.1f%% frei (%d GB)" % (free_percent, usage.free // (1024 ** 3))
        if free_percent < warn_percent:
            return "warn", detail, latency
        return "ok", detail, latency
    except Exception as exc:
        return "warn", "nicht messbar: %s" % type(exc).__name__, int((time.time() - started) * 1000)


def task_watchdog(sb, state, run_info):
    """Vertrag 8.7 — fuenf Checks, Statuswechsel ok->fail erzeugt Incidents."""
    watchdog_cfg = setting_value(sb, "watchdog", {}) or {}
    try:
        disk_warn = float(watchdog_cfg.get("disk_warn_percent", 10))
    except (TypeError, ValueError, AttributeError):
        disk_warn = 10.0
    try:
        hub_timeout = float(watchdog_cfg.get("hub_timeout_s", 2))
    except (TypeError, ValueError, AttributeError):
        hub_timeout = 2.0

    results = []
    for key, (status, detail, latency) in (
        ("hub", _check_hub(hub_timeout)),
        ("provider", _check_provider()),
        ("cron", _check_cron()),
        ("disk", _check_disk(disk_warn)),
    ):
        results.append({"check_key": key, "status": status, "detail": detail[:400], "latency_ms": latency})

    staffd_status = "ok" if not run_info.get("errors") else "warn"
    results.append({
        "check_key": "staffd",
        "status": staffd_status,
        "detail": run_info.get("summary") or "Lauf abgeschlossen",
        "latency_ms": int(run_info.get("duration_ms") or 0),
    })

    previous = state.get("check_status") or {}
    current = {}
    for item in results:
        current[item["check_key"]] = item["status"]

    # Statuswechsel ok -> fail: Incident, bei hub einmal Kickstart versuchen.
    for item in results:
        key = item["check_key"]
        before = previous.get(key)
        if before in ("ok", None) and item["status"] == "fail":
            action = None
            needs_jan = True
            if key == "hub":
                last_kick = float(state.get("hub_kick_at") or 0)
                if time.time() - last_kick > 600:
                    try:
                        uid = os.getuid()
                        proc = subprocess.run(
                            ["launchctl", "kickstart", "-k", "gui/%d/com.jarvis.briefinghub" % uid],
                            capture_output=True, text=True, timeout=20,
                        )
                        state.set("hub_kick_at", time.time())
                        action = "launchctl kickstart gui/%d/com.jarvis.briefinghub -> rc=%s %s" % (
                            uid, proc.returncode, _short(proc.stderr or proc.stdout, 120),
                        )
                        needs_jan = proc.returncode != 0
                    except Exception as exc:
                        action = "launchctl kickstart fehlgeschlagen: %s" % type(exc).__name__
                        needs_jan = True
                else:
                    action = "Kickstart in den letzten 10 min bereits versucht"
                    needs_jan = False
            incident(
                sb,
                "critical",
                "watchdog." + key,
                "Watchdog %s: %s" % (key, item["detail"]),
                action_taken=action,
                needs_jan=needs_jan,
            )
            event(sb, "jarvis", "watchdog", "Check %s auf fail gewechselt: %s" % (key, item["detail"]))

    try:
        sb.insert("watchdog_checks", results)
    except Exception as exc:
        log("watchdog_insert_failed err=%s" % _short(exc, 160))
        incident(sb, "warn", "staffd.watchdog", "Watchdog-Ergebnisse konnten nicht geschrieben werden")

    state.set("check_status", current)
    return {
        "checks": len(results),
        "check_status": current,
        "check_details": {item["check_key"]: item["detail"] for item in results},
    }


# --------------------------------------------------------------------------- Aufgabe 8

def task_metrics(sb, agents, cards, rate):
    """Vertrag 8.8 — Token je Agent und Stunde, tasks_done aus Kanban."""
    start, end = hour_bounds()
    start_ts, end_ts = start.timestamp(), end.timestamp()
    hour_iso = iso(start)

    done_by_agent = {}
    for card in cards:
        if str(card.get("status") or "").lower() != "done":
            continue
        completed = card.get("completed_at")
        if isinstance(completed, (int, float)) and start_ts <= completed < end_ts:
            key = card.get("assignee")
            done_by_agent[key] = done_by_agent.get(key, 0) + 1

    rows = []
    for agent in agents:
        key = agent.get("key")
        tokens, source_ok = tokens_between(key, start_ts, end_ts)
        rows.append({
            "hour": hour_iso,
            "agent_key": key,
            "tasks_done": int(done_by_agent.get(key, 0)),
            "tokens": int(tokens),
            "cost_eur": round(cost_eur(tokens, rate), 3),
            # Kanban liefert keinen "blockiert seit"-Zeitstempel; ohne echte Quelle
            # wird hier nichts erfunden, die Spalte bleibt 0.
            "blocked_minutes": 0,
            "meta_source_missing": not source_ok,
        })
    # meta_source_missing ist keine Spalte -> entfernen
    for row in rows:
        row.pop("meta_source_missing", None)
    sb.insert("metrics_hourly", rows, on_conflict="hour,agent_key", merge=True)
    return {"metrics_rows": len(rows), "metrics_hour": hour_iso}


# --------------------------------------------------------------------------- Lauf

def load_agents(sb):
    rows = sb.select("agents", "select=key,name,active&order=sort.asc")
    return [row for row in rows if row.get("active", True)]


def run_once(sb, state, force_all=True):
    """Ein vollstaendiger Durchlauf. Jede Teilaufgabe ist einzeln abgesichert."""
    started = time.time()
    errors = []
    stats = {}

    def step(name, func, *args, **kwargs):
        try:
            result = func(*args, **kwargs)
            if isinstance(result, dict):
                for key, value in result.items():
                    if key != "cards":
                        stats[key] = value
            return result
        except Exception as exc:
            message = "%s: %s" % (type(exc).__name__, _short(exc, 240))
            errors.append("%s (%s)" % (name, message))
            log("step_failed step=%s err=%s" % (name, message))
            try:
                incident(sb, "warn", "staffd." + name, "Teilaufgabe %s fehlgeschlagen: %s" % (name, message))
            except Exception:
                pass
            return None

    sb.ensure_auth()

    agents = []
    try:
        agents = load_agents(sb)
    except Exception as exc:
        errors.append("agents: %s" % _short(exc, 200))
        log("step_failed step=agents err=%s" % _short(exc, 200))

    rate = rate_eur_per_mtok(sb)

    step("expire_approvals", task_expire_approvals, sb)
    step("instructions", task_instructions, sb)
    step("approvals", task_approvals, sb)
    mirror = step("kanban", task_mirror_kanban, sb, {agent.get("key") for agent in agents})
    cards = (mirror or {}).get("cards", [])

    if agents:
        step("heartbeats", task_heartbeats, sb, agents, cards, rate)

    now = time.time()
    last_watchdog = float(state.get("last_watchdog") or 0)
    run_info = {
        "errors": errors,
        "duration_ms": int((time.time() - started) * 1000),
        "summary": "Lauf ok: %s" % json.dumps(stats, ensure_ascii=False, sort_keys=True)[:300],
    }
    if force_all or now - last_watchdog >= WATCHDOG_SECONDS:
        step("watchdog", task_watchdog, sb, state, run_info)
        state.set("last_watchdog", time.time())

    last_metrics = float(state.get("last_metrics") or 0)
    if force_all or now - last_metrics >= METRICS_SECONDS:
        if agents:
            step("metrics", task_metrics, sb, agents, cards, rate)
        state.set("last_metrics", time.time())

    duration = time.time() - started
    stats["errors"] = len(errors)
    stats["duration_s"] = round(duration, 2)
    state.set("runs", int(state.get("runs") or 0) + 1)
    state.set("last_run", datetime.now(timezone.utc).isoformat())
    state.set("last_error", errors[0] if errors else None)
    state.save()

    log(
        "run=%s ok=%s writes=%s dur=%.2fs %s"
        % (
            state.get("runs"),
            "yes" if not errors else "no",
            sb.writes,
            duration,
            " ".join("%s=%s" % (k, v) for k, v in sorted(stats.items()) if k not in ("check_details", "cards")),
        )
    )
    if errors:
        log("run_errors %s" % " | ".join(errors)[:600])
    return stats


def main(argv):
    once = "--once" in argv[1:]
    if "--help" in argv[1:] or "-h" in argv[1:]:
        print("staffd — JARVIS OS Staff-Board-Daemon\n\n  --once   genau ein Durchlauf, dann beenden\n  --help   diese Hilfe")
        return 0

    try:
        secrets = load_secrets()
    except Exception as exc:
        log("fatal %s" % exc)
        return 2

    state = State()
    sb = Supabase(
        secrets["SUPABASE_URL"],
        secrets["SUPABASE_ANON_KEY"],
        secrets["STAFF_AGENT_EMAIL"],
        secrets["STAFF_AGENT_PASSWORD"],
        state,
    )
    try:
        sb.ensure_auth()
    except Exception as exc:
        log("fatal login %s" % _short(exc, 200))
        return 2

    log("start once=%s board=%s python=%s" % (once, KANBAN_BOARD, sys.version.split()[0]))

    if once:
        stats = run_once(sb, state, force_all=True)
        print(json.dumps(stats, ensure_ascii=False, indent=2, default=str))
        return 0 if not stats.get("errors") else 1

    while True:
        try:
            run_once(sb, state, force_all=False)
        except Exception as exc:
            log("loop_error %s: %s" % (type(exc).__name__, _short(exc, 240)))
            try:
                incident(sb, "warn", "staffd.loop", "Durchlauf abgebrochen: %s" % type(exc).__name__)
            except Exception:
                pass
            log(traceback.format_exc(limit=3))
        time.sleep(LOOP_SECONDS)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(0)
