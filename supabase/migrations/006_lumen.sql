-- 006_lumen.sql — Reichweitenmessung + Kontaktformular für lumenrib.me
--
-- Dieses Schema gehört NICHT zum Staff Board selbst, sondern zur Laternen-Seite.
-- Es liegt trotzdem hier, weil es dieselbe Datenbank und dieselbe
-- Geräteprüfung (staff.device_ok) nutzt — so gibt es nur einen Ort für Zahlen.
--
-- Grundsätze
--  * Der Browser speichert NICHTS: kein Cookie, kein localStorage, kein
--    sessionStorage. Deshalb braucht die Seite keinen Cookie-Banner
--    (§ 25 TDDDG greift nicht, wenn nichts auf dem Gerät gespeichert wird).
--  * Reichweite läuft über einen serverseitigen Tages-Hash aus IP +
--    User-Agent. Roh-IP wird nie gespeichert, der Hash ist nach dem Tag
--    nicht mehr zuordenbar und wird nach 400 Tagen gelöscht.
--  * anon darf ausschliesslich lumen.track() und lumen.contact() aufrufen.
--    Alle Tabellen: RLS an, keine Policies, keine Grants an anon.
--  * lumen.stats() und lumen.set_message_status() verlangen Besitzerrolle
--    UND ein freigeschaltetes Gerät (staff.is_owner() and staff.device_ok()).
--  * Fremde Origins werden abgewiesen; fehlt der Origin-Header ganz, gilt
--    das ebenfalls als Ablehnung (coalesce — sonst fällt die Prüfung bei
--    NULL still durch).
--  * Die Nutzlast von track() wird über eine Whitelist gefiltert
--    (lumen.clean_meta): nur Modellmaße und Motiv, nie Freitext.

create schema if not exists lumen;

-- ---------------------------------------------------------------- Tabellen

create table if not exists lumen.sessions_online (
  session_id  text primary key,          -- Hash aus IP+UA+Tag+Stunde
  visitor_id  text,                      -- Hash aus IP+UA+Tag
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  entry_path  text,
  last_path   text,
  lang        text,
  device      text,
  referrer    text,
  pageviews   int not null default 0,
  downloads   int not null default 0
);
create index if not exists lumen_sessions_last_seen_idx on lumen.sessions_online (last_seen desc);

create table if not exists lumen.events (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  kind        text not null,
  path        text,
  lang        text,
  device      text,
  visitor_id  text,
  session_id  text,
  referrer    text,
  meta        jsonb not null default '{}'::jsonb
);
create index if not exists lumen_events_ts_idx on lumen.events (ts desc);
create index if not exists lumen_events_kind_ts_idx on lumen.events (kind, ts desc);

create table if not exists lumen.contact_messages (
  id        bigserial primary key,
  ts        timestamptz not null default now(),
  name      text not null,
  email     text not null,
  topic     text,
  project   text,
  message   text not null,
  lang      text,
  ip_hash   text,
  status    text not null default 'new'
);
create index if not exists lumen_contact_ts_idx on lumen.contact_messages (ts desc);

-- ---------------------------------------------------------------- Helfer

create or replace function lumen.req_headers()
returns jsonb language plpgsql stable as $$
declare h jsonb;
begin
  begin
    h := current_setting('request.headers', true)::jsonb;
  exception when others then h := '{}'::jsonb;
  end;
  return coalesce(h, '{}'::jsonb);
end; $$;

create or replace function lumen.origin_ok()
returns boolean language sql stable as $$
  select coalesce(lumen.req_headers()->>'origin' in
         ('https://lumenrib.me','https://www.lumenrib.me','https://janbleile09-lab.github.io'), false);
$$;

create or replace function lumen.fingerprint(p_salt text)
returns text language sql stable set search_path to 'lumen','public','extensions' as $$
  select substr(encode(extensions.digest(
    coalesce(lumen.req_headers()->>'x-forwarded-for','0.0.0.0') || '|' ||
    coalesce(lumen.req_headers()->>'user-agent','?') || '|' ||
    to_char(now() at time zone 'Europe/Berlin','YYYYMMDD') || '|' || coalesce(p_salt,''), 'sha256'), 'hex'), 1, 24);
$$;

create or replace function lumen.kind_ok(p_kind text)
returns boolean language sql immutable as $$
  select p_kind in ('pageview','configurator_open','stl_download','export_open','preset','heartbeat','contact_submit');
$$;

