#!/usr/bin/env python3
"""Podcast on demand — state snapshot -> English dialogue -> Gemini TTS -> feed -> public mirror.

Called by staffd with a job id from `staff.podcast_jobs`. Every stage writes its own progress
back to the row, because the board only shows what is actually stored: no estimates, no fake
percentages.

Pipeline
  10  collecting   read board state (tasks, approvals, incidents, readiness, tokens)
  25  writing      Gemini writes a two-voice English script (JARVIS / NOVA)
  45  voicing      publish_night_podcast.py: one Gemini TTS request + feed row + verification
  80  published    episode is in the local feed
  92  mirroring    podcast_oeffentlich.sh pushes feed + mp3 to GitHub Pages (Apple Podcasts)
 100  done         public feed verified, enclosure reachable

Why one TTS request: the free tier allows ~10 TTS requests per day. The script is measured
against the spoken-character limit BEFORE the call, so a long script fails loudly instead of
silently splitting into two requests.

Usage:  python3 podcast_job.py <job_id>
"""
from __future__ import annotations

import json
import os
import ssl
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote
from datetime import datetime
from pathlib import Path

HOME = Path.home()
SECRETS = HOME / ".jarvis-os" / "secrets.env"
SCRIPTS = HOME / ".jarvis-os" / "podcast" / "scripts"
HUB = HOME / "jarvis-briefing-hub"
PUBLISH = HOME / ".hermes" / "scripts" / "publish_night_podcast.py"
MIRROR = HOME / ".hermes" / "scripts" / "podcast_oeffentlich.sh"
PUBLIC_FEED = "https://janbleile09-lab.github.io/jarvis-podcast/podcast.xml"
GEMINI_MODEL = os.getenv("PODCAST_SCRIPT_MODEL", "gemini-2.5-flash")
SPOKEN_LIMIT = 3400  # publish_night_podcast.py bricht oberhalb 3800 ab; Puffer fuer Sicherheit


def _ssl_context() -> ssl.SSLContext:
    """python.org-Builds haben keinen CA-Store — /etc/ssl/cert.pem ist der Systembund."""
    for path in ("/etc/ssl/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem"):
        try:
            return ssl.create_default_context(cafile=path)
        except Exception:
            continue
    return ssl.create_default_context()


CTX = _ssl_context()


def log(msg: str) -> None:
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def env() -> dict:
    out = {}
    for line in SECRETS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"')
    return out


def gemini_key() -> str:
    path = HOME / ".hermes" / ".env"
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("GEMINI_API_KEY"):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("GEMINI_API_KEY missing")


