// JARVIS OS · Staff Board v2 — Anwendungslogik
//
// Regeln (CONTRACT.md Abschnitt 2–7):
//  · kein Framework, kein Build, ES-Module
//  · Daten ausschließlich über RPCs, Tabellen werden nie direkt gelesen
//  · Gerätetoken im Header `x-device-token` bei jedem RPC
//  · keine Inline-Handler, alles über addEventListener
//
// Aufbau: Helfer → Zustand → Zugang (Login/Gerät) → Board → Ansichten.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

/* ================================================================ Konstanten */

const TOKEN_KEY = 'jarvis_device_token';
const PENDING_KEY = 'jarvis_pending_device';
const POLL_MS = 5000;
const TZ = 'Europe/Berlin';
const SITE_URL = location.origin + location.pathname;

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
  db: { schema: 'staff' },
  global: {
    // Jede Anfrage trägt das Gerätetoken. Bewusst hier statt pro RPC-Aufruf:
    // supabase-js verwirft eigene Header im dritten rpc()-Argument.
    fetch: (input, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set('x-device-token', deviceToken());
      return fetch(input, { ...init, headers });
    },
  },
});

/* ================================================================ Helfer */

const $ = (sel, root = document) => root.querySelector(sel);

/** Element bauen. Attribute als Objekt; `on…`-Schlüssel werden zu addEventListener. */
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, kids);
  return node;
}

function append(node, kids) {
  for (const kid of (kids || []).flat(3)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

function clear(node) {
  if (node) node.replaceChildren();
}

function frag(...kids) {
  const f = document.createDocumentFragment();
  append(f, kids);
  return f;
}

function svg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

/* ---------------------------------------------------------------- Zahlen & Zeit */

const nfInt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nfEur = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtTimeSec = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ });
const fmtDay = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: TZ });
const fmtStamp = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const berlinDay = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });
const berlinHour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ });

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
const dateOf = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

function fmtInt(n) {
  return nfInt.format(num(n));
}

function fmtTok(n) {
  const v = num(n);
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio`;
  if (v >= 1e3) return `${(v / 1e3).toLocaleString('de-DE', { maximumFractionDigits: 0 })}k`;
  return fmtInt(v);
}

function fmtEur(n) {
  return `${nfEur.format(num(n))} €`;
}

/** Alter seit ISO-Zeitpunkt, kurz und ohne Übertreibung. */
function fmtAge(iso) {
  const d = dateOf(iso);
  if (!d) return 'kein Signal';
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h`;
  return `${Math.round(h / 24)} Tage`;
}

function fmtWhen(iso) {
  const d = dateOf(iso);
  return d ? fmtStamp.format(d) : '—';
}

/** Restzeit bis Frist: „in 5 h 48 min", „abgelaufen". */
function fmtUntil(iso) {
  const d = dateOf(iso);
  if (!d) return 'keine Frist';
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 'abgelaufen';
  const min = Math.round(ms / 60000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  const rm = min % 60;
  if (h < 24) return `in ${h} h ${rm} min`;
  return `in ${Math.floor(h / 24)} Tagen`;
}

function pct(n) {
  const v = Math.max(0, Math.min(100, num(n)));
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`;
}

/* ---------------------------------------------------------------- Vokabular */

const AGENT_STATUS = {
  running: { label: 'arbeitet', cls: 'ok', dot: '' },
  waiting: { label: 'wartet', cls: 'warn', dot: 'w' },
  error: { label: 'Fehler', cls: 'bad', dot: 'b' },
  idle: { label: 'bereit', cls: 'idle', dot: 'n' },
};

const TASK_STATUS = {
  todo: 'offen', scheduled: 'geplant', running: 'läuft',
  blocked: 'blockiert', review: 'Review', done: 'fertig',
};

const APPROVAL_KIND = {
  subagents: 'Subagents', deploy: 'Deploy', purchase: 'Kauf',
  delete: 'Löschen', external: 'extern sichtbar', other: 'sonstiges',
};

const APPROVAL_STATUS = {
  open: 'offen', approved: 'genehmigt', denied: 'abgelehnt',
  expired: 'abgelaufen', withdrawn: 'zurückgezogen',
};

const RISK = { low: 'niedrig', medium: 'mittel', high: 'hoch' };

const REASONS = {
  device_not_trusted: 'Dieses Gerät ist nicht freigeschaltet.',
  not_trusted: 'Dieses Gerät ist nicht freigeschaltet.',
  no_session: 'Sitzung abgelaufen. Bitte neu anmelden.',
  not_owner: 'Nur der Inhaber darf diesen Schritt ausführen.',
  already_claimed: 'Der Inhaberzugang ist bereits vergeben.',
  code_invalid: 'Zugangscode ungültig.',
  too_short: 'Eingabe zu kurz.',
  weak_token: 'Gerätetoken zu schwach — Seite neu laden.',
  device_unknown: 'Gerät unbekannt. Bitte neu anmelden.',
  no_question: 'Es ist noch keine Sicherheitsfrage gesetzt.',
  wrong: 'Antwort falsch.',
  locked: 'Gesperrt. Bitte später erneut versuchen.',
  bad_decision: 'Ungültige Entscheidung.',
  bad_score: 'Score muss zwischen 0 und 5 liegen.',
  unknown_key: 'Unbekannter Schlüssel.',
  unknown_agent: 'Unbekannter Agent.',
  not_found: 'Eintrag nicht gefunden.',
  already_decided: 'Bereits entschieden.',
  not_agent: 'Nur der Daemon darf das.',
};

function reasonText(res) {
  if (!res) return 'Keine Antwort vom Server.';
  const base = REASONS[res.reason] || `Abgelehnt (${res.reason || 'unbekannt'}).`;
  if (res.reason === 'locked' && res.until) return `Gesperrt bis ${fmtTime.format(dateOf(res.until) || new Date())}.`;
  if (res.reason === 'wrong' && typeof res.attempts_left === 'number') {
    const n = res.attempts_left;
    return `Antwort falsch. Noch ${n} ${n === 1 ? 'Versuch' : 'Versuche'}.`;
  }
  return base;
}

function initials(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const parts = s.split(/[\s_-]+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

const AV_CLASSES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
function avClass(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 997;
  return AV_CLASSES[h % AV_CLASSES.length];
}

/* ================================================================ Zustand */

const state = {
  session: null,
  status: null,      // device_status
  board: null,
  view: 'overview',
  pollTimer: null,
  inflight: false,
  routing: false,
  renderPending: false,
  connection: { ok: false, note: 'nicht verbunden' },
  pendingDevice: null, // { id, question }
  drafts: new Map(),   // Eingaben, die ein Re-Render überleben müssen
  openNote: null,      // Freigabe-ID mit ausgeklapptem Anweisungsfeld
  openCrit: null,      // Kriterien-Schlüssel mit offenem Editor
  revokedConfirm: null,
};

/* ================================================================ Gerätetoken */

/** 32 Byte Zufall als Hex, einmal pro Browser. */
function deviceToken() {
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* privater Modus */ }
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    token = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* dann nur für diese Sitzung */ }
  }
  return token;
}

function readPending() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writePending(value) {
  try {
    if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch { /* egal */ }
}

/* ================================================================ RPC */

async function rpc(name, args = {}) {
  // Das Gerätetoken setzt der fetch-Wrapper am Client (siehe oben).
  const { data, error } = await sb.rpc(name, args);
  if (error) {
    const err = new Error(error.message || `RPC ${name} fehlgeschlagen`);
    err.code = error.code;
    throw err;
  }
  return data;
}

/* ================================================================ Rückmeldung */

let toastTimer = null;
function toast(text, kind = '') {
  const node = $('#toast');
  if (!node) return;
  node.textContent = text;
  node.className = `on ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = kind; }, 4200);
}

function setMsg(node, text, kind = '') {
  if (!node) return;
  node.textContent = text || '';
  node.className = `msg ${kind}`.trim();
}

/** Button gegen Doppelklick sperren, Fehler auffangen. */
async function guard(button, fn) {
  const label = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = 'läuft …'; }
  try {
    await fn();
  } catch (e) {
    toast(e.message || 'Aktion fehlgeschlagen', 'bad');
  } finally {
    if (button && button.isConnected) { button.disabled = false; button.textContent = label; }
  }
}

