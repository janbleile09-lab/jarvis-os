-- 005 — Direktmodus: JARVIS ohne Arbeiter-Schwarm
--
-- Ab jetzt arbeitet Jan direkt mit JARVIS statt mit sechs Unteragenten. Das Board
-- zeigt deshalb keine Karten und kein Organigramm mehr, sondern:
--   * sessions_live  — was JARVIS gerade tut (Quelle: ~/.hermes/state.db, alle
--                      Kanaele: WhatsApp, Mac-CLI, Desktop, Board-Chat) und ob er
--                      auf Jan wartet
--   * chat_threads / chat_messages — ein Chat, den Jan vom Board aus startet und
--                      fortschreibt; der Daemon fuehrt jeden Zug gegen Hermes aus
--   * approvals.notified_at — damit der Daemon Jan einmal pro Freigabe per
--                      WhatsApp anpingt statt taeglich zu wiederholen
--
-- Schreibrechte: Jan schreibt ausschliesslich ueber die RPCs (security definer,
-- Geraetepruefung). Der Daemon (Rolle agent) liest und schreibt die Tabellen direkt.

-- --------------------------------------------------------------------- Freigaben

alter table staff.approvals add column if not exists notified_at timestamptz;
create index if not exists approvals_unnotified on staff.approvals (created_at)
  where status = 'open' and notified_at is null;

-- --------------------------------------------------------------------- Live-Sitzungen

create table if not exists staff.sessions_live (
  session_id     text primary key,
  source         text not null default 'local',   -- whatsapp | cli | desktop | board | cron
  channel        text,                            -- Klartext-Kanal fuer die Anzeige
  title          text,
  status         text not null default 'idle',    -- working | waiting_you | idle | done
  live_note      text,                            -- letzter Schritt (Werkzeug/Text)
  live_at        timestamptz,
  last_user_text text,
  last_reply     text,
  waiting_reason text,
  started_at     timestamptz,
  last_activity  timestamptz,
  message_count  int not null default 0,
  tool_calls     int not null default 0,
  tokens         bigint not null default 0,
  cost_eur       numeric(10, 4) not null default 0,
  updated_at     timestamptz not null default now()
);

create index if not exists sessions_live_activity
  on staff.sessions_live (last_activity desc);

-- --------------------------------------------------------------------- Board-Chat

create table if not exists staff.chat_threads (
  id              uuid primary key default gen_random_uuid(),
  title           text,
  session_id      text,                            -- Hermes-Sitzung, sobald bekannt
  status          text not null default 'open',    -- open | archived
  last_role       text,                            -- user | jarvis
  last_at         timestamptz,
  working         boolean not null default false,  -- Daemon fuehrt gerade aus
  work_started_at timestamptz,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists chat_threads_recent
  on staff.chat_threads (updated_at desc);
create index if not exists chat_threads_pending
  on staff.chat_threads (updated_at) where last_role = 'user';

create table if not exists staff.chat_messages (
  id         bigserial primary key,
  thread_id  uuid not null references staff.chat_threads (id) on delete cascade,
  role       text not null check (role in ('user', 'jarvis', 'system')),
  body       text not null,
  tokens     int,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread
  on staff.chat_messages (thread_id, created_at);

-- --------------------------------------------------------------------- Rechte

grant select on staff.sessions_live, staff.chat_threads, staff.chat_messages
  to authenticated;
grant insert, update, delete on staff.sessions_live, staff.chat_threads, staff.chat_messages
  to authenticated;
grant usage, select on sequence staff.chat_messages_id_seq to authenticated;

drop policy if exists sessions_live_read on staff.sessions_live;
create policy sessions_live_read on staff.sessions_live for select to authenticated
  using (staff.read_ok());

drop policy if exists sessions_live_write on staff.sessions_live;
create policy sessions_live_write on staff.sessions_live for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());

drop policy if exists chat_threads_read on staff.chat_threads;
create policy chat_threads_read on staff.chat_threads for select to authenticated
  using (staff.read_ok());

drop policy if exists chat_threads_write on staff.chat_threads;
create policy chat_threads_write on staff.chat_threads for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());

drop policy if exists chat_messages_read on staff.chat_messages;
create policy chat_messages_read on staff.chat_messages for select to authenticated
  using (staff.read_ok());

drop policy if exists chat_messages_write on staff.chat_messages;
create policy chat_messages_write on staff.chat_messages for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());

drop policy if exists approvals_notify on staff.approvals;
create policy approvals_notify on staff.approvals for update to authenticated
  using (staff.is_agent()) with check (staff.is_agent());

