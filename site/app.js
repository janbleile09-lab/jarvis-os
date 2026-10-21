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

const nfInt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nfEur = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtTimeSec = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ });
const fmtDay = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', timeZone: TZ });
const fmtStamp = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ });
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
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 1 })}M`;
  if (v >= 1e3) return `${(v / 1e3).toLocaleString('en-GB', { maximumFractionDigits: 0 })}k`;
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
  return `${Math.round(h / 24)} days`;
}

function fmtWhen(iso) {
  const d = dateOf(iso);
  return d ? fmtStamp.format(d) : '—';
}

/** Restzeit bis Frist: „in 5 h 48 min", „abgelaufen". */
function fmtUntil(iso) {
  const d = dateOf(iso);
  if (!d) return 'no deadline';
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
  return `${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })} %`;
}

/* ---------------------------------------------------------------- Vokabular */

const AGENT_STATUS = {
  running: { label: 'working', cls: 'ok', dot: '' },
  waiting: { label: 'wartet', cls: 'warn', dot: 'w' },
  error: { label: 'Fehler', cls: 'bad', dot: 'b' },
  idle: { label: 'bereit', cls: 'idle', dot: 'n' },
};

const TASK_STATUS = {
  todo: 'open', scheduled: 'scheduled', running: 'running',
  blocked: 'blocked', review: 'review', done: 'done',
};

const APPROVAL_KIND = {
  subagents: 'Subagents', deploy: 'Deploy', purchase: 'Kauf',
  delete: 'Delete', external: 'externally visible', other: 'other',
};

const APPROVAL_STATUS = {
  open: 'open', approved: 'approved', denied: 'denied',
  expired: 'expired', withdrawn: 'withdrawn',
};

const RISK = { low: 'niedrig', medium: 'mittel', high: 'hoch' };

const REASONS = {
  device_not_trusted: 'This device is not approved.',
  not_trusted: 'This device is not approved.',
  no_session: 'Session expired. Please sign in again.',
  not_owner: 'Only the owner may perform this step.',
  already_claimed: 'Ownership is already assigned.',
  code_invalid: 'Invalid access code.',
  too_short: 'Eingabe zu kurz.',
  weak_token: 'Device token too weak — reload the page.',
  device_unknown: 'Unknown device. Please sign in again.',
  no_question: 'No security question set yet.',
  wrong: 'Wrong answer.',
  locked: 'Locked. Please try again later.',
  bad_decision: 'Invalid decision.',
  bad_score: 'Score must be between 0 and 5.',
  unknown_key: 'Unknown key.',
  unknown_agent: 'Unknown agent.',
  not_found: 'Entry not found.',
  already_decided: 'Bereits entschieden.',
  not_agent: 'Only the daemon may do that.',
};

function reasonText(res) {
  if (!res) return 'No response from the server.';
  const base = REASONS[res.reason] || `Abgelehnt (${res.reason || 'unknown'}).`;
  if (res.reason === 'locked' && res.until) return `Gesperrt bis ${fmtTime.format(dateOf(res.until) || new Date())}.`;
  if (res.reason === 'wrong' && typeof res.attempts_left === 'number') {
    const n = res.attempts_left;
    return `Wrong answer. ${n} ${n === 1 ? 'attempt' : 'attempts'} left.`;
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
  connection: { ok: false, note: 'not connected' },
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
  if (button) { button.disabled = true; button.textContent = 'working …'; }
  try {
    await fn();
  } catch (e) {
    toast(e.message || 'Action failed', 'bad');
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
  wireVoice();
  wirePodcast();
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
    toast(`Status check failed: ${e.message}`, 'bad');
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
      setMsg(msg, 'Please enter a valid email address.', 'warn');
      return;
    }
    setMsg(msg, '');
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: SITE_URL },
    });
    if (error) { setMsg(msg, error.message, 'bad'); return; }
    setMsg(msg, 'Email is on its way. Open the link in the email, then continue here.', 'ok');
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
        setMsg(msg, 'Please enter email and password.', 'warn');
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
  setMsg(msg, `Sign-in failed: ${desc.replace(/\+/g, ' ')}`, 'bad');
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
      if (!value) { setMsg(msg, 'Please enter the access code.', 'warn'); return; }
      const res = await rpc('claim_owner', { p_code: value });
      if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
      setMsg(msg, 'Access claimed. The security question is being set up now.', 'ok');
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

  const q = el('input', { class: 'inp', type: 'text', autocomplete: 'off', placeholder: 'e.g. name of the first workshop' });
  const a = el('input', { class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Save question' });

  btn.addEventListener('click', () => guard(btn, async () => {
    if (q.value.trim().length < 6 || a.value.trim().length < 3) {
      setMsg(msg, 'Question at least 6 characters, answer at least 3.', 'warn');
      return;
    }
    const res = await rpc('set_security_question', { p_question: q.value.trim(), p_answer: a.value.trim() });
    if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
    if (state.status) state.status.has_question = true;
    setMsg(msg, 'Question saved. The answer cannot be recovered.', 'ok');
    await renderRegisterForm();
  }));

  append(body, [
    el('h2', { text: 'Sicherheitsfrage festlegen' }),
    el('p', { class: 'help', text: 'This question protects new devices. The answer is stored only as a hash — remember it.' }),
    el('label', { class: 'lbl', text: 'Question' }), q,
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
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Register this device' });

  btn.addEventListener('click', () => guard(btn, async () => {
    const res = await rpc('register_device', {
      p_label: label.value.trim() || 'Device',
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
    el('h2', { text: 'Approve new device' }),
    el('p', { class: 'help', text: 'This device is signed in but not approved yet. Answer the security question to confirm.' }),
    el('label', { class: 'lbl', text: 'Name of this device' }), label,
    el('div', { class: 'row' }, btn),
  ]);
}

function renderAnswerForm(question, deviceId) {
  const body = $('#device-body');
  const msg = $('#device-msg');
  clear(body);
  setMsg(msg, '');

  const answer = el('input', { class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Check answer' });

  const submit = () => guard(btn, async () => {
    if (!answer.value.trim()) { setMsg(msg, 'Please enter the answer.', 'warn'); return; }
    const res = await rpc('answer_device', { p_device: deviceId, p_answer: answer.value.trim() });
    if (res && res.ok) {
      state.pendingDevice = null;
      writePending(null);
      if (state.status) state.status.trusted = true;
      setMsg(msg, 'Device approved.', 'ok');
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
    el('p', { class: 'help', text: 'Answer the stored question to approve this device. Three failed attempts lock it for 15 minutes.' }),
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
      state.connection = { ok: false, note: data && data.reason ? reasonText(data) : 'Board unavailable' };
      renderChrome();
      return;
    }
    state.board = data;
    state.connection = { ok: true, note: 'connected' };
    await refreshPodcast();
    renderChrome();
    renderActiveView(force);
  } catch (e) {
    state.connection = { ok: false, note: e.message || 'Connection interrupted' };
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
      title: failing ? `${failing} watchdog check(s) failing` : 'Watchdog state from the last run',
    }, el('span', { class: `dot ${watchdog.dot}` }), watchdog.text);

    append(pills, [
      el('span', { class: 'pill' },
        el('span', { class: `dot ${state.connection.ok ? '' : 'b'}` }),
        state.connection.ok ? 'connected' : 'disconnected'),
      watchdogPill,
      el('span', { class: 'pill' },
        el('span', { class: `dot ${openApprovals ? 'w' : 'n'}` }),
        b ? (openApprovals ? `${openApprovals} approval${openApprovals === 1 ? '' : 's'} open` : 'no open approvals') : 'No data yet'),
      el('span', { class: 'pill', text: `as of ${fmtTimeSec.format(new Date())}` }),
    ]);
  }

  renderPodcast();

  const tabCount = $('#tab-approvals');
  if (tabCount) {
    const openApprovals = b ? (b.approvals || []).filter((a) => a.status === 'open').length : 0;
    tabCount.textContent = String(openApprovals);
    tabCount.style.display = openApprovals ? '' : 'none';
  }
}

function worstWatchdog(list) {
  if (!list || !list.length) return { dot: 'n', text: 'Watchdog: no data' };
  if (list.some((w) => w.status === 'fail')) return { dot: 'b', text: 'Watchdog: alert' };
  if (list.some((w) => w.status === 'warn')) return { dot: 'w', text: 'Watchdog: warning' };
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


/* ================================================================ Podcast */

async function refreshPodcast(force = false) {
  const now = Date.now();
  const active = state.podcast && state.podcast.job
    && ['queued', 'running'].includes(state.podcast.job.status);
  if (!force && state.podcastAt && !active && now - state.podcastAt < 30000) return;
  try {
    const res = await rpc('podcast_state');
    if (res && res.ok) {
      state.podcast = res;
      state.podcastAt = now;
    }
  } catch (e) {
    /* still: der Balken ist Beiwerk, das Board darf deswegen nicht stoeren */
  }
  renderPodcast();
}

function renderPodcast() {
  const btn = $('#podcast-btn');
  const wrap = $('#podcast-mini');
  const fill = $('#podcast-fill');
  const text = $('#podcast-text');
  if (!btn || !wrap || !fill || !text) return;

  const st = state.podcast;
  const job = st && st.job ? st.job : null;

  if (!job) {
    wrap.hidden = true;
    btn.disabled = false;
    btn.textContent = 'Podcast';
    btn.title = 'Create a podcast about the current state (English)';
    return;
  }

  wrap.hidden = false;
  wrap.className = 'pod' + (job.status === 'done' ? ' done' : job.status === 'failed' ? ' failed' : '');
  fill.style.width = Math.max(2, Math.min(100, Number(job.progress) || 0)) + '%';

  if (job.status === 'failed') {
    text.textContent = 'failed';
    btn.disabled = false;
    btn.textContent = 'Retry';
    btn.title = job.error || 'Podcast failed';
    return;
  }

  if (job.status === 'done') {
    const when = job.published_at ? fmtWhen(job.published_at) : fmtWhen(job.created_at);
    text.textContent = 'published ' + when;
    btn.disabled = true;
    btn.textContent = 'Podcast';
    btn.title = job.audio_url || 'Published';
    if (st && st.next_allowed_at && !st.can_request) {
      btn.disabled = true;
      btn.textContent = 'Podcast · ' + minutesUntil(st.next_allowed_at) + ' min';
    }
    return;
  }

  const stage = { queued: 'queued', starting: 'starting', collecting: 'reading board',
                  writing: 'writing script', voicing: 'voice', published: 'published',
                  mirroring: 'publishing' }[job.stage] || job.stage || 'working';
  text.textContent = stage + ' · ' + (Number(job.progress) || 0) + ' %';
  btn.disabled = true;
  btn.textContent = 'Podcast';
}

function minutesUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 60000));
}

function wirePodcast() {
  const btn = $('#podcast-btn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const res = await rpc('request_podcast');
    if (!res || res.ok !== true) {
      const reason = res && res.reason;
      if (reason === 'rate_limited' && res.next_allowed_at) {
        toast('Next podcast in ' + minutesUntil(res.next_allowed_at) + ' min.', 'warn');
      } else if (reason === 'already_running') {
        toast('A podcast is already being produced.', 'warn');
      } else {
        toast(reasonText(res || {}), 'bad');
      }
      btn.disabled = false;
      return;
    }
    toast('Podcast requested — the daemon starts in the next run.', 'ok');
    await refreshPodcast(true);
  });
}

/* ================================================================ 01 Übersicht */

function renderOverview(board) {
  const orgBox = $('#overview-org');
  const cardsBox = $('#overview-cards');
  if (!orgBox || !cardsBox) return;

  const agents = board ? board.agents || [] : [];
  const tasks = board ? board.tasks || [] : [];

  renderBlackboard(board);
  if (!state.visitLoaded) { state.visitLoaded = true; loadVisit(); } else { renderDigest(); }
  applyBriefingLink(board);

  /* --- Organigramm --- */
  clear(orgBox);
  if (!agents.length) {
    orgBox.append(emptyState('No data yet — the daemon has not reported any agents.'));
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
          el('div', { class: 'role', text: 'Owner · final authority on approvals, budget, strategy' })),
        el('div', { class: 'meta' }, el('span', { class: 'pill' }, el('span', { class: 'dot' }), 'online'))),
      el('div', { class: 'link' }),
      el('div', { class: 'node coo' },
        agentAvatar(coo),
        el('div', {},
          el('div', { class: 'who', text: coo.name || coo.key }),
          el('div', { class: 'role', text: [coo.role, coo.mandate].filter(Boolean).join(' · ') || 'ohne Auftrag' })),
        el('div', { class: 'meta' },
          el('span', { class: 'pill', text: `${leaders.length} area${leaders.length === 1 ? '' : 's'}` }),
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
          el('div', { class: 'trait', text: lead.personality ? `„${lead.personality}“` : 'No personality on file.' }),
          el('span', { class: 'badge', text: lead.limits || lead.model || 'no limits on file' })));
      }
      org.append(team);
    }
    orgBox.append(org);
  }

  /* --- Live-Karten --- */
  clear(cardsBox);
  if (!agents.length) {
    cardsBox.append(emptyState('No data yet.'));
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
          : (agent.mandate || 'mandate not described yet'),
      }),
      el('div', { class: 'bar' }, el('i', {
        style: { width: `${Math.max(2, Math.min(100, num(active ? active.progress : 0)))}%` },
        class: active && active.status === 'blocked' ? 'w' : null,
      })),
      el('div', { class: 'meta' },
        el('span', {}, 'Heartbeat ', el('b', { text: fmtAge(agent.last_seen) })),
        el('span', {}, 'Today ', el('b', { text: `${fmtTok(agent.tokens_today)} tokens` })),
        el('span', {}, el('b', { text: fmtEur(agent.cost_eur_today) }))),
      el('div', { class: 'acts' },
        el('button', {
          class: 'btn acc', type: 'button', text: 'Instruction',
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
    box.append(emptyState('No data yet — no agents reported.'));
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
      placeholder: `Instruction for ${agent.name || agent.key} — what should happen next?`,
      rows: 2,
    });
    field.id = `instr-${agent.key}`;

    const msg = el('p', { class: 'msg' });
    const send = el('button', { class: 'btn acc', type: 'button', text: 'Send instruction' });
    send.addEventListener('click', () => guard(send, async () => {
      const body = takeDraft(draftKey);
      if (body.length < 3) { setMsg(msg, 'Instruction too short (at least 3 characters).', 'warn'); return; }
      const res = await rpc('instruct', { p_target: agent.key, p_body: body });
      if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
      dropDraft(draftKey);
      field.value = '';
      setMsg(msg, 'Instruction queued. The daemon hands it to Hermes.', 'ok');
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
          p_status: 'blocked', p_progress: null, p_step: 'Paused by Jan',
        });
        if (!res || !res.ok) { toast(reasonText(res), 'bad'); return; }
        toast(`„${card.title}“ pausiert.`, 'ok');
        refresh();
      });
    });

    const restartBtn = el('button', { class: 'btn', type: 'button', text: 'Restart' });
    restartBtn.disabled = !current.length;
    restartBtn.addEventListener('click', () => {
      const card = current[0];
      if (!card) return;
      guard(restartBtn, async () => {
        const res = await rpc('upsert_task', {
          p_id: card.id, p_agent: agent.key, p_title: null, p_detail: null,
          p_status: 'todo', p_progress: 0, p_step: 'Restarted by Jan',
        });
        if (!res || !res.ok) { toast(reasonText(res), 'bad'); return; }
        toast(`"${card.title}" restarted.`, 'ok');
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
        el('span', {}, 'Tokens today ', el('b', { text: fmtTok(agent.tokens_today) })),
        el('span', {}, el('b', { text: fmtEur(agent.cost_eur_today) })),
        el('span', {}, 'Budget ', el('b', { text: fmtEur(agent.budget_eur_day) }), ' / day')),

      current.length
        ? el('div', {}, ...current.slice(0, 6).map((t) => el('div', { style: { padding: '7px 0', borderTop: '1px solid #1e242c' } },
          el('div', { class: 'task', text: t.title || 'ohne Titel' }),
          el('div', { class: 'step', text: [TASK_STATUS[t.status] || t.status, t.current_step, `as of ${fmtAge(t.updated_at)}`].filter(Boolean).join(' · ') }),
          el('div', { class: 'bar' }, el('i', {
            style: { width: `${Math.max(2, Math.min(100, num(t.progress)))}%` },
            class: t.status === 'blocked' ? 'w' : null,
          })))))
        : el('div', { class: 'step', text: 'No open card for this agent.' }),

      el('div', { style: { borderTop: '1px solid #1e242c', marginTop: '6px', paddingTop: '10px' } },
        el('label', { class: 'lbl', for: `instr-${agent.key}`, text: `Instruction for ${agent.name || agent.key}` }),
        field,
        el('div', { class: 'row' }, send, pauseBtn, restartBtn),
        msg),

      el('div', { style: { borderTop: '1px solid #1e242c', marginTop: '10px', paddingTop: '9px' } },
        el('div', { class: 'role', style: { marginBottom: '6px' }, text: 'History' }),
        history.length
          ? el('div', {}, ...history.map((e) => el('div', { class: 'inc', style: { fontSize: '11.5px', padding: '6px 0' } },
            el('div', { class: 'tm', text: fmtTime.format(dateOf(e.ts) || new Date()) }),
            el('div', {}, e.message || e.kind || '—'))))
          : el('div', { class: 'step', text: 'No events yet.' })));

    wrap.append(card);
  }
  box.append(wrap);
  renderMessages(board);
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
    box.append(emptyState('No data yet — no approvals.'));
    return;
  }

  if (!open.length) {
    box.append(emptyState('Keine offenen Freigaben.'));
  }

  for (const ap of open) {
    const draftKey = `note:${ap.id}`;
    const msg = el('p', { class: 'msg' });
    const noteOpen = state.openNote === ap.id;

    const note = draftField(draftKey, { placeholder: 'Note or instruction for this decision (optional)', rows: 2 });
    const noteWrap = el('div', { hidden: !noteOpen }, el('label', { class: 'lbl', text: 'Note / instruction' }), note);

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
            setMsg(msg, 'Decision saved but without an instruction: text too short.', 'warn');
            dropDraft(draftKey);
            refresh();
            return;
          }
          const ins = await rpc('instruct', { p_target: ap.requested_by, p_body: text });
          if (!ins || !ins.ok) {
            setMsg(msg, `Decision saved, instruction failed: ${reasonText(ins)}`, 'warn');
            refresh();
            return;
          }
        }
        dropDraft(draftKey);
        state.openNote = null;
        toast(decision === 'approved' ? 'Approved.' : decision === 'denied' ? 'Denied.' : 'Withdrawn.', 'ok');
        refresh();
      });
    };

    const toggle = el('button', { class: 'btn', type: 'button', text: noteOpen ? 'Without instruction' : 'With instruction' });
    toggle.addEventListener('click', () => {
      state.openNote = noteOpen ? null : ap.id;
      renderActiveView(true);
      if (!noteOpen) setTimeout(() => note.focus(), 0);
    });

    const withdraw = el('button', { class: 'btn plain', type: 'button', text: 'Withdraw' });
    withdraw.addEventListener('click', decide('withdrawn', false));

    box.append(el('div', { class: 'ap' },
      el('div', { class: 't', text: ap.title || 'Ohne Titel' }),
      ap.question ? el('div', { class: 'q', text: ap.question }) : null,
      el('div', { class: 'kv' },
        el('span', {}, 'by ', el('b', { text: ap.requested_by || 'unknown' })),
        el('span', {}, 'Art ', el('b', { text: APPROVAL_KIND[ap.kind] || ap.kind || '—' })),
        el('span', {}, 'Cost ', el('b', {
          text: ap.cost_tokens || ap.cost_eur
            ? `${fmtTok(ap.cost_tokens)} Token / ${fmtEur(ap.cost_eur)}`
            : 'not specified',
        })),
        el('span', {}, 'Risk ', el('b', { class: `risk ${ap.risk || ''}`, text: RISK[ap.risk] || ap.risk || '—' })),
        el('span', {}, 'Deadline ', el('b', { text: ap.expires_at ? `${fmtUntil(ap.expires_at)} (${fmtWhen(ap.expires_at)})` : 'no deadline' })),
        el('span', {}, 'Standard ', el('b', {
          text: ap.default_decision === 'approve' ? 'genehmigen' : ap.default_decision === 'deny' ? 'ablehnen' : '—',
        })),
        el('span', {}, 'gestellt ', el('b', { text: fmtAge(ap.created_at) })),
        ap.estimate_minutes ? el('span', {}, 'Dauer ', el('b', { text: `${ap.estimate_minutes} min` })) : null),
      ap.kind === 'followup' && ap.after_task_title
        ? el('div', { class: 'rec', text: `Nach erledigter Arbeit: ${ap.after_task_title}` }) : null,
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
    box.append(el('h2', { class: 'sec', text: 'Decisions of the last 7 days' }));
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
          el('th', { text: 'By' }), el('th', { text: 'Result' }), el('th', { text: 'Note' }))),
        el('tbody', {}, ...rows)))));
  }

  box.append(el('p', { class: 'note', text: 'Rule: no approval does not mean standstill. When the deadline passes the default decision applies; the daemon records it.' }));
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
    box.append(emptyState('No data yet.'));
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
    ? `of ${fmtEur(budgetFromSettings)} daily budget`
    : budgetSum > 0 ? `of ${fmtEur(budgetSum)} total agent budgets` : 'no budget on file';

  box.append(el('div', { class: 'kpis' },
    kpi('Cards today', fmtInt(cardsToday), metrics.length ? 'from the daemon hourly values' : 'No data yet'),
    kpi('Night progress 22–07', fmtInt(nightDone), metrics.length ? 'cards completed at night' : 'No data yet'),
    kpi('Cost today', fmtEur(costToday), budgetLabel),
    kpi('Blockiert', fmtInt(blockedTasks.length),
      waitingOnJan.length ? `davon ${waitingOnJan.length} wartet auf dich` : 'nothing waits for you')));

  /* --- Diagramm --- */
  const chartBox = el('div', { class: 'box' },
    el('h3', { text: 'Throughput and tokens per day' }),
    el('p', { class: 'sub', text: 'Cards (bars) and tokens (line) from the hourly values — up to 7 days, depending on data.' }));

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
    chartBox.append(emptyState('No data yet.'));
  } else {
    chartBox.append(buildChart(days));
    chartBox.append(el('div', { class: 'legend' },
      el('span', {}, el('i', { style: { background: '#3d6d94' } }), 'Cards per day'),
      el('span', {}, el('i', { style: { background: '#4da3ff' } }), 'Tokens per day')));
  }

  /* --- Marktreife-Kurzfassung --- */
  const rd = board.readiness || [];
  const score = board.readiness_score;
  const side = el('div', { class: 'box' },
    el('h3', { text: 'Marktreife' }),
    el('p', { class: 'sub', text: rd.length ? `${rd.length} weighted criteria` : 'No criteria on file' }));
  if (!rd.length) {
    side.append(emptyState('No data yet.'));
  } else {
    side.append(el('div', { class: 'gauge' },
      donut(score),
      el('table', { class: 'rub' }, el('tbody', {}, ...rd.slice(0, 8).map((r) => el('tr', {},
        el('td', {}, `${r.label || r.key} `, el('span', { class: 's', text: `${num(r.score)}/5` })),
        el('td', { text: `${Math.round(num(r.weight) * 100)} %` })))))));
    side.append(el('p', { class: 'note' }, 'Details and edits under "Readiness".'));
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

  box.append(el('h2', { class: 'sec', text: 'Per agent' }));
  if (!agents.length) {
    box.append(emptyState('No data yet.'));
  } else {
    box.append(el('div', { class: 'card' }, el('div', { class: 'tbl-wrap' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Agent' }), el('th', { text: 'Role' }),
          el('th', { class: 'num', text: 'Cards today' }), el('th', { class: 'num', text: 'Tokens today' }),
          el('th', { class: 'num', text: 'Cost today' }), el('th', { class: 'num', text: 'Budget/day' }),
          el('th', { class: 'num', text: 'blocked' }), el('th', { text: 'Status' }))),
        el('tbody', {}, ...rows)))));
  }

  analyticsExtras(box, board);
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
    'aria-label': 'Throughput and tokens per day',
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
    box.append(emptyState('No data yet — no criteria stored.'));
    return;
  }

  const score = board.readiness_score;
  const weightSum = rd.reduce((s, r) => s + num(r.weight), 0);

  box.append(el('div', { class: 'box' },
    el('h3', { text: 'Marktreife — ehrlich gerechnet' }),
    el('p', { class: 'sub', text: `${rd.length} criteria · weights total ${Math.round(weightSum * 100)} % · score 0–5` }),
    el('div', { class: 'gauge' },
      donut(score),
      el('table', { class: 'rub' }, el('tbody', {}, ...rd.map((r) => el('tr', {},
        el('td', {}, `${r.label || r.key} `, el('span', { class: 's', text: `${num(r.score)}/5` })),
        el('td', { text: `${Math.round(num(r.weight) * 100)} %` }))))))));

  box.append(el('h2', { class: 'sec', text: 'Criteria' }));

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
        el('span', { class: 'w', text: `Weight ${Math.round(num(r.weight) * 100)} %` }),
        el('span', { class: 'sc' }, `${num(r.score)}/5`, scoreDots(num(r.score))),
        el('span', { class: 'w', text: r.updated_at ? `as of ${fmtWhen(r.updated_at)}` : 'nie bewertet' })),
      ev);

    if (open) {
      const msg = el('p', { class: 'msg' });
      const select = el('select', { class: 'inp' });
      for (let i = 0; i <= 5; i += 1) {
        const opt = el('option', { value: String(i), text: `${i} — ${['nothing yet', 'idea', 'prototype', 'works internally', 'works in the field', 'proven with customers'][i]}` });
        if (num(r.score) === i) opt.selected = true;
        select.append(opt);
      }
      const note = draftField(noteKey, { placeholder: 'Evidence: what exactly was measured, checked or proven? (required)', rows: 2 }, r.evidence_note || '');
      const url = el('input', { class: 'inp', type: 'url', placeholder: 'https://… (optional)', value: r.evidence_url || '' });
      url.addEventListener('input', () => state.drafts.set(urlKey, url.value));

      const save = el('button', { class: 'btn acc', type: 'button', text: 'Save score' });
      save.addEventListener('click', () => guard(save, async () => {
        const text = takeDraft(noteKey, r.evidence_note || '');
        if (text.length < 5) {
          setMsg(msg, 'Evidence text is required (at least 5 characters). No change without proof.', 'warn');
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

      const cancel = el('button', { class: 'btn plain', type: 'button', text: 'Cancel' });
      cancel.addEventListener('click', () => { state.openCrit = null; renderActiveView(true); });

      item.append(el('div', { style: { marginTop: '8px' } },
        el('label', { class: 'lbl', text: 'Score' }), select,
        el('label', { class: 'lbl', text: 'Evidenz (Pflicht)' }), note,
        el('label', { class: 'lbl', text: 'Beleg-URL (optional)' }), url,
        el('div', { class: 'row' }, save, cancel),
        msg));
    } else {
      const edit = el('button', { class: 'btn', type: 'button', text: 'Change score' });
      edit.addEventListener('click', () => {
        state.openCrit = key;
        renderActiveView(true);
      });
      item.append(el('div', { class: 'row' }, edit));
    }

    list.append(item);
  }
  box.append(list);
  box.append(el('p', { class: 'note' }, 'Rule: no score without evidence. "Works for me" without a measurement does not count.'));
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
  renderPasswordChange();
  renderSecurityQuestion();
  renderSettings(board);
  renderSession();
}

function renderWatchdog(board) {
  const box = $('#ops-watchdog');
  if (!box) return;
  clear(box);
  const list = board ? board.watchdog || [] : [];
  if (!list.length) { box.append(emptyState('No data yet — the watchdog has not reported.')); return; }
  const card = el('div', { class: 'card' });
  for (const w of list) {
    const dot = w.status === 'ok' ? '' : w.status === 'warn' ? 'w' : w.status === 'fail' ? 'b' : 'n';
    card.append(el('div', { class: 'wd' },
      el('span', { class: 'dot', style: { background: dot === 'w' ? 'var(--warn)' : dot === 'b' ? 'var(--bad)' : dot === 'n' ? '#3a424f' : 'var(--ok)' } }),
      el('span', { class: 'k', text: w.check_key || '—' }),
      el('span', { class: 'd', text: w.detail || (w.status === 'ok' ? 'no anomaly' : 'no detail') }),
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
  if (!list.length) { box.append(emptyState('No data yet — no incidents reported.')); return; }
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
        inc.needs_jan ? el('div', { class: 'man', text: 'Needs a decision from you.' }) : null,
        inc.resolved_at ? el('div', { class: 'role', text: `erledigt ${fmtWhen(inc.resolved_at)}` }) : null)));
  }
  box.append(feed);
}

function renderDevices(board) {
  const box = $('#ops-devices');
  if (!box) return;
  clear(box);
  const list = board ? board.devices || [] : [];
  if (!list.length) { box.append(emptyState('No data yet — no devices reported.')); return; }

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
          toast('Device revoked.', 'ok');
          refresh();
        });
      });
    }
    const label = d.status === 'trusted' ? 'freigeschaltet' : d.status === 'pending' ? 'wartet auf Antwort' : 'widerrufen';
    return el('tr', {},
      el('td', {}, el('b', { text: d.label || 'Device' })),
      el('td', { text: label }),
      el('td', { text: d.created_at ? fmtWhen(d.created_at) : '—' }),
      el('td', { text: d.trusted_at ? fmtWhen(d.trusted_at) : '—' }),
      el('td', { text: d.last_seen_at ? fmtAge(d.last_seen_at) : 'nie' }),
      el('td', {}, btn));
  });

  box.append(el('div', { class: 'card' },
    el('p', { class: 'sub', text: 'Only approved devices see content. Revocation is immediate — this device loses access.' }),
    el('div', { class: 'tbl-wrap' },
      el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Name' }), el('th', { text: 'Status' }), el('th', { text: 'Added' }),
          el('th', { text: 'Freigeschaltet' }), el('th', { text: 'Zuletzt gesehen' }), el('th', { text: '' }))),
        el('tbody', {}, ...rows)))));
}

function renderPasswordChange() {
  const box = $('#ops-password');
  if (!box) return;
  clear(box);

  const p1 = el('input', { class: 'inp', type: 'password', autocomplete: 'new-password', placeholder: 'New password' });
  const p2 = el('input', { class: 'inp', type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password' });
  const msg = el('p', { class: 'msg' });
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Change password' });

  btn.addEventListener('click', () => guard(btn, async () => {
    if (p1.value.length < 12) { setMsg(msg, 'Mindestens 12 Zeichen.', 'warn'); return; }
    if (p1.value !== p2.value) { setMsg(msg, 'Die beiden Eingaben sind unterschiedlich.', 'warn'); return; }
    const { error } = await sb.auth.updateUser({ password: p1.value });
    if (error) { setMsg(msg, error.message, 'bad'); return; }
    p1.value = ''; p2.value = '';
    setMsg(msg, 'Password changed. The new one applies at the next sign-in.', 'ok');
  }));

  box.append(el('div', { class: 'card' },
    el('p', { class: 'sub', text: 'Replaces the setup password. At least 12 characters; a passphrase of four words is easy to remember.' }),
    el('label', { class: 'lbl', text: 'New password' }), p1,
    el('label', { class: 'lbl', text: 'Wiederholen' }), p2,
    el('div', { class: 'row' }, btn),
    msg));
}

function renderSecurityQuestion() {
  const box = $('#ops-question');
  if (!box) return;
  clear(box);

  const q = el('input', { class: 'inp', type: 'text', autocomplete: 'off', placeholder: 'New question' });
  const a = el('input', { class: 'inp', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Neue Antwort' });
  const msg = el('p', { class: 'msg' });
  const btn = el('button', { class: 'btn acc', type: 'button', text: 'Change security question' });

  btn.addEventListener('click', () => guard(btn, async () => {
    if (q.value.trim().length < 6 || a.value.trim().length < 3) {
      setMsg(msg, 'Question at least 6 characters, answer at least 3.', 'warn');
      return;
    }
    const res = await rpc('set_security_question', { p_question: q.value.trim(), p_answer: a.value.trim() });
    if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
    q.value = ''; a.value = '';
    setMsg(msg, 'Security question changed. Existing approvals stay valid.', 'ok');
  }));

  box.append(el('div', { class: 'card' },
    el('p', { class: 'sub', text: 'Applies to new devices. The answer is stored only as a hash.' }),
    el('label', { class: 'lbl', text: 'Question' }), q,
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
    box.append(emptyState('No data yet — no settings stored.'));
    return;
  }

  for (const key of keys) {
    const draftKey = `set:${key}`;
    const pretty = JSON.stringify(settings[key], null, 2);
    const area = draftField(draftKey, { rows: Math.min(12, Math.max(4, pretty.split('\n').length)), spellcheck: 'false' }, pretty);
    area.className = 'inp mono';
    const msg = el('p', { class: 'msg' });
    const btn = el('button', { class: 'btn acc', type: 'button', text: `Save ${key}` });

    btn.addEventListener('click', () => guard(btn, async () => {
      let parsed;
      try {
        parsed = JSON.parse(area.value);
      } catch (e) {
        setMsg(msg, `Invalid JSON: ${e.message}`, 'bad');
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

  box.append(el('p', { class: 'note', text: 'Values are JSON. Unknown fields are stored unchanged; the daemon reads the new state on its next run.' }));
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
    toast('Signed out. The device stays approved.', 'ok');
  }));

  box.append(el('div', { class: 'card' },
    el('div', { class: 'meta', style: { marginBottom: '10px' } },
      el('span', {}, 'Angemeldet als ', el('b', { text: email })),
      el('span', {}, 'Rolle ', el('b', { text: (state.status && state.status.role) || '—' }))),
    el('div', { class: 'row' }, out),
    el('p', { class: 'note', text: 'Signing out only removes the session. The device token stays in the browser — this device still counts as approved.' })));
}

/* ================================================================ Start */

boot().catch((e) => {
  console.error(e);
  toast(`Start failed: ${e.message}`, 'bad');
  showOnly('view-login');
});

/* ================================================================ Tafel, Besuch, Sprachbefehl */

function applyBriefingLink(board) {
  const link = $('#briefing-link');
  if (!link) return;
  const cfg = board && board.settings && board.settings.briefing_url;
  const url = cfg && cfg.url ? cfg.url : null;
  if (url) {
    link.href = url;
    link.removeAttribute('hidden');
    link.title = 'Open the morning briefing in the local hub (home network only)';
  } else {
    link.setAttribute('hidden', 'hidden');
  }
  wireVoice();
}

function renderBlackboard(board) {
  const box = $('#overview-blackboard');
  if (!box) return;
  clear(box);

  const bb = board ? board.blackboard : null;
  const card = el('div', { class: 'tafel' });
  card.append(el('div', { class: 'tafel-head' },
    el('span', { class: 'tafel-title', text: 'What matters right now' }),
    el('span', { class: 'tafel-meta', text: bb && bb.updated_at
      ? 'as of ' + fmtWhen(bb.updated_at) + ' · ' + (bb.updated_by || 'jarvis')
      : 'not described yet' })));
  card.append(el('div', { class: 'tafel-body', text: (bb && bb.body) || 'No note on the board yet.' }));

  if (bb) {
    const area = el('textarea', { class: 'inp', rows: 4, maxlength: 900 });
    area.value = bb.body || '';
    const counter = el('span', { class: 'tafel-meta', text: (bb.body || '').length + '/900 Zeichen' });
    area.addEventListener('input', () => { counter.textContent = area.value.length + '/900 Zeichen'; });
    const msg = el('p', { class: 'msg' });
    const btn = el('button', { class: 'btn', type: 'button', text: 'Update board' });
    btn.addEventListener('click', () => guard(btn, async () => {
      const res = await rpc('set_blackboard', { p_body: area.value.trim() });
      if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
      setMsg(msg, 'Board updated.', 'ok');
      refresh();
    }));
    card.append(el('details', { class: 'tafel-edit' },
      el('summary', { text: 'Edit board' }),
      area,
      el('div', { class: 'row' }, counter),
      el('div', { class: 'row' }, btn),
      msg));
  }
  box.append(card);
}

function renderDigest() {
  const box = $('#overview-digest');
  if (!box) return;
  const d = state.visit;
  clear(box);
  if (!d || !d.ok) return;
  const since = d.since ? fmtWhen(d.since) : 'deinem ersten Besuch';
  const parts = [num(d.cards_done) + ' cards completed', num(d.events) + ' events'];
  if (num(d.open_approvals)) parts.push(num(d.open_approvals) + ' approvals open');
  if (num(d.incidents)) parts.push(num(d.incidents) + ' incidents');
  if (num(d.tokens)) parts.push(fmtTok(d.tokens) + ' Token');
  box.append(el('div', { class: 'digest' },
    el('b', { text: 'Since your last visit' }),
    el('span', { text: ' (' + since + '): ' + parts.join(' · ') })));
}

async function loadVisit() {
  try {
    const res = await rpc('visit', {});
    state.visit = res || null;
  } catch (err) {
    state.visit = null;
  }
  renderDigest();
}

function analyticsExtras(box, board) {
  if (!board) return;
  const metrics = board.metrics || [];
  const agents = board.agents || [];
  const usage = board.service_usage || [];

  /* --- Token je Agent, aufgeschlüsselt --- */
  const perAgent = new Map();
  for (const m of metrics) {
    const key = m.agent_key || '—';
    const cur = perAgent.get(key) || { input: 0, output: 0, cache: 0, total: 0 };
    cur.input += num(m.tokens_in);
    cur.output += num(m.tokens_out);
    cur.cache += num(m.tokens_cache);
    cur.total += num(m.tokens) || (num(m.tokens_in) + num(m.tokens_out) + num(m.tokens_cache));
    perAgent.set(key, cur);
  }
  const rows = [...perAgent.entries()].filter(([, v]) => v.total > 0).sort((a, b) => b[1].total - a[1].total);
  const maxTotal = Math.max(1, ...rows.map(([, v]) => v.total));
  const nameOf = (key) => (agents.find((a) => a.key === key) || {}).name || key;

  box.append(el('h2', { class: 'sec', text: 'Where the tokens go (7 days)' }));
  if (!rows.length) {
    box.append(emptyState('No token breakdown yet — the daemon writes it hourly.'));
  } else {
    const card = el('div', { class: 'card' });
    for (const [key, v] of rows) {
      const width = (part) => Math.max(part > 0 ? 1 : 0, (part / maxTotal) * 100);
      card.append(el('div', { class: 'tokrow' },
        el('div', { class: 'tokname', text: nameOf(key) }),
        el('div', { class: 'tokbar' },
          el('i', { class: 't-in', style: { width: width(v.input) + '%' }, title: 'Eingabe' }),
          el('i', { class: 't-out', style: { width: width(v.output) + '%' }, title: 'Ausgabe' }),
          el('i', { class: 't-cache', style: { width: width(v.cache) + '%' }, title: 'Cache' })),
        el('div', { class: 'tokval', text: fmtTok(v.total) })));
    }
    card.append(el('div', { class: 'legend' },
      el('span', {}, el('i', { class: 't-in' }), ' Eingabe'),
      el('span', {}, el('i', { class: 't-out' }), ' Ausgabe'),
      el('span', {}, el('i', { class: 't-cache' }), ' Cache (billig)')));
    box.append(card);
  }

  /* --- Aktivität je Stunde und Tag --- */
  const cells = new Map();
  for (const m of metrics) {
    const d = dateOf(m.hour);
    if (!d) continue;
    const day = berlinDay.format(d);
    const hour = Number(berlinHour.format(d));
    const key = day + '|' + hour;
    const prev = cells.get(key) || 0;
    cells.set(key, prev + (num(m.tokens) || 0) + num(m.tasks_done) * 5000);
  }
  const days = [...new Set([...cells.keys()].map((k) => k.split('|')[0]))].sort().slice(-7);
  const maxCell = Math.max(1, ...[...cells.values()]);

  box.append(el('h2', { class: 'sec', text: 'When work happened' }));
  if (!days.length) {
    box.append(emptyState('No hourly values yet.'));
  } else {
    const card = el('div', { class: 'card' });
    const head = el('div', { class: 'heat-head' });
    head.append(el('span', { class: 'heat-label', text: '' }));
    for (let h = 0; h < 24; h += 3) head.append(el('span', { class: 'heat-tick', text: h + 'h' }));
    card.append(head);
    for (const day of days) {
      const row = el('div', { class: 'heat-row' });
      row.append(el('span', { class: 'heat-label', text: fmtDay.format(new Date(day + 'T12:00:00')) }));
      for (let h = 0; h < 24; h += 1) {
        const value = cells.get(day + '|' + h) || 0;
        const alpha = value ? 0.12 + 0.88 * (value / maxCell) : 0;
        const cell = el('i', {
          class: 'heat-cell',
          title: day + ' ' + String(h).padStart(2, '0') + ':00 — ' + fmtTok(value),
        });
        cell.style.background = value ? 'rgba(77,163,255,' + alpha.toFixed(2) + ')' : 'rgba(255,255,255,0.04)';
        row.append(cell);
      }
      card.append(row);
    }
    card.append(el('p', { class: 'note', text: 'Brightness = activity (tokens and completed cards per hour, Berlin time). The daemon refreshes hourly values every five minutes.' }));
    box.append(card);
  }

  /* --- Fremddienst Antigravity --- */
  const antigravity = usage.filter((u) => u.service === 'antigravity');
  box.append(el('h2', { class: 'sec', text: 'Antigravity' }));
  if (!antigravity.length) {
    box.append(emptyState('No measurement yet — the daemon checks once a day.'));
  } else {
    const card = el('div', { class: 'card' });
    const pick = (metric) => antigravity.find((u) => u.metric === metric);
    const runsToday = pick('runs_today');
    const logged = pick('runs_logged');
    const lastRun = pick('last_run');
    card.append(el('div', { class: 'kpis' },
      kpi('Runs today', runsToday ? String(num(runsToday.value)) : '—', 'counted from CLI logs'),
      kpi('Runs in total', logged ? String(num(logged.value)) : '—', 'log files in the directory'),
      kpi('Letzter Lauf', lastRun && lastRun.detail ? lastRun.detail : '—', 'Zeitpunkt des letzten Aufrufs')));
    card.append(el('p', { class: 'note', text: 'The quota cannot be read from the CLI. Instead of an estimate this shows only what is verifiable — checked once a day.' }));
    box.append(card);
  }
}

function renderMessages(board) {
  const box = $('#live-messages');
  if (!box) return;
  clear(box);
  const msgs = board ? board.messages || [] : [];
  const agents = board ? board.agents || [] : [];

  const card = el('div', { class: 'card' });
  card.append(el('h2', { class: 'sec', text: 'Contact between agents' }));
  card.append(el('p', { class: 'sub', text: 'Messages land in the target profile inbox (INBOX.md) on the next daemon run — agents read them at the start of their work.' }));

  if (!msgs.length) {
    card.append(emptyState('No messages yet.'));
  } else {
    card.append(el('div', {}, ...msgs.slice(0, 10).map((m) => el('div', { class: 'inc' },
      el('div', { class: 'tm', text: fmtTime.format(dateOf(m.ts) || new Date()) }),
      el('div', {},
        el('div', { text: (m.from_agent || '—') + ' → ' + (m.to_agent || '—') }),
        el('div', { class: 'step', text: m.body || '' }),
        el('div', { class: 'role', text: m.delivered_at ? 'zugestellt' : 'wartet auf Zustellung' }))))));
  }

  if (agents.length) {
    const from = el('select', { class: 'inp' }, ...agents.map((a) => el('option', { value: a.key, text: a.name || a.key })));
    const to = el('select', { class: 'inp' }, ...agents.map((a) => el('option', { value: a.key, text: a.name || a.key })));
    to.value = 'jarvis';
    const body = el('textarea', { class: 'inp', rows: 2, placeholder: 'Short message …' });
    const msg = el('p', { class: 'msg' });
    const btn = el('button', { class: 'btn acc', type: 'button', text: 'Send message' });
    btn.addEventListener('click', () => guard(btn, async () => {
      const res = await rpc('send_message', { p_from: from.value, p_to: to.value, p_body: body.value.trim() });
      if (!res || !res.ok) { setMsg(msg, reasonText(res), 'bad'); return; }
      body.value = '';
      setMsg(msg, 'Queued — delivered on the next run.', 'ok');
      refresh();
    }));
    card.append(el('div', { class: 'row' }, from, el('span', { class: 'role', text: '→' }), to),
      body, el('div', { class: 'row' }, btn), msg);
  }
  box.append(card);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      resolve(data.slice(data.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function wireVoice() {
  const btn = $('#voice-btn');
  const status = $('#voice-state');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';

  let recorder = null;
  let chunks = [];
  let started = 0;
  let ticker = null;
  const label = $('#voice-label');
  const setStatus = (text, cls) => {
    if (!status) return;
    status.textContent = text;
    status.className = 'voice-state ' + (cls || '');
  };
  const startTicker = () => {
    const tick = () => {
      if (!label) return;
      const secs = Math.floor((Date.now() - started) / 1000);
      label.textContent = 'Aufnahme ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + ' — tippen zum Senden';
    };
    tick();
    ticker = setInterval(tick, 1000);
  };
  const stopTicker = () => {
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (label) label.textContent = 'Sprachnachricht aufnehmen';
    btn.classList.remove('rec');
  };

  btn.addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setStatus('This browser cannot record.', 'bad');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      started = Date.now();
      const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        stopTicker();
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 2000) { setStatus('Aufnahme zu kurz.', 'warn'); return; }
        setStatus('Uploading …', 'warn');
        try {
          const b64 = await blobToBase64(blob);
          const res = await rpc('submit_voice', {
            p_audio: b64,
            p_mime: blob.type || 'audio/webm',
            p_duration_ms: Date.now() - started,
          });
          if (!res || !res.ok) { setStatus(reasonText(res), 'bad'); return; }
          setStatus('Received — transcribing on the Mac (takes a few seconds).', 'ok');
          setTimeout(refresh, 6000);
        } catch (err) {
          setStatus('Upload failed.', 'bad');
        }
      };
      recorder.start();
      btn.classList.add('rec');
      startTicker();
      setStatus('Recording — tap again to stop.', 'warn');
    } catch (err) {
      setStatus('Microphone not permitted.', 'bad');
    }
  });
}