/* ================================================================ Ansichten umschalten */

const GATES = ['view-login', 'view-claim', 'view-device', 'view-denied'];

function showOnly(id) {
  for (const gate of GATES) {
    const node = document.getElementById(gate);
    if (node) node.hidden = gate !== id;
  }
  const shell = $('#shell');
  if (shell) shell.hidden = id !== 'shell';
  if (id !== 'shell') stopPolling();
}

function setView(view) {
  state.view = view;
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.classList.toggle('on', btn.dataset.view === view);
  }
  for (const pane of document.querySelectorAll('section.view')) {
    pane.classList.toggle('on', pane.dataset.pane === view);
  }
  renderActiveView(true);
}

/* ================================================================ Zugang */

async function boot() {
  deviceToken();
  wireLogin();
  wireGateChrome();
  wireTabs();
  handleUrlError();

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.session = null;
      state.status = null;
      state.board = null;
      showOnly('view-login');
    } else if (event === 'SIGNED_IN') {
      // Nach Magic-Link-Login oder Token-Erneuerung den Gate erneut prüfen.
      // Verzögert, weil Auth-Aufrufe im Callback die Session-Sperre blockieren können.
      if (!state.status || !state.status.authenticated) setTimeout(() => { route(); }, 0);
    }
  });

  await route();
}

/** Vom Login bis zum Board — eine Entscheidung pro Zustand. */
async function route() {
  // Boot und Auth-Event können gleichzeitig auslösen; ein Durchlauf genügt.
  if (state.routing) return;
  state.routing = true;
  try {
    await routeOnce();
  } finally {
    state.routing = false;
  }
}

async function routeOnce() {
  const { data, error } = await sb.auth.getSession();
  if (error) { toast(error.message, 'bad'); showOnly('view-login'); return; }
  const session = data && data.session ? data.session : null;
  state.session = session;
  if (!session) { showOnly('view-login'); return; }

  let st = null;
  try {
    st = await rpc('device_status');
  } catch (e) {
    toast(`Statusabfrage fehlgeschlagen: ${e.message}`, 'bad');
    showOnly('view-login');
    return;
  }
  state.status = st || {};

  if (!st || !st.authenticated) { showOnly('view-login'); return; }

  if (!st.member) {
    showOnly(st.owner_claimed ? 'view-denied' : 'view-claim');
    return;
  }

  if (!st.trusted) {
    state.pendingDevice = readPending();
    await startDeviceGate();
    return;
  }

  await openBoard();
}

async function startDeviceGate() {
  showOnly('view-device');
  if (state.status && state.status.has_question === false) {
    renderQuestionForm();
    return;
  }
  await renderRegisterForm();
}

/* ---------------------------------------------------------------- Login */

function wireLogin() {
  const input = $('#login-email');
  const button = $('#login-send');
  const msg = $('#login-msg');
  if (!input || !button) return;

  const send = () => guard(button, async () => {
    const email = input.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setMsg(msg, 'Bitte eine gültige E-Mail-Adresse eingeben.', 'warn');
      return;
    }
    setMsg(msg, '');
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: SITE_URL },
    });
    if (error) { setMsg(msg, error.message, 'bad'); return; }
    setMsg(msg, 'Mail ist unterwegs. Link in der Mail öffnen, dann hier weiter.', 'ok');
  });

  button.addEventListener('click', send);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') send(); });

  // Passwort-Anmeldung: zuverlaessiger Weg, weil iCloud Magic-Links vorab oeffnen kann
  // und sie damit verbraucht sind.
  const pass = $('#login-pass');
  const submit = $('#login-submit');
  if (submit && pass) {
    const login = () => guard(submit, async () => {
      const email = input.value.trim();
      const pw = pass.value;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || pw.length < 6) {
        setMsg(msg, 'Bitte E-Mail und Passwort eingeben.', 'warn');
        return;
      }
      setMsg(msg, '');
      const { error } = await sb.auth.signInWithPassword({ email, password: pw });
      if (error) { setMsg(msg, error.message, 'bad'); return; }
      pass.value = '';
      await route();
    });
    submit.addEventListener('click', login);
    pass.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') login(); });
  }
}

function handleUrlError() {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.search.slice(1);
  if (!raw) return;
  const params = new URLSearchParams(raw);
  const desc = params.get('error_description') || params.get('error');
  if (!desc) return;
  const msg = $('#login-msg');
  setMsg(msg, `Anmeldung fehlgeschlagen: ${desc.replace(/\+/g, ' ')}`, 'bad');
  history.replaceState(null, '', location.pathname);
}

/* ---------------------------------------------------------------- Gate-Rahmen */

function wireGateChrome() {
  const logout = async () => {
    await sb.auth.signOut();
    state.status = null;
    state.board = null;
    showOnly('view-login');
  };
  for (const id of ['claim-logout', 'device-logout', 'denied-logout']) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', logout);
  }

  // Zugangscode übernehmen
  const claimBtn = $('#claim-send');
  if (claimBtn) {
    const code = $('#claim-code');
    const msg = $('#claim-msg');
    const send = () => guard(claimBtn, async () => {
      const value = code.value.trim();
      if (!value) { setMsg(msg, 'Bitte den Zugangscode eingeben.', 'warn'); return; }
      const res = await rpc('claim_owner', { p_code: value });
      if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
      setMsg(msg, 'Zugang übernommen. Sicherheitsfrage wird jetzt eingerichtet.', 'ok');
      await route();
    });
    claimBtn.addEventListener('click', send);
    code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') send(); });
  }
}

/* ---------------------------------------------------------------- Sicherheitsfrage setzen */