-- Nur diese Schlüssel dürfen aus dem Browser in meta landen.
create or replace function lumen.clean_meta(p_meta jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(coalesce(p_meta,'{}'::jsonb))='object'
                         then coalesce(p_meta,'{}'::jsonb) else '{}'::jsonb end) as e
   where e.key in ('dia','height','candle','ribs','motif','kb','preset')
     and jsonb_typeof(e.value) in ('number','string')
     and length(e.value::text) <= 40;
$$;

-- ---------------------------------------------------------------- Tracking

create or replace function lumen.track(
  p_kind text default 'pageview', p_path text default null, p_lang text default null,
  p_device text default null, p_ref text default null, p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path to 'lumen','public','extensions'
as $$
declare
  v_kind text := left(btrim(coalesce(p_kind,'pageview')),40);
  v_path text := left(coalesce(p_path,'/'),160);
  v_lang text := case when p_lang in ('de','en') then p_lang else null end;
  v_dev  text := case when p_device in ('desktop','mobile','tablet') then p_device else null end;
  v_ref  text := nullif(left(coalesce(p_ref,''),120),'');
  v_meta jsonb := lumen.clean_meta(coalesce(p_meta,'{}'::jsonb));
  v_vis  text := lumen.fingerprint('');
  v_sess text := lumen.fingerprint(to_char(now() at time zone 'Europe/Berlin','HH24'));
  v_recent int;
begin
  if not lumen.origin_ok() then return jsonb_build_object('ok',false,'reason','origin'); end if;
  if not lumen.kind_ok(v_kind) then return jsonb_build_object('ok',false,'reason','kind'); end if;

  -- Bremse gegen aufgeblähte Zahlen: 200 Ereignisse pro Besucher in 10 Minuten
  select count(*) into v_recent from lumen.events
   where visitor_id = v_vis and ts > now() - interval '10 minutes';
  if v_recent > 200 then return jsonb_build_object('ok',false,'reason','rate'); end if;

  insert into lumen.events (kind,path,lang,device,visitor_id,session_id,referrer,meta)
  values (v_kind,v_path,v_lang,v_dev,v_vis,v_sess,v_ref,v_meta);

  insert into lumen.sessions_online
    (session_id,visitor_id,first_seen,last_seen,entry_path,last_path,lang,device,referrer,pageviews,downloads)
  values (v_sess,v_vis,now(),now(),v_path,v_path,v_lang,v_dev,v_ref,
          case when v_kind='pageview' then 1 else 0 end,
          case when v_kind='stl_download' then 1 else 0 end)
  on conflict (session_id) do update set
    last_seen = now(),
    last_path = coalesce(excluded.last_path, lumen.sessions_online.last_path),
    lang      = coalesce(excluded.lang, lumen.sessions_online.lang),
    device    = coalesce(excluded.device, lumen.sessions_online.device),
    pageviews = lumen.sessions_online.pageviews + case when v_kind='pageview' then 1 else 0 end,
    downloads = lumen.sessions_online.downloads + case when v_kind='stl_download' then 1 else 0 end;

  return jsonb_build_object('ok',true);
end; $$;

-- ---------------------------------------------------------------- Kontakt

create or replace function lumen.contact(
  p_name text, p_email text, p_message text,
  p_topic text default null, p_project text default null,
  p_lang text default 'de', p_honeypot text default null
) returns jsonb
language plpgsql security definer set search_path to 'lumen','public','extensions'
as $$
declare
  v_hash text := lumen.fingerprint('');
  v_recent int;
begin
  if not lumen.origin_ok() then return jsonb_build_object('ok',false,'reason','origin'); end if;
  -- Honeypot: Bots füllen das unsichtbare Feld, Menschen nicht.
  if coalesce(p_honeypot,'') <> '' then return jsonb_build_object('ok',true); end if;
  if length(btrim(coalesce(p_name,''))) < 2
     or length(btrim(coalesce(p_message,''))) < 10
     or coalesce(p_email,'') !~ '^[^@[:space:]]+@[^@[:space:]]+[.][A-Za-z]{2,}$'
     or length(coalesce(p_message,'')) > 5000 then
    return jsonb_build_object('ok',false,'reason','invalid');
  end if;
  select count(*) into v_recent from lumen.contact_messages
   where ip_hash = v_hash and ts > now() - interval '10 minutes';
  if v_recent >= 3 then return jsonb_build_object('ok',false,'reason','rate'); end if;

  insert into lumen.contact_messages (name,email,topic,project,message,lang,ip_hash)
  values (left(btrim(p_name),120), left(btrim(p_email),200), left(coalesce(p_topic,''),120),
          left(coalesce(p_project,''),200), left(btrim(p_message),5000),
          case when p_lang in ('de','en') then p_lang else 'de' end, v_hash);

  insert into lumen.events (kind,path,lang,visitor_id,session_id)
  values ('contact_submit','/kontakt',case when p_lang in ('de','en') then p_lang else 'de' end,
          v_hash, lumen.fingerprint(to_char(now() at time zone 'Europe/Berlin','HH24')));

  return jsonb_build_object('ok',true);
end; $$;

-- ---------------------------------------------------------------- Auswertung

-- Rohauswertung ohne Rechteprüfung. Aufrufbar nur über lumen.stats().
create or replace function lumen.stats_raw(p_days int default 30)
returns jsonb language plpgsql set search_path to 'lumen','public'
as $f$
declare res jsonb; d int := greatest(1, least(coalesce(p_days,30),365));
begin
  select jsonb_build_object(
    'ok', true, 'now', now(), 'days', d,
    'online', jsonb_build_object(
      'now',      (select count(distinct visitor_id) from lumen.sessions_online where last_seen > now()-interval '90 seconds'),
      'five_min', (select count(distinct visitor_id) from lumen.sessions_online where last_seen > now()-interval '5 minutes'),
      'today',    (select count(distinct visitor_id) from lumen.events
                    where visitor_id is not null
                      and ts >= date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')),
    'live', coalesce((select jsonb_agg(jsonb_build_object(
        'visitor', left(s.visitor_id,6), 'last_seen', s.last_seen, 'entry_path', s.entry_path,
        'last_path', s.last_path, 'lang', s.lang, 'device', s.device,
        'pageviews', s.pageviews, 'downloads', s.downloads) order by s.last_seen desc)
      from (select * from lumen.sessions_online where last_seen > now()-interval '5 minutes'
             order by last_seen desc limit 30) s), '[]'::jsonb),
    'totals', jsonb_build_object(
      'pageviews',         (select count(*) from lumen.events where kind='pageview' and ts > now()-(d||' days')::interval),
      'visitors',          (select count(distinct visitor_id) from lumen.events where kind='pageview' and ts > now()-(d||' days')::interval),
      'configurator',      (select count(*) from lumen.events where kind='configurator_open' and ts > now()-(d||' days')::interval),
      'downloads',         (select count(*) from lumen.events where kind='stl_download' and ts > now()-(d||' days')::interval),
      'download_visitors', (select count(distinct visitor_id) from lumen.events where kind='stl_download' and ts > now()-(d||' days')::interval),
      'presets',           (select count(*) from lumen.events where kind='preset' and ts > now()-(d||' days')::interval),
      'contacts',          (select count(*) from lumen.contact_messages where ts > now()-(d||' days')::interval),
      'contacts_new',      (select count(*) from lumen.contact_messages where status='new')),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day',x.day_col,'pageviews',x.pv,'visitors',x.vis,'downloads',x.dl) order by x.day_col)
      from (select (ts at time zone 'Europe/Berlin')::date as day_col,
                   count(*) filter (where kind='pageview') as pv,
                   count(distinct visitor_id) filter (where kind='pageview') as vis,
                   count(*) filter (where kind='stl_download') as dl
              from lumen.events where ts > now()-(d||' days')::interval group by 1) x), '[]'::jsonb),
    'paths', coalesce((select jsonb_agg(jsonb_build_object('path',y.path,'views',y.views) order by y.views desc)
      from (select path, count(*) as views from lumen.events
             where kind='pageview' and ts > now()-(d||' days')::interval
             group by path order by 2 desc limit 12) y), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(jsonb_build_object('ref',z.ref,'n',z.n) order by z.n desc)
      from (select coalesce(nullif(referrer,''),'direkt') as ref, count(*) as n from lumen.events
             where kind='pageview' and ts > now()-(d||' days')::interval
             group by 1 order by 2 desc limit 10) z), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('device',coalesce(device,'?'),'n',w.n) order by w.n desc)
      from (select device, count(distinct visitor_id) as n from lumen.events
             where kind='pageview' and ts > now()-(d||' days')::interval group by 1 order by 2 desc) w), '[]'::jsonb),
    'langs', coalesce((select jsonb_agg(jsonb_build_object('lang',coalesce(lang,'?'),'n',l.n) order by l.n desc)
      from (select lang, count(*) as n from lumen.events
             where kind='pageview' and ts > now()-(d||' days')::interval group by 1 order by 2 desc) l), '[]'::jsonb),
    'hourly', coalesce((select jsonb_agg(jsonb_build_object('hour',h.h,'views',h.n) order by h.h)
      from (select date_trunc('hour', ts at time zone 'Europe/Berlin') as h, count(*) as n
              from lumen.events where kind='pageview' and ts > now()-interval '48 hours'
             group by 1) h), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'ts',m.ts,'name',m.name,'email',m.email,
        'topic',m.topic,'project',m.project,'message',m.message,'status',m.status) order by m.ts desc)
      from (select * from lumen.contact_messages order by ts desc limit 40) m), '[]'::jsonb),
    'last_downloads', coalesce((select jsonb_agg(jsonb_build_object('ts',e.ts,'lang',e.lang,'device',e.device,'meta',e.meta) order by e.ts desc)
      from (select * from lumen.events where kind='stl_download' order by ts desc limit 12) e), '[]'::jsonb)
  ) into res;
  return res;