class Board:
    """Tiny PostgREST client for the staff schema, authenticated as the daemon agent."""

    def __init__(self, conf: dict):
        self.url = conf["SUPABASE_URL"].rstrip("/")
        self.key = conf["SUPABASE_ANON_KEY"]
        self.email = conf["STAFF_AGENT_EMAIL"]
        self.password = conf["STAFF_AGENT_PASSWORD"]
        self.token = self._login()

    def _login(self) -> str:
        body = json.dumps({"email": self.email, "password": self.password}).encode()
        req = urllib.request.Request(
            self.url + "/auth/v1/token?grant_type=password", data=body,
            headers={"apikey": self.key, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60, context=CTX) as res:
            return json.loads(res.read())["access_token"]

    def _headers(self) -> dict:
        return {"apikey": self.key, "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
                "Accept-Profile": "staff", "Content-Profile": "staff"}

    def select(self, table: str, query: str):
        req = urllib.request.Request(self.url + "/rest/v1/" + table + "?" + query,
                                     headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=60, context=CTX) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as exc:
            log("select %s failed: %s %s" % (table, exc.code, exc.read().decode()[:160]))
            return []

    def patch(self, table: str, query: str, payload: dict):
        req = urllib.request.Request(self.url + "/rest/v1/" + table + "?" + query,
                                     data=json.dumps(payload).encode(),
                                     headers=self._headers(), method="PATCH")
        try:
            with urllib.request.urlopen(req, timeout=60, context=CTX) as res:
                return res.status
        except urllib.error.HTTPError as exc:
            log("patch %s failed: %s %s" % (table, exc.code, exc.read().decode()[:160]))
            return None


def progress(board: Board, job_id: str, **fields) -> None:
    board.patch("podcast_jobs", "id=eq." + job_id, fields)
    log("job %s -> %s" % (job_id, fields.get("stage") or fields.get("status")))


def collect(board: Board) -> dict:
    """Everything worth telling Jan right now, compactly."""
    state = {}
    tasks = board.select("tasks", "select=agent_key,title,status,current_step&status=neq.done"
                                  "&order=updated_at.desc&limit=10")
    state["open_cards"] = [{"agent": t.get("agent_key"), "title": (t.get("title") or "")[:120],
                            "status": t.get("status"), "step": t.get("current_step")} for t in tasks]

    midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    done = board.select("tasks", "select=id&status=eq.done&updated_at=gte."
                                 + quote(midnight.isoformat(), safe=""))
    state["cards_done_today"] = len(done)

    state["approvals"] = [{"title": (a.get("title") or "")[:110], "kind": a.get("kind"),
                           "minutes": a.get("estimate_minutes"), "from": a.get("requested_by")}
                          for a in board.select("approvals", "select=title,kind,estimate_minutes,"
                                                             "requested_by&status=eq.open&limit=6")]
    state["incidents"] = [{"severity": i.get("severity"), "summary": (i.get("summary") or "")[:120],
                           "needs_jan": i.get("needs_jan")}
                          for i in board.select("incidents", "select=severity,summary,needs_jan"
                                                           "&resolved_at=is.null&limit=5")]
    hb = board.select("heartbeats", "select=agent_key,status,tokens_today&order=agent_key")
    state["agents"] = [{"name": h.get("agent_key"), "state": h.get("status"),
                        "tokens": h.get("tokens_today")} for h in hb]

    ready = board.select("readiness", "select=key,label,score,weight")
    if ready:
        total_w = sum(float(r.get("weight") or 0) for r in ready) or 1.0
        score = sum(float(r.get("score") or 0) / 5.0 * float(r.get("weight") or 0) for r in ready)
        state["readiness_pct"] = round(score / total_w * 100, 1)
        weakest = sorted(ready, key=lambda r: float(r.get("score") or 0))[:3]
        state["weakest"] = [{"area": w.get("label"), "score": w.get("score")} for w in weakest]

    state["events"] = [{"kind": e.get("kind"), "message": (e.get("message") or "")[:130]}
                       for e in board.select("events", "select=kind,message&order=ts.desc&limit=10")]
    return state


PROMPT = """You write the script for a short internal podcast that a founder listens to on his phone.

Speakers: JARVIS (the chief of staff, dry, precise) and NOVA (analyst, calm, adds the numbers).

Rules:
- English only.
- Start lines with "JARVIS:" or "NOVA:" — nothing else, no stage directions, no markdown, no emojis.
- Spoken length between 2000 and 3300 characters in total. Shorter is better.
- Numbers spoken out loud the way a person says them ("thirty-eight percent", not "38%").
- No greetings loop, no "welcome back", no filler. Start with the single most important fact.
- Say what changed, what is blocked, what needs the founder's decision, and one concrete next step.
- Never invent facts. If a list is empty, say it is empty.

Board state as JSON:
__STATE__
"""


def write_script(state: dict, key: str) -> Path:
    # Kein %-Formatieren: der Prompt enthaelt selbst Prozentzeichen ("38%").
    prompt = PROMPT.replace("__STATE__", json.dumps(state, ensure_ascii=False, indent=1))
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s"
        % (GEMINI_MODEL, gemini_key()),
        data=json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                         "generationConfig": {"temperature": 0.6, "maxOutputTokens": 3000}}).encode(),
        headers={"Content-Type": "application/json"})
    text = None
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180, context=CTX) as res:
                data = json.loads(res.read())
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            break
        except Exception as exc:          # 503 = Modell kurz ueberlastet, 429 = Takt
            last = exc
            wait = 8 * (attempt + 1)
            log("gemini attempt %d failed (%s), retry in %ds" % (attempt + 1, exc, wait))
            time.sleep(wait)
    if text is None:
        raise RuntimeError("gemini script failed: %s" % last)

    lines = []
    for raw in text.splitlines():
        line = raw.strip().lstrip("*-• ").strip()
        if not line:
            continue
        if re.match(r"^(JARVIS|NOVA)\s*:", line, re.I):
            speaker, _, rest = re.split(r":", line, maxsplit=1)[0], None, line.split(":", 1)[1]
            lines.append("%s: %s" % (speaker.upper().replace("NOVA", "NOVA"), rest.strip()))
        elif lines:
            lines[-1] = lines[-1] + " " + line
    if not lines:
        raise RuntimeError("model returned no speaker lines")

    spoken = sum(len(l.split(":", 1)[1].strip()) for l in lines)
    while spoken > SPOKEN_LIMIT and len(lines) > 4:
        dropped = lines.pop()
        spoken -= len(dropped.split(":", 1)[1].strip())
    if spoken > SPOKEN_LIMIT:
        lines = [lines[0][: SPOKEN_LIMIT]]
        spoken = len(lines[0].split(":", 1)[1])

    SCRIPTS.mkdir(parents=True, exist_ok=True)
    path = SCRIPTS / (key + ".txt")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log("script: %d lines, %d spoken chars" % (len(lines), spoken))
    return path