function renderQuestionForm() {
  const body = $('#device-body');
  const msg = $('#device-msg');
  clear(body);
  setMsg(msg, '');

  const q = el('input', { class: 'inp', type: 'text', autocomplete: 'off', placeholder: 'z. B. Name der ersten Werkstatt' });
  const a = el('input', { class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Frage speichern' });

  btn.addEventListener('click', () => guard(btn, async () => {
    if (q.value.trim().length < 6 || a.value.trim().length < 3) {
      setMsg(msg, 'Frage mindestens 6 Zeichen, Antwort mindestens 3 Zeichen.', 'warn');
      return;
    }
    const res = await rpc('set_security_question', { p_question: q.value.trim(), p_answer: a.value.trim() });
    if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
    if (state.status) state.status.has_question = true;
    setMsg(msg, 'Frage gespeichert. Die Antwort ist nicht wiederherstellbar.', 'ok');
    await renderRegisterForm();
  }));

  append(body, [
    el('h2', { text: 'Sicherheitsfrage festlegen' }),
    el('p', { class: 'help', text: 'Diese Frage schützt neue Geräte. Die Antwort wird nur als Hash gespeichert — merk sie dir.' }),
    el('label', { class: 'lbl', text: 'Frage' }), q,
    el('label', { class: 'lbl', text: 'Antwort' }), a,
    el('div', { class: 'row' }, btn),
  ]);
  setTimeout(() => q.focus(), 0);
}

/* ---------------------------------------------------------------- Gerät anmelden */

function guessLabel() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : 'Browser';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
          : 'Browser';
  return `${device} · ${browser}`;
}

async function renderRegisterForm() {
  const body = $('#device-body');
  const msg = $('#device-msg');
  if (!body) return;

  // Schon ein offenes Gerät aus dieser Sitzung? Dann direkt die Antwort abfragen.
  const pending = state.pendingDevice || readPending();
  if (pending && pending.id && pending.question) {
    state.pendingDevice = pending;
    renderAnswerForm(pending.question, pending.id);
    return;
  }

  clear(body);
  setMsg(msg, '');

  const label = el('input', { class: 'inp', type: 'text', autocomplete: 'off', value: guessLabel() });
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Dieses Gerät anmelden' });

  btn.addEventListener('click', () => guard(btn, async () => {
    const res = await rpc('register_device', {
      p_label: label.value.trim() || 'Gerät',
      p_ua: navigator.userAgent.slice(0, 200),
      p_token: deviceToken(),
    });
    if (!res || !res.ok) {
      if (res && res.reason === 'no_question') { renderQuestionForm(); return; }
      setMsg(msg, reasonText(res), 'bad');
      return;
    }
    if (res.needs_question || !res.question) { renderQuestionForm(); return; }
    const next = { id: res.device_id, question: res.question };
    state.pendingDevice = next;
    writePending(next);
    renderAnswerForm(res.question, res.device_id);
  }));

  append(body, [
    el('h2', { text: 'Neues Gerät freischalten' }),
    el('p', { class: 'help', text: 'Dieses Gerät ist angemeldet, aber noch nicht freigeschaltet. Zur Bestätigung die Sicherheitsfrage beantworten.' }),
    el('label', { class: 'lbl', text: 'Bezeichnung dieses Geräts' }), label,
    el('div', { class: 'row' }, btn),
  ]);
}

function renderAnswerForm(question, deviceId) {
  const body = $('#device-body');
  const msg = $('#device-msg');
  clear(body);
  setMsg(msg, '');

  const answer = el('input', { class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Antwort prüfen' });

  const submit = () => guard(btn, async () => {
    if (!answer.value.trim()) { setMsg(msg, 'Bitte die Antwort eingeben.', 'warn'); return; }
    const res = await rpc('answer_device', { p_device: deviceId, p_answer: answer.value.trim() });
    if (res && res.ok) {
      state.pendingDevice = null;
      writePending(null);
      if (state.status) state.status.trusted = true;
      setMsg(msg, 'Gerät freigeschaltet.', 'ok');
      await openBoard();
      return;
    }
    if (res && res.reason === 'no_question') { renderQuestionForm(); return; }
    if (res && res.reason === 'device_unknown') {
      state.pendingDevice = null;
      writePending(null);
      await renderRegisterForm();
      return;
    }
    setMsg(msg, reasonText(res), 'bad');
    answer.value = '';
    answer.focus();
  });

  btn.addEventListener('click', submit);
  answer.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

  append(body, [
    el('h2', { text: 'Sicherheitsfrage' }),
    el('p', { class: 'help', text: 'Beantworte die hinterlegte Frage, um dieses Gerät freizuschalten. Drei Fehlversuche sperren die Abfrage für 15 Minuten.' }),
    el('p', { class: 'rec', text: question }),
    el('label', { class: 'lbl', text: 'Antwort' }), answer,
    el('div', { class: 'row' }, btn),
  ]);
  setTimeout(() => answer.focus(), 0);
}

/* ================================================================ Board laden */

async function openBoard() {
  showOnly('shell');
  await refresh(true);
  startPolling();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;      // kein Polling im Hintergrund
    refresh();
  }, POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.status && state.status.trusted) refresh();
});

async function refresh(force = false) {
  if (!state.status || !state.status.trusted) return;
  if (state.inflight) return;
  state.inflight = true;
  try {
    const data = await rpc('board');
    if (!data || data.ok !== true) {
      if (data && data.reason === 'device_not_trusted') {
        state.status.trusted = false;
        state.board = null;
        stopPolling();
        await startDeviceGate();
        return;
      }
      state.connection = { ok: false, note: data && data.reason ? reasonText(data) : 'Board nicht verfügbar' };
      renderChrome();
      return;
    }
    state.board = data;
    state.connection = { ok: true, note: 'verbunden' };
    renderChrome();
    renderActiveView(force);
  } catch (e) {
    state.connection = { ok: false, note: e.message || 'Verbindung gestört' };
    renderChrome();
  } finally {
    state.inflight = false;
  }
}

/* ================================================================ Rahmen (Kopf, Tabs) */

function renderChrome() {
  const b = state.board;
  const pills = $('#pills');
  if (pills) {
    clear(pills);
    const openApprovals = b ? (b.approvals || []).filter((a) => a.status === 'open').length : 0;
    const watchdog = worstWatchdog(b ? b.watchdog : []);
    const failing = (b ? b.watchdog || [] : []).filter((w) => w.status === 'fail').length;

    const watchdogPill = el('span', {
      class: 'pill',
      title: failing ? `${failing} Watchdog-Check(s) fehlgeschlagen` : 'Watchdog-Zustand aus dem letzten Lauf',
    }, el('span', { class: `dot ${watchdog.dot}` }), watchdog.text);

    append(pills, [
      el('span', { class: 'pill' },
        el('span', { class: `dot ${state.connection.ok ? '' : 'b'}` }),
        state.connection.ok ? 'verbunden' : 'getrennt'),
      watchdogPill,
      el('span', { class: 'pill' },
        el('span', { class: `dot ${openApprovals ? 'w' : 'n'}` }),
        b ? (openApprovals ? `${openApprovals} Freigabe${openApprovals === 1 ? '' : 'n'} offen` : 'keine offenen Freigaben') : 'Noch keine Daten'),
      el('span', { class: 'pill', text: `Stand ${fmtTimeSec.format(new Date())}` }),
    ]);
  }

  const tabCount = $('#tab-approvals');
  if (tabCount) {
    const openApprovals = b ? (b.approvals || []).filter((a) => a.status === 'open').length : 0;
    tabCount.textContent = String(openApprovals);
    tabCount.style.display = openApprovals ? '' : 'none';
  }
}

function worstWatchdog(list) {
  if (!list || !list.length) return { dot: 'n', text: 'Watchdog: keine Daten' };
  if (list.some((w) => w.status === 'fail')) return { dot: 'b', text: 'Watchdog: Störung' };
  if (list.some((w) => w.status === 'warn')) return { dot: 'w', text: 'Watchdog: Warnung' };
  return { dot: '', text: 'Watchdog aktiv' };
}

function wireTabs() {
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }
}

/* ================================================================ Zeichnen */

const PANES = {
  overview: renderOverview,
  live: renderLive,
  approvals: renderApprovals,
  analytics: renderAnalytics,
  readiness: renderReadiness,
  ops: renderOps,
};

function renderActiveView(force = false) {
  const ae = document.activeElement;
  const typing = !force && ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName)
    && $('#shell') && $('#shell').contains(ae);
  if (typing) { state.renderPending = true; return; }
  state.renderPending = false;
  const fn = PANES[state.view];
  if (fn) fn(state.board);
}

document.addEventListener('focusout', () => {
  setTimeout(() => {
    const ae = document.activeElement;
    const stillTyping = ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName);
    if (state.renderPending && !stillTyping) renderActiveView();
  }, 0);
});

/* ---------------------------------------------------------------- gemeinsame Bausteine */