end; $f$;

create or replace function lumen.stats(p_days int default 30)
returns jsonb language plpgsql security definer set search_path to 'lumen','public','staff'
as $$
begin
  -- Nur Jan selbst, nicht der Agent: Website-Zahlen sind Owner-Sache.
  if not (staff.is_owner() and staff.device_ok()) then
    return jsonb_build_object('ok',false,'reason','device_not_trusted');
  end if;
  return lumen.stats_raw(p_days);
end; $$;

create or replace function lumen.set_message_status(p_id bigint, p_status text)
returns jsonb language plpgsql security definer set search_path to 'lumen','public','staff'
as $$
begin
  if not (staff.is_owner() and staff.device_ok()) then
    return jsonb_build_object('ok',false,'reason','device_not_trusted');
  end if;
  if p_status not in ('new','read','done','spam') then
    return jsonb_build_object('ok',false,'reason','status');
  end if;
  update lumen.contact_messages set status=p_status where id=p_id;
  return jsonb_build_object('ok',true);
end; $$;

create or replace function lumen.prune()
returns int language plpgsql security definer set search_path to 'lumen'
as $$
declare n int; m int;
begin
  delete from lumen.sessions_online where last_seen < now()-interval '2 hours';
  get diagnostics n = row_count;
  delete from lumen.events where ts < now()-interval '400 days';
  get diagnostics m = row_count;
  return n+m;