def trigger_pages_build() -> None:
    """GitHub Pages baut nicht zuverlaessig von allein — Build ausdruecklich anstossen.

    Befund 21.10.2026: der Push lag auf gh-pages, der oeffentliche Feed zeigte die Folge
    trotzdem nicht, weil der letzte Pages-Build Stunden alt war. Ohne diesen Anstoss bleibt
    eine Folge im Repository haengen und Apple Podcasts sieht sie nie.
    """
    try:
        subprocess.run(["gh", "api", "-X", "POST",
                        "repos/janbleile09-lab/jarvis-podcast/pages/builds"],
                       capture_output=True, text=True, timeout=90)
        log("pages build triggered")
    except Exception as exc:
        log("pages build trigger failed: %s" % exc)


def wait_public(key: str, seconds: int = 300) -> str | None:
    """Wartet, bis die Folge im oeffentlichen Feed steht (Pages braucht 1-3 Minuten)."""
    deadline = time.time() + seconds
    attempt = 0
    while time.time() < deadline:
        url = public_url_for(key)
        if url:
            return url
        attempt += 1
        if attempt % 3 == 1:
            trigger_pages_build()
        time.sleep(30)
    return None


def public_url_for(key: str) -> str | None:
    """Ask the public feed what enclosure it lists for this episode."""
    try:
        with urllib.request.urlopen(PUBLIC_FEED + "?t=%d" % int(time.time()), timeout=60, context=CTX) as res:
            feed = res.read().decode("utf-8", "replace")
    except Exception as exc:
        log("feed fetch failed: %s" % exc)
        return None
    for item in re.findall(r"<item>.*?</item>", feed, re.S):
        if key in item:
            found = re.search(r'<enclosure[^>]+url="([^"]+)"', item)
            return found.group(1) if found else None
    return None


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: podcast_job.py <job_id>")
        return 2
    job_id = sys.argv[1]
    board = Board(env())

    rows = board.select("podcast_jobs", "select=*&id=eq." + job_id)
    if not rows:
        log("job %s not found" % job_id)
        return 1
    job = rows[0]
    key = job.get("episode_key") or (datetime.now().strftime("%Y-%m-%d-live-%H%M"))
    title = job.get("title") or ("JARVIS Live — " + datetime.now().strftime("%d %b %Y, %H:%M"))

    try:
        progress(board, job_id, status="running", stage="collecting", progress=10,
                 started_at=datetime.now().astimezone().isoformat(), episode_key=key, title=title)
        state = collect(board)
        log("state: %d open cards, %d approvals, %d incidents"
            % (len(state.get("open_cards", [])), len(state.get("approvals", [])),
               len(state.get("incidents", []))))

        progress(board, job_id, stage="writing", progress=25)
        script = write_script(state, key)
        progress(board, job_id, stage="voicing", progress=45, script_path=str(script))

        env_vars = dict(os.environ)
        env_vars["GEMINI_TTS_LANG"] = "en-US"   # English voices, not German
        proc = subprocess.run(
            [str(HUB / ".venv/bin/python"), str(PUBLISH), "--script", str(script),
             "--title", title, "--key", key],
            cwd=str(HUB), capture_output=True, text=True, timeout=900, env=env_vars)
        if proc.returncode != 0:
            raise RuntimeError("publish failed rc=%d: %s"
                               % (proc.returncode, (proc.stdout + proc.stderr).strip()[-400:]))
        progress(board, job_id, stage="published", progress=80)

        mirror = subprocess.run(["zsh", str(MIRROR)], capture_output=True, text=True, timeout=600)
        if mirror.returncode != 0:
            raise RuntimeError("mirror failed: " + (mirror.stdout + mirror.stderr).strip()[-300:])
        progress(board, job_id, stage="publishing", progress=92)

        # Erst wenn die Folge wirklich oeffentlich abrufbar ist, gilt sie als veroeffentlicht.
        url = wait_public(key) or ("https://janbleile09-lab.github.io/jarvis-podcast/audio/"
                                   "podcast_%s.mp3" % key)
        progress(board, job_id, status="done", stage="done", progress=100,
                 finished_at=datetime.now().astimezone().isoformat(),
                 published_at=datetime.now().astimezone().isoformat(), audio_url=url)
        log("published: %s" % (url or "feed entry not found yet"))
        return 0
    except Exception as exc:
        log("FAILED: %s" % exc)
        progress(board, job_id, status="failed", stage="failed",
                 error=str(exc)[-400:], finished_at=datetime.now().astimezone().isoformat())
        return 1


if __name__ == "__main__":
    sys.exit(main())