function agentAvatar(agent, size) {
  const cls = avClass(agent && agent.key);
  return el('div', {
    class: `av ${cls}`,
    style: size ? { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size / 2.8)}px` } : null,
    text: initials((agent && (agent.name || agent.key)) || '?'),
  });
}

function statusPill(agent) {
  const st = AGENT_STATUS[(agent && agent.status) || ''] || { label: 'kein Signal', cls: 'idle', dot: 'n' };
  const hasSignal = agent && agent.last_seen;
  return el('span', {
    class: 'pill',
    title: hasSignal ? `Letztes Lebenszeichen ${fmtAge(agent.last_seen)}` : 'Noch kein Lebenszeichen',
  },
    el('span', { class: `dot ${st.dot}` }),
    st.label);
}

function emptyState(text) {
  return el('div', { class: 'empty', text });
}

function taskForAgent(tasks, key) {
  const mine = (tasks || []).filter((t) => t.agent_key === key);
  const order = { running: 0, blocked: 1, review: 2, scheduled: 3, todo: 4, done: 5 };
  mine.sort((a, b) => {
    const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (d !== 0) return d;
    return num(a.priority) - num(b.priority);
  });
  return mine;
}

function draftField(key, attrs, fallback = '') {
  const node = el('textarea', { class: 'inp', ...(attrs || {}) });
  node.value = state.drafts.has(key) ? state.drafts.get(key) : fallback;
  node.addEventListener('input', () => state.drafts.set(key, node.value));
  return node;
}

function takeDraft(key, fallback = '') {
  const v = state.drafts.has(key) ? state.drafts.get(key) : fallback;
  return String(v || '').trim();
}

function dropDraft(key) {
  state.drafts.delete(key);
}

/* ================================================================ 01 Übersicht */

function renderOverview(board) {
  const orgBox = $('#overview-org');
  const cardsBox = $('#overview-cards');
  if (!orgBox || !cardsBox) return;

  const agents = board ? board.agents || [] : [];
  const tasks = board ? board.tasks || [] : [];

  /* --- Organigramm --- */
  clear(orgBox);
  if (!agents.length) {
    orgBox.append(emptyState('Noch keine Daten — der Daemon hat noch keine Agenten gemeldet.'));
  } else {
    const coo = agents.find((a) => a.key === 'jarvis')
      || agents.find((a) => !a.reports_to && num(a.level) >= 2)
      || agents[0];
    const leaders = agents.filter((a) => a !== coo && (a.reports_to === coo.key || num(a.level) > num(coo.level)));

    const org = el('div', { class: 'org' });
    org.append(
      el('div', { class: 'node' },
        el('div', { class: 'av a', text: 'JB' }),
        el('div', {},
          el('div', { class: 'who', text: 'Jan Bleile' }),
          el('div', { class: 'role', text: 'Inhaber · letzte Instanz für Freigaben, Budget, Strategie' })),
        el('div', { class: 'meta' }, el('span', { class: 'pill' }, el('span', { class: 'dot' }), 'online'))),
      el('div', { class: 'link' }),
      el('div', { class: 'node coo' },
        agentAvatar(coo),
        el('div', {},
          el('div', { class: 'who', text: coo.name || coo.key }),
          el('div', { class: 'role', text: [coo.role, coo.mandate].filter(Boolean).join(' · ') || 'ohne Auftrag' })),
        el('div', { class: 'meta' },
          el('span', { class: 'pill', text: `${leaders.length} Bereich${leaders.length === 1 ? '' : 'e'}` }),
          statusPill(coo))),
    );

    if (leaders.length) {
      const team = el('div', { class: 'team' });
      for (const lead of leaders) {
        team.append(el('div', { class: 'lead' },
          el('div', { class: 'top' },
            agentAvatar(lead),
            el('div', {},
              el('div', { class: 'who', text: lead.name || lead.key }),
              el('div', { class: 'role', text: lead.role || 'ohne Rolle' }))),
          el('div', { class: 'trait', text: lead.personality ? `„${lead.personality}“` : 'Keine Persönlichkeit hinterlegt.' }),
          el('span', { class: 'badge', text: lead.limits || lead.model || 'keine Grenzen hinterlegt' })));
      }
      org.append(team);
    }
    orgBox.append(org);
  }

  /* --- Live-Karten --- */
  clear(cardsBox);
  if (!agents.length) {
    cardsBox.append(emptyState('Noch keine Daten.'));
    return;
  }
  const grid = el('div', { class: 'grid' });
  for (const agent of agents) {
    const mine = taskForAgent(tasks, agent.key);
    const active = mine.find((t) => t.status === 'running')
      || mine.find((t) => t.status === 'blocked')
      || mine.find((t) => t.status === 'review')
      || mine.find((t) => t.status !== 'done')
      || null;
    const st = AGENT_STATUS[agent.status || ''] || { label: 'kein Signal', cls: 'idle' };
    const cardClass = st.cls === 'ok' ? 'card run' : st.cls === 'warn' ? 'card wait' : st.cls === 'bad' ? 'card err' : 'card';

    grid.append(el('div', { class: cardClass },
      el('div', { class: 'ch' },
        agentAvatar(agent),
        el('div', {},
          el('div', { class: 'who', text: agent.name || agent.key }),
          el('div', { class: 'role', text: agent.role || 'ohne Rolle' })),
        el('span', { class: `st ${st.cls}`, text: st.label })),
      el('div', { class: 'task', text: active ? active.title : 'Keine offene Karte' }),
      el('div', {
        class: 'step',
        text: active
          ? [active.current_step, active.detail].filter(Boolean).join(' · ') || 'ohne Schrittangabe'
          : (agent.mandate || 'Auftrag noch nicht beschrieben'),
      }),
      el('div', { class: 'bar' }, el('i', {
        style: { width: `${Math.max(2, Math.min(100, num(active ? active.progress : 0)))}%` },
        class: active && active.status === 'blocked' ? 'w' : null,
      })),
      el('div', { class: 'meta' },
        el('span', {}, 'Heartbeat ', el('b', { text: fmtAge(agent.last_seen) })),
        el('span', {}, 'Heute ', el('b', { text: `${fmtTok(agent.tokens_today)} Token` })),
        el('span', {}, el('b', { text: fmtEur(agent.cost_eur_today) }))),
      el('div', { class: 'acts' },
        el('button', {
          class: 'btn acc', type: 'button', text: 'Anweisung',
          onclick: () => { setView('live'); setTimeout(() => focusInstruction(agent.key), 0); },
        }),
        el('button', {
          class: 'btn', type: 'button', text: 'Live-Board',
          onclick: () => setView('live'),
        }))));
  }
  cardsBox.append(grid);
}

function focusInstruction(agentKey) {
  const field = document.getElementById(`instr-${agentKey}`);
  if (field) { field.focus(); field.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

/* ================================================================ 02 Live-Board */

function renderLive(board) {
  const box = $('#live-body');
  if (!box) return;
  clear(box);

  const agents = board ? board.agents || [] : [];
  const tasks = board ? board.tasks || [] : [];
  const events = board ? board.events || [] : [];

  if (!agents.length) {
    box.append(emptyState('Noch keine Daten — keine Agenten gemeldet.'));
    return;
  }

  const wrap = el('div', {});
  for (const agent of agents) {
    const mine = taskForAgent(tasks, agent.key);
    const current = mine.filter((t) => t.status !== 'done');
    const history = events.filter((e) => e.agent_key === agent.key).slice(0, 6);
    const st = AGENT_STATUS[agent.status || ''] || { label: 'kein Signal', cls: 'idle' };
    const draftKey = `instr:${agent.key}`;

    const field = draftField(draftKey, {
      placeholder: `Anweisung an ${agent.name || agent.key} — was soll als Nächstes passieren?`,
      rows: 2,
    });
    field.id = `instr-${agent.key}`;

    const msg = el('p', { class: 'msg' });
    const send = el('button', { class: 'btn acc', type: 'button', text: 'Anweisung senden' });
    send.addEventListener('click', () => guard(send, async () => {
      const body = takeDraft(draftKey);
      if (body.length < 3) { setMsg(msg, 'Anweisung zu kurz (mindestens 3 Zeichen).', 'warn'); return; }
      const res = await rpc('instruct', { p_target: agent.key, p_body: body });
      if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
      dropDraft(draftKey);
      field.value = '';
      setMsg(msg, 'Anweisung in der Warteschlange. Der Daemon übergibt sie an Hermes.', 'ok');
      refresh();
    }));

    const pauseBtn = el('button', { class: 'btn', type: 'button', text: 'Pausieren' });
    pauseBtn.disabled = !current.length;
    pauseBtn.addEventListener('click', () => {
      const card = current[0];
      if (!card) return;
      guard(pauseBtn, async () => {
        const res = await rpc('upsert_task', {
          p_id: card.id, p_agent: agent.key, p_title: null, p_detail: null,
          p_status: 'blocked', p_progress: null, p_step: 'Von Jan pausiert',
        });
        if (!res || !res.ok) { toast(reasonText(res), 'bad'); return; }
        toast(`„${card.title}“ pausiert.`, 'ok');
        refresh();
      });
    });

    const restartBtn = el('button', { class: 'btn', type: 'button', text: 'Neu starten' });
    restartBtn.disabled = !current.length;
    restartBtn.addEventListener('click', () => {
      const card = current[0];
      if (!card) return;
      guard(restartBtn, async () => {
        const res = await rpc('upsert_task', {
          p_id: card.id, p_agent: agent.key, p_title: null, p_detail: null,
          p_status: 'todo', p_progress: 0, p_step: 'Von Jan neu angestoßen',
        });
        if (!res || !res.ok) { toast(reasonText(res), 'bad'); return; }
        toast(`„${card.title}“ neu angestoßen.`, 'ok');
        refresh();
      });
    });

    const card = el('div', { class: 'card' },
      el('div', { class: 'ch' },
        agentAvatar(agent),
        el('div', {},
          el('div', { class: 'who', text: agent.name || agent.key }),
          el('div', { class: 'role', text: [agent.role, agent.model].filter(Boolean).join(' · ') || 'ohne Rolle' })),
        el('span', { class: `st ${st.cls}`, text: st.label })),

      el('div', { class: 'meta', style: { marginBottom: '10px' } },
        el('span', {}, 'Heartbeat ', el('b', { text: fmtAge(agent.last_seen) })),
        el('span', {}, 'Token heute ', el('b', { text: fmtTok(agent.tokens_today) })),
        el('span', {}, el('b', { text: fmtEur(agent.cost_eur_today) })),
        el('span', {}, 'Budget ', el('b', { text: fmtEur(agent.budget_eur_day) }), ' / Tag')),

      current.length
        ? el('div', {}, ...current.slice(0, 6).map((t) => el('div', { style: { padding: '7px 0', borderTop: '1px solid #1e242c' } },
          el('div', { class: 'task', text: t.title || 'ohne Titel' }),
          el('div', { class: 'step', text: [TASK_STATUS[t.status] || t.status, t.current_step, `Stand ${fmtAge(t.updated_at)}`].filter(Boolean).join(' · ') }),
          el('div', { class: 'bar' }, el('i', {
            style: { width: `${Math.max(2, Math.min(100, num(t.progress)))}%` },
            class: t.status === 'blocked' ? 'w' : null,
          })))))
        : el('div', { class: 'step', text: 'Keine offene Karte für diesen Agenten.' }),

      el('div', { style: { borderTop: '1px solid #1e242c', marginTop: '6px', paddingTop: '10px' } },
        el('label', { class: 'lbl', for: `instr-${agent.key}`, text: `Anweisung an ${agent.name || agent.key}` }),
        field,
        el('div', { class: 'row' }, send, pauseBtn, restartBtn),
        msg),

      el('div', { style: { borderTop: '1px solid #1e242c', marginTop: '10px', paddingTop: '9px' } },
        el('div', { class: 'role', style: { marginBottom: '6px' }, text: 'Verlauf' }),
        history.length
          ? el('div', {}, ...history.map((e) => el('div', { class: 'inc', style: { fontSize: '11.5px', padding: '6px 0' } },
            el('div', { class: 'tm', text: fmtTime.format(dateOf(e.ts) || new Date()) }),
            el('div', {}, e.message || e.kind || '—'))))
          : el('div', { class: 'step', text: 'Noch keine Ereignisse.' })));

    wrap.append(card);
  }
  box.append(wrap);
}

/* ================================================================ 03 Freigaben */

function renderApprovals(board) {
  const box = $('#approvals-body');
  if (!box) return;
  clear(box);

  const all = board ? board.approvals || [] : [];
  const open = all.filter((a) => a.status === 'open')
    .sort((a, b) => {
      const da = dateOf(a.expires_at); const db = dateOf(b.expires_at);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const decided = all.filter((a) => a.status !== 'open')
    .filter((a) => {
      const d = dateOf(a.decided_at) || dateOf(a.created_at);
      return d ? d.getTime() >= cutoff : false;
    })
    .sort((a, b) => (dateOf(b.decided_at) || dateOf(b.created_at) || 0) - (dateOf(a.decided_at) || dateOf(a.created_at) || 0));

  if (!all.length) {
    box.append(emptyState('Noch keine Daten — keine Freigaben vorhanden.'));
    return;
  }

  if (!open.length) {
    box.append(emptyState('Keine offenen Freigaben.'));
  }

  for (const ap of open) {
    const draftKey = `note:${ap.id}`;
    const msg = el('p', { class: 'msg' });
    const noteOpen = state.openNote === ap.id;

    const note = draftField(draftKey, { placeholder: 'Notiz oder Anweisung zur Entscheidung (optional)', rows: 2 });
    const noteWrap = el('div', { hidden: !noteOpen }, el('label', { class: 'lbl', text: 'Notiz / Anweisung' }), note);

    const decide = (decision, withInstruction) => async (ev) => {
      const btn = ev.currentTarget;
      await guard(btn, async () => {
        const text = takeDraft(draftKey);
        const res = await rpc('decide_approval', {
          p_id: ap.id,
          p_decision: decision,
          p_note: text || null,
        });
        if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
        if (withInstruction) {
          if (text.length < 3) {
            setMsg(msg, 'Entscheidung gespeichert, aber ohne Anweisung: Text zu kurz.', 'warn');
            dropDraft(draftKey);
            refresh();
            return;
          }
          const ins = await rpc('instruct', { p_target: ap.requested_by, p_body: text });
          if (!ins || !ins.ok) {
            setMsg(msg, `Entscheidung gespeichert, Anweisung fehlgeschlagen: ${reasonText(ins)}`, 'warn');
            refresh();
            return;
          }
        }
        dropDraft(draftKey);
        state.openNote = null;
        toast(decision === 'approved' ? 'Genehmigt.' : decision === 'denied' ? 'Abgelehnt.' : 'Zurückgezogen.', 'ok');
        refresh();
      });
    };

    const toggle = el('button', { class: 'btn', type: 'button', text: noteOpen ? 'Ohne Anweisung' : 'Mit Anweisung' });
    toggle.addEventListener('click', () => {
      state.openNote = noteOpen ? null : ap.id;
      renderActiveView(true);
      if (!noteOpen) setTimeout(() => note.focus(), 0);
    });

    const withdraw = el('button', { class: 'btn plain', type: 'button', text: 'Zurückziehen' });
    withdraw.addEventListener('click', decide('withdrawn', false));

    box.append(el('div', { class: 'ap' },
      el('div', { class: 't', text: ap.title || 'Ohne Titel' }),
      ap.question ? el('div', { class: 'q', text: ap.question }) : null,
      el('div', { class: 'kv' },
        el('span', {}, 'von ', el('b', { text: ap.requested_by || 'unbekannt' })),
        el('span', {}, 'Art ', el('b', { text: APPROVAL_KIND[ap.kind] || ap.kind || '—' })),
        el('span', {}, 'Kosten ', el('b', {
          text: ap.cost_tokens || ap.cost_eur
            ? `${fmtTok(ap.cost_tokens)} Token / ${fmtEur(ap.cost_eur)}`
            : 'keine Angabe',
        })),
        el('span', {}, 'Risiko ', el('b', { class: `risk ${ap.risk || ''}`, text: RISK[ap.risk] || ap.risk || '—' })),
        el('span', {}, 'Frist ', el('b', { text: ap.expires_at ? `${fmtUntil(ap.expires_at)} (${fmtWhen(ap.expires_at)})` : 'keine Frist' })),
        el('span', {}, 'Standard ', el('b', {
          text: ap.default_decision === 'approve' ? 'genehmigen' : ap.default_decision === 'deny' ? 'ablehnen' : '—',
        })),
        el('span', {}, 'gestellt ', el('b', { text: fmtAge(ap.created_at) }))),
      ap.recommendation ? el('div', { class: 'rec', text: `Empfehlung: ${ap.recommendation}` }) : null,
      noteWrap,
      el('div', { class: 'acts' },
        el('button', { class: 'btn ok', type: 'button', text: 'Genehmigen', onclick: decide('approved', noteOpen) }),
        el('button', { class: 'btn no', type: 'button', text: 'Ablehnen', onclick: decide('denied', noteOpen) }),
        toggle,
        withdraw),
      msg));
  }

  if (decided.length) {
    box.append(el('h2', { class: 'sec', text: 'Entscheidungen der letzten 7 Tage' }));
    const rows = decided.slice(0, 30).map((ap) => el('tr', {},
      el('td', { text: fmtWhen(ap.decided_at || ap.created_at) }),
      el('td', { text: ap.title || '—' }),
      el('td', { text: ap.requested_by || '—' }),
      el('td', { text: APPROVAL_STATUS[ap.status] || ap.status || '—' }),
      el('td', { text: ap.decision_note || '—' })));
    box.append(el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Entschieden' }), el('th', { text: 'Titel' }),
          el('th', { text: 'Von' }), el('th', { text: 'Ergebnis' }), el('th', { text: 'Notiz' }))),
        el('tbody', {}, ...rows)))));
  }

  box.append(el('p', { class: 'note', text: 'Regel: keine Freigabe heißt nicht Stillstand. Nach Ablauf der Frist greift die Standard-Entscheidung; der Daemon zieht sie nachvollziehbar nach.' }));
}

/* ================================================================ 04 Analytik */

function todayKey() {
  return berlinDay.format(new Date());
}

function yesterdayKey() {
  return berlinDay.format(new Date(Date.now() - 24 * 3600 * 1000));
}

function renderAnalytics(board) {
  const box = $('#analytics-body');
  if (!box) return;
  clear(box);

  const metrics = board ? board.metrics || [] : [];
  const agents = board ? board.agents || [] : [];
  const tasks = board ? board.tasks || [] : [];
  const approvals = board ? board.approvals || [] : [];

  if (!board) {
    box.append(emptyState('Noch keine Daten.'));
    return;
  }

  const today = todayKey();
  const yday = yesterdayKey();

  const mToday = metrics.filter((m) => m.hour && berlinDay.format(dateOf(m.hour) || new Date(0)) === today);
  const cardsToday = mToday.reduce((s, m) => s + num(m.tasks_done), 0);
  const costToday = mToday.reduce((s, m) => s + num(m.cost_eur), 0);

  // Nachtfenster 22:00 – 07:00 (gestern 22 Uhr bis heute 7 Uhr)
  const night = metrics.filter((m) => {
    const d = dateOf(m.hour);
    if (!d) return false;
    const day = berlinDay.format(d);
    const hour = Number(berlinHour.format(d));
    return (day === yday && hour >= 22) || (day === today && hour < 7);
  });
  const nightDone = night.reduce((s, m) => s + num(m.tasks_done), 0);

  const blockedTasks = tasks.filter((t) => t.status === 'blocked');
  const waitingOnJan = blockedTasks.filter((t) => approvals.some((a) => a.status === 'open' && a.requested_by === t.agent_key));

  const budgetSum = agents.reduce((s, a) => s + num(a.budget_eur_day), 0);
  const settings = (board && board.settings) || {};
  const budgetFromSettings = settings.budgets && (settings.budgets.total_eur_day ?? settings.budgets.day_eur);
  const budgetLabel = budgetFromSettings != null
    ? `von ${fmtEur(budgetFromSettings)} Tagesbudget`
    : budgetSum > 0 ? `von ${fmtEur(budgetSum)} Summe der Agentenbudgets` : 'kein Budget hinterlegt';

  box.append(el('div', { class: 'kpis' },
    kpi('Karten heute', fmtInt(cardsToday), metrics.length ? 'aus den Stundenwerten des Daemons' : 'Noch keine Daten'),
    kpi('Nachtfortschritt 22–07', fmtInt(nightDone), metrics.length ? 'Karten in der Nacht erledigt' : 'Noch keine Daten'),
    kpi('Kosten heute', fmtEur(costToday), budgetLabel),
    kpi('Blockiert', fmtInt(blockedTasks.length),
      waitingOnJan.length ? `davon ${waitingOnJan.length} wartet auf dich` : 'keine wartet auf dich')));

  /* --- Diagramm --- */
  const chartBox = el('div', { class: 'box' },
    el('h3', { text: 'Durchsatz und Token pro Tag' }),
    el('p', { class: 'sub', text: 'Karten (Balken) und Token (Linie), aus den Stundenwerten — bis zu 7 Tage, je nach Datenlage.' }));

  const byDay = new Map();
  for (const m of metrics) {
    const d = dateOf(m.hour);
    if (!d) continue;
    const key = berlinDay.format(d);
    if (!byDay.has(key)) byDay.set(key, { tasks: 0, tokens: 0, cost: 0 });
    const g = byDay.get(key);
    g.tasks += num(m.tasks_done);
    g.tokens += num(m.tokens);
    g.cost += num(m.cost_eur);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14);

  if (!days.length) {
    chartBox.append(emptyState('Noch keine Daten.'));
  } else {
    chartBox.append(buildChart(days));
    chartBox.append(el('div', { class: 'legend' },
      el('span', {}, el('i', { style: { background: '#3d6d94' } }), 'Karten pro Tag'),
      el('span', {}, el('i', { style: { background: '#4da3ff' } }), 'Token pro Tag')));
  }

  /* --- Marktreife-Kurzfassung --- */
  const rd = board.readiness || [];
  const score = board.readiness_score;
  const side = el('div', { class: 'box' },
    el('h3', { text: 'Marktreife' }),
    el('p', { class: 'sub', text: rd.length ? `${rd.length} Kriterien, gewichtet` : 'Noch keine Kriterien hinterlegt' }));
  if (!rd.length) {
    side.append(emptyState('Noch keine Daten.'));
  } else {
    side.append(el('div', { class: 'gauge' },
      donut(score),
      el('table', { class: 'rub' }, el('tbody', {}, ...rd.slice(0, 8).map((r) => el('tr', {},
        el('td', {}, `${r.label || r.key} `, el('span', { class: 's', text: `${num(r.score)}/5` })),
        el('td', { text: `${Math.round(num(r.weight) * 100)} %` })))))));
    side.append(el('p', { class: 'note' }, 'Details und Änderung unter „Marktreife“.'));
  }

  box.append(el('div', { class: 'two' }, chartBox, side));

  /* --- Tabelle je Agent --- */
  const rows = agents.map((a) => {
    const mine = mToday.filter((m) => m.agent_key === a.key);
    const done = mine.reduce((s, m) => s + num(m.tasks_done), 0);
    const blockedMin = mine.reduce((s, m) => s + num(m.blocked_minutes), 0);
    const st = AGENT_STATUS[a.status || ''] || { label: 'kein Signal', cls: 'idle' };
    return el('tr', {},
      el('td', {}, el('b', { text: a.name || a.key })),
      el('td', { text: a.role || '—' }),
      el('td', { class: 'num', text: metrics.length ? fmtInt(done) : '—' }),
      el('td', { class: 'num', text: fmtTok(a.tokens_today) }),
      el('td', { class: 'num', text: fmtEur(a.cost_eur_today) }),
      el('td', { class: 'num', text: fmtEur(a.budget_eur_day) }),
      el('td', { class: 'num', text: metrics.length ? `${fmtInt(blockedMin)} min` : '—' }),
      el('td', {}, el('span', { class: `st ${st.cls}`, text: st.label })));
  });

  box.append(el('h2', { class: 'sec', text: 'Je Agent' }));
  if (!agents.length) {
    box.append(emptyState('Noch keine Daten.'));
  } else {
    box.append(el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Agent' }), el('th', { text: 'Rolle' }),
          el('th', { class: 'num', text: 'Karten heute' }), el('th', { class: 'num', text: 'Token heute' }),
          el('th', { class: 'num', text: 'Kosten heute' }), el('th', { class: 'num', text: 'Budget/Tag' }),
          el('th', { class: 'num', text: 'blockiert' }), el('th', { text: 'Status' }))),
        el('tbody', {}, ...rows)))));
  }
}

function kpi(label, value, sub) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'lab', text: label }),
    el('div', { class: 'val', text: value }),
    el('div', { class: 'sub', text: sub }));
}

function donut(score) {
  const value = score === null || score === undefined ? null : Math.max(0, Math.min(100, num(score)));
  const node = el('div', { class: 'donut' },
    el('span', {}, value === null ? '—' : Math.round(value), el('i', { text: value === null ? '' : '%' })));
  node.style.setProperty('--pct', String(value === null ? 0 : value));
  return node;
}

function buildChart(days) {
  const W = 420;
  const H = 140;
  const bottom = 108;
  const top = 12;
  const padL = 4;
  const padR = 4;
  const innerW = W - padL - padR;
  const maxTasks = Math.max(1, ...days.map(([, g]) => g.tasks));
  const maxTokens = Math.max(1, ...days.map(([, g]) => g.tokens));
  const slot = innerW / days.length;
  const barW = Math.max(6, Math.min(16, slot * 0.5));

  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
    'aria-label': 'Durchsatz und Token pro Tag',
  });

  // Hilfslinien
  for (const y of [bottom, bottom - 32, bottom - 64, bottom - 96]) {
    root.append(svg('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: y === bottom ? 'axis' : 'gridline' }));
  }

  const points = [];
  days.forEach(([key, g], i) => {
    const x = padL + slot * i + (slot - barW) / 2;
    const h = Math.max(2, (g.tasks / maxTasks) * 86);
    root.append(svg('rect', {
      x, y: bottom - h, width: barW, height: h, rx: 2,
      fill: i === days.length - 1 ? '#3d6d94' : '#2c3a4a',
    }));
    const cx = padL + slot * i + slot / 2;
    const ty = bottom - Math.max(3, (g.tokens / maxTokens) * 86);
    points.push([cx, ty]);
    const label = svg('text', { x: cx, y: H - 12, 'text-anchor': 'middle' });
    label.textContent = fmtDay.format(new Date(`${key}T12:00:00`));
    root.append(label);
  });

  if (points.length > 1) {
    root.append(svg('polyline', {
      points: points.map((p) => p.join(',')).join(' '),
      fill: 'none', stroke: '#4da3ff', 'stroke-width': 2, 'stroke-linejoin': 'round',
    }));
  }
  const last = points[points.length - 1];
  if (last) root.append(svg('circle', { cx: last[0], cy: last[1], r: 3.5, fill: '#4da3ff' }));

  return root;
}

/* ================================================================ 05 Marktreife */

function renderReadiness(board) {
  const box = $('#readiness-body');
  if (!box) return;
  clear(box);

  const rd = board ? board.readiness || [] : [];
  if (!rd.length) {
    box.append(emptyState('Noch keine Daten — keine Kriterien hinterlegt.'));
    return;
  }

  const score = board.readiness_score;
  const weightSum = rd.reduce((s, r) => s + num(r.weight), 0);

  box.append(el('div', { class: 'box' },
    el('h3', { text: 'Marktreife — ehrlich gerechnet' }),
    el('p', { class: 'sub', text: `${rd.length} Kriterien · Summe der Gewichte ${Math.round(weightSum * 100)} % · Score 0–5` }),
    el('div', { class: 'gauge' },
      donut(score),
      el('table', { class: 'rub' }, el('tbody', {}, ...rd.map((r) => el('tr', {},
        el('td', {}, `${r.label || r.key} `, el('span', { class: 's', text: `${num(r.score)}/5` })),
        el('td', { text: `${Math.round(num(r.weight) * 100)} %` }))))))));

  box.append(el('h2', { class: 'sec', text: 'Kriterien' }));

  const list = el('div', { class: 'card' });
  for (const r of rd) {
    const key = r.key;
    const open = state.openCrit === key;
    const draftKey = `rd:${key}`;
    const noteKey = `rdnote:${key}`;
    const urlKey = `rdurl:${key}`;

    const ev = el('div', { class: 'ev' },
      r.evidence_note ? r.evidence_note : 'Keine Evidenz hinterlegt.',
      r.evidence_url ? frag(' ', el('a', { href: r.evidence_url, target: '_blank', rel: 'noopener noreferrer', text: 'Quelle' })) : null);

    const item = el('div', { class: 'crit' },
      el('div', { class: 'head' },
        el('span', { class: 'name', text: r.label || r.key }),
        el('span', { class: 'w', text: `Gewicht ${Math.round(num(r.weight) * 100)} %` }),
        el('span', { class: 'sc' }, `${num(r.score)}/5`, scoreDots(num(r.score))),
        el('span', { class: 'w', text: r.updated_at ? `Stand ${fmtWhen(r.updated_at)}` : 'nie bewertet' })),
      ev);

    if (open) {
      const msg = el('p', { class: 'msg' });
      const select = el('select', { class: 'inp' });
      for (let i = 0; i <= 5; i += 1) {
        const opt = el('option', { value: String(i), text: `${i} — ${['kein Stand', 'Idee', 'Prototyp', 'funktioniert intern', 'funktioniert im Feld', 'belegt mit Evidenz'][i]}` });
        if (num(r.score) === i) opt.selected = true;
        select.append(opt);
      }
      const note = draftField(noteKey, { placeholder: 'Evidenz: was genau wurde gemessen, geprüft oder belegt? (Pflicht)', rows: 2 }, r.evidence_note || '');
      const url = el('input', { class: 'inp', type: 'url', placeholder: 'https://… (optional)', value: r.evidence_url || '' });
      url.addEventListener('input', () => state.drafts.set(urlKey, url.value));

      const save = el('button', { class: 'btn acc', type: 'button', text: 'Score speichern' });
      save.addEventListener('click', () => guard(save, async () => {
        const text = takeDraft(noteKey, r.evidence_note || '');
        if (text.length < 5) {
          setMsg(msg, 'Evidenztext ist Pflicht (mindestens 5 Zeichen). Ohne Beleg keine Änderung.', 'warn');
          return;
        }
        const res = await rpc('update_readiness', {
          p_key: key,
          p_score: Number(select.value),
          p_note: text,
          p_url: (state.drafts.get(urlKey) || url.value || '').trim() || null,
        });
        if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
        dropDraft(noteKey); dropDraft(urlKey);
        state.openCrit = null;
        toast('Score gespeichert.', 'ok');
        refresh();
      }));

      const cancel = el('button', { class: 'btn plain', type: 'button', text: 'Abbrechen' });
      cancel.addEventListener('click', () => { state.openCrit = null; renderActiveView(true); });

      item.append(el('div', { style: { marginTop: '8px' } },
        el('label', { class: 'lbl', text: 'Score' }), select,
        el('label', { class: 'lbl', text: 'Evidenz (Pflicht)' }), note,
        el('label', { class: 'lbl', text: 'Beleg-URL (optional)' }), url,
        el('div', { class: 'row' }, save, cancel),
        msg));
    } else {
      const edit = el('button', { class: 'btn', type: 'button', text: 'Score ändern' });
      edit.addEventListener('click', () => {
        state.openCrit = key;
        renderActiveView(true);
      });
      item.append(el('div', { class: 'row' }, edit));
    }

    list.append(item);
  }
  box.append(list);
  box.append(el('p', { class: 'note' }, 'Regel: kein Score ohne Evidenz. „Läuft bei mir“ ohne Messung zählt nicht.'));
}

function scoreDots(score) {
  const s = Math.max(0, Math.min(5, Math.round(num(score))));
  const wrap = el('span', { class: 'dots' });
  for (let i = 1; i <= 5; i += 1) wrap.append(el('i', { class: i <= s ? 'on' : null }));
  return wrap;
}

/* ================================================================ 06 Watchdog & Einstellungen */

function renderOps(board) {
  renderWatchdog(board);
  renderIncidents(board);
  renderDevices(board);
  renderSecurityQuestion();
  renderSettings(board);
  renderSession();
}

function renderWatchdog(board) {
  const box = $('#ops-watchdog');
  if (!box) return;
  clear(box);
  const list = board ? board.watchdog || [] : [];
  if (!list.length) { box.append(emptyState('Noch keine Daten — der Watchdog hat noch nicht gemeldet.')); return; }
  const card = el('div', { class: 'card' });
  for (const w of list) {
    const dot = w.status === 'ok' ? '' : w.status === 'warn' ? 'w' : w.status === 'fail' ? 'b' : 'n';
    card.append(el('div', { class: 'wd' },
      el('span', { class: 'dot', style: { background: dot === 'w' ? 'var(--warn)' : dot === 'b' ? 'var(--bad)' : dot === 'n' ? '#3a424f' : 'var(--ok)' } }),
      el('span', { class: 'k', text: w.check_key || '—' }),
      el('span', { class: 'd', text: w.detail || (w.status === 'ok' ? 'keine Auffälligkeit' : 'ohne Detail') }),
      el('span', { class: 'l', text: w.latency_ms != null ? `${fmtInt(w.latency_ms)} ms` : '' }),
      el('span', { class: 'l', text: w.ts ? fmtWhen(w.ts) : '' })));
  }
  box.append(card);
}

function renderIncidents(board) {
  const box = $('#ops-incidents');
  if (!box) return;
  clear(box);
  const list = board ? board.incidents || [] : [];
  if (!list.length) { box.append(emptyState('Noch keine Daten — keine Vorfälle gemeldet.')); return; }
  const feed = el('div', { class: 'feed' });
  for (const inc of list.slice(0, 25)) {
    const sev = inc.severity || 'info';
    feed.append(el('div', { class: 'inc' },
      el('div', { class: 'tm', text: fmtTime.format(dateOf(inc.ts) || new Date()) }),
      el('div', {},
        el('span', { class: `sev ${sev}`, text: sev }),
        ' ',
        el('span', { class: 'role', text: inc.source || '' }),
        el('div', { text: inc.summary || '—' }),
        inc.action_taken ? el('div', { class: 'fix', text: inc.action_taken }) : null,
        inc.needs_jan ? el('div', { class: 'man', text: 'Braucht eine Entscheidung von dir.' }) : null,
        inc.resolved_at ? el('div', { class: 'role', text: `erledigt ${fmtWhen(inc.resolved_at)}` }) : null)));
  }
  box.append(feed);
}

function renderDevices(board) {
  const box = $('#ops-devices');
  if (!box) return;
  clear(box);
  const list = board ? board.devices || [] : [];
  if (!list.length) { box.append(emptyState('Noch keine Daten — keine Geräte gemeldet.')); return; }

  const rows = list.map((d) => {
    const isRevoked = d.status === 'revoked';
    const btn = el('button', { class: 'btn', type: 'button', text: isRevoked ? 'widerrufen' : 'Widerrufen' });
    btn.disabled = isRevoked;
    if (!isRevoked) {
      btn.addEventListener('click', () => {
        if (state.revokedConfirm !== d.id) {
          state.revokedConfirm = d.id;
          btn.textContent = 'Wirklich widerrufen?';
          btn.classList.add('no');
          setTimeout(() => {
            if (state.revokedConfirm === d.id) {
              state.revokedConfirm = null;
              if (btn.isConnected) { btn.textContent = 'Widerrufen'; btn.classList.remove('no'); }
            }
          }, 4000);
          return;
        }
        state.revokedConfirm = null;
        guard(btn, async () => {
          const res = await rpc('revoke_device', { p_device: d.id });
          if (!res || !res.ok) { toast(reasonText(res), 'bad'); return; }
          toast('Gerät widerrufen.', 'ok');
          refresh();
        });
      });
    }
    const label = d.status === 'trusted' ? 'freigeschaltet' : d.status === 'pending' ? 'wartet auf Antwort' : 'widerrufen';
    return el('tr', {},
      el('td', {}, el('b', { text: d.label || 'Gerät' })),
      el('td', { text: label }),
      el('td', { text: d.created_at ? fmtWhen(d.created_at) : '—' }),
      el('td', { text: d.trusted_at ? fmtWhen(d.trusted_at) : '—' }),
      el('td', { text: d.last_seen_at ? fmtAge(d.last_seen_at) : 'nie' }),
      el('td', {}, btn));
  });

  box.append(el('div', { class: 'card' },
    el('p', { class: 'sub', text: 'Nur freigeschaltete Geräte sehen Inhalte. Widerruf wirkt sofort — dieses Gerät verliert dann den Zugang.' }),
    el('div', { class: 'tbl-wrap' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Bezeichnung' }), el('th', { text: 'Status' }), el('th', { text: 'Angelegt' }),
          el('th', { text: 'Freigeschaltet' }), el('th', { text: 'Zuletzt gesehen' }), el('th', { text: '' }))),
        el('tbody', {}, ...rows)))));
}

function renderSecurityQuestion() {
  const box = $('#ops-question');
  if (!box) return;
  clear(box);

  const q = el('input', { class: 'inp', type: 'text', autocomplete: 'off', placeholder: 'Neue Frage' });
  const a = el('input', { class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Neue Antwort' });
  const msg = el('p', { class: 'msg' });
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Sicherheitsfrage ändern' });

  btn.addEventListener('click', () => guard(btn, async () => {
    if (q.value.trim().length < 6 || a.value.trim().length < 3) {
      setMsg(msg, 'Frage mindestens 6 Zeichen, Antwort mindestens 3 Zeichen.', 'warn');
      return;
    }
    const res = await rpc('set_security_question', { p_question: q.value.trim(), p_answer: a.value.trim() });
    if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
    q.value = ''; a.value = '';
    setMsg(msg, 'Sicherheitsfrage geändert. Bestehende Freigaben bleiben gültig.', 'ok');
  }));

  box.append(el('div', { class: 'card' },
    el('p', { class: 'sub', text: 'Gilt für neue Geräte. Die Antwort wird nur als Hash gespeichert.' }),
    el('label', { class: 'lbl', text: 'Frage' }), q,
    el('label', { class: 'lbl', text: 'Antwort' }), a,
    el('div', { class: 'row' }, btn),
    msg));
}

function renderSettings(board) {
  const box = $('#ops-settings');
  if (!box) return;
  clear(box);
  const settings = (board && board.settings) || {};
  const keys = Object.keys(settings);
  if (!keys.length) {
    box.append(emptyState('Noch keine Daten — keine Einstellungen hinterlegt.'));
    return;
  }

  for (const key of keys) {
    const draftKey = `set:${key}`;
    const pretty = JSON.stringify(settings[key], null, 2);
    const area = draftField(draftKey, { rows: Math.min(12, Math.max(4, pretty.split('\n').length)), spellcheck: 'false' }, pretty);
    area.className = 'inp mono';
    const msg = el('p', { class: 'msg' });
    const btn = el('button', { class: 'btn acc', type: 'button', text: `${key} speichern` });

    btn.addEventListener('click', () => guard(btn, async () => {
      let parsed;
      try {
        parsed = JSON.parse(area.value);
      } catch (e) {
        setMsg(msg, `Kein gültiges JSON: ${e.message}`, 'bad');
        return;
      }
      const res = await rpc('set_setting', { p_key: key, p_value: parsed });
      if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
      dropDraft(draftKey);
      setMsg(msg, 'Gespeichert.', 'ok');
      refresh();
    }));

    box.append(el('div', { class: 'card', style: { marginBottom: '10px' } },
      el('div', { class: 'role', text: key }),
      area,
      el('div', { class: 'row' }, btn),
      msg));
  }

  box.append(el('p', { class: 'note', text: 'Werte sind JSON. Unbekannte Felder werden unverändert gespeichert; der Daemon liest beim nächsten Lauf den neuen Stand.' }));
}

function renderSession() {
  const box = $('#ops-session');
  if (!box) return;
  clear(box);
  const email = state.session && state.session.user ? state.session.user.email : '—';
  const out = el('button', { class: 'btn', type: 'button', text: 'Abmelden' });
  out.addEventListener('click', () => guard(out, async () => {
    await sb.auth.signOut();
    state.status = null;
    state.board = null;
    showOnly('view-login');
    toast('Abgemeldet. Das Gerät bleibt freigeschaltet.', 'ok');
  }));

  box.append(el('div', { class: 'card' },
    el('div', { class: 'meta', style: { marginBottom: '10px' } },
      el('span', {}, 'Angemeldet als ', el('b', { text: email })),
      el('span', {}, 'Rolle ', el('b', { text: (state.status && state.status.role) || '—' }))),
    el('div', { class: 'row' }, out),
    el('p', { class: 'note', text: 'Abmelden entfernt nur die Sitzung. Das Gerätetoken bleibt im Browser — dieses Gerät gilt weiter als freigeschaltet.' })));
}

/* ================================================================ Start */

boot().catch((e) => {
  console.error(e);
  toast(`Start fehlgeschlagen: ${e.message}`, 'bad');
  showOnly('view-login');
});