-- --------------------------------------------------------------------- RPC: jarvis_live

create or replace function staff.jarvis_live()
returns jsonb
language plpgsql
security definer
set search_path to 'staff', 'public'
as $function$
declare
  res jsonb;
begin
  if not staff.device_ok() then
    return jsonb_build_object('ok', false, 'reason', 'device_not_trusted');
  end if;

  select jsonb_build_object(
    'ok', true,
    'now', now(),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'session_id', s.session_id, 'source', s.source, 'channel', s.channel,
        'title', s.title, 'status', s.status, 'live_note', s.live_note,
        'live_at', s.live_at, 'last_user_text', s.last_user_text,
        'last_reply', s.last_reply, 'waiting_reason', s.waiting_reason,
        'started_at', s.started_at, 'last_activity', s.last_activity,
        'message_count', s.message_count, 'tool_calls', s.tool_calls,
        'tokens', s.tokens, 'cost_eur', s.cost_eur)
        order by s.last_activity desc nulls last)
      from (select * from staff.sessions_live
             where last_activity > now() - interval '36 hours'
             order by last_activity desc nulls last limit 12) s), '[]'::jsonb),
    'chats', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'title', t.title, 'status', t.status,
        'last_role', t.last_role, 'last_at', t.last_at, 'working', t.working,
        'error', t.error, 'created_at', t.created_at, 'updated_at', t.updated_at,
        'preview', (select left(m.body, 160) from staff.chat_messages m
                     where m.thread_id = t.id order by m.created_at desc limit 1),
        'messages', (select count(*) from staff.chat_messages m where m.thread_id = t.id))
        order by t.updated_at desc)
      from (select * from staff.chat_threads where status <> 'archived'
             order by updated_at desc limit 12) t), '[]'::jsonb),
    'open_approvals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'title', a.title, 'question', a.question, 'kind', a.kind,
        'risk', a.risk, 'expires_at', a.expires_at, 'created_at', a.created_at)
        order by a.created_at desc)
      from (select * from staff.approvals where status = 'open'
             order by created_at desc limit 10) a), '[]'::jsonb),
    'waiting_count', (select count(*) from staff.approvals where status = 'open')
  ) into res;

  return res;
end $function$;

-- --------------------------------------------------------------------- RPC: chat_send

create or replace function staff.chat_send(p_thread uuid, p_text text)
returns jsonb
language plpgsql
security definer
set search_path to 'staff', 'public'
as $function$
declare
  uid uuid := auth.uid();
  txt text := btrim(coalesce(p_text, ''));
  tid uuid := p_thread;
  ttl text;
begin
  if not staff.ui_ok() then
    return jsonb_build_object('ok', false, 'reason', 'device_not_trusted');
  end if;
  if txt = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if length(txt) > 4000 then
    txt := left(txt, 4000);
  end if;

  if tid is null then
    ttl := left(regexp_replace(txt, '\s+', ' ', 'g'), 70);
    insert into staff.chat_threads (title, last_role, last_at)
      values (ttl, 'user', now())
      returning id into tid;
  else
    if not exists (select 1 from staff.chat_threads where id = tid) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_thread');
    end if;
    update staff.chat_threads
       set status = 'open', last_role = 'user', last_at = now(),
           updated_at = now(), error = null
     where id = tid;
  end if;

  insert into staff.chat_messages (thread_id, role, body) values (tid, 'user', txt);
  return jsonb_build_object('ok', true, 'thread', tid);
end $function$;

-- --------------------------------------------------------------------- RPC: chat_thread

create or replace function staff.chat_thread(p_thread uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'staff', 'public'
as $function$
declare
  t staff.chat_threads;
begin
  if not staff.device_ok() then
    return jsonb_build_object('ok', false, 'reason', 'device_not_trusted');
  end if;
  select * into t from staff.chat_threads where id = p_thread;
  if t.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_thread');
  end if;
  return jsonb_build_object(
    'ok', true,
    'thread', jsonb_build_object(
      'id', t.id, 'title', t.title, 'status', t.status, 'last_role', t.last_role,
      'last_at', t.last_at, 'working', t.working, 'error', t.error,
      'created_at', t.created_at, 'updated_at', t.updated_at),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'role', m.role, 'body', m.body, 'created_at', m.created_at)
        order by m.created_at)
      from (select * from staff.chat_messages where thread_id = p_thread
             order by created_at desc limit 200) m), '[]'::jsonb));
end $function$;

-- --------------------------------------------------------------------- Rechte auf RPCs

grant execute on function staff.jarvis_live(), staff.chat_send(uuid, text),
  staff.chat_thread(uuid) to authenticated;