end; $$;

-- ---------------------------------------------------------------- Rechte

alter table lumen.sessions_online  enable row level security;
alter table lumen.events           enable row level security;
alter table lumen.contact_messages enable row level security;

revoke all on lumen.sessions_online, lumen.events, lumen.contact_messages from anon, authenticated;
revoke all on schema lumen from public;
grant usage on schema lumen to anon, authenticated;

-- Postgres gibt Funktionen standardmässig an PUBLIC aus. Erst alles sperren,
-- dann nur das Nötige freigeben.
revoke all on function lumen.track(text,text,text,text,text,jsonb)                from public, anon, authenticated;
revoke all on function lumen.contact(text,text,text,text,text,text,text)          from public, anon, authenticated;
revoke all on function lumen.stats_raw(int)                                       from public, anon, authenticated;
revoke all on function lumen.stats(int)                                           from public, anon, authenticated;
revoke all on function lumen.set_message_status(bigint,text)                       from public, anon, authenticated;
revoke all on function lumen.prune()                                               from public, anon;
revoke all on function lumen.fingerprint(text)                                     from public, anon, authenticated;
revoke all on function lumen.req_headers()                                         from public, anon, authenticated;
revoke all on function lumen.origin_ok()                                           from public, anon, authenticated;
revoke all on function lumen.kind_ok(text)                                         from public, anon, authenticated;
revoke all on function lumen.clean_meta(jsonb)                                     from public, anon, authenticated;

grant execute on function lumen.track(text,text,text,text,text,jsonb)       to anon, authenticated;
grant execute on function lumen.contact(text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function lumen.stats(int)                                  to authenticated;
grant execute on function lumen.set_message_status(bigint,text)             to authenticated;
grant execute on function lumen.prune()                                     to authenticated;

-- PostgREST muss das Schema sehen; ohne das liefert /rest/v1/rpc/track 404.
alter role authenticator set pgrst.db_schemas = 'public,staff,lumen';
