-- Opening Night v3 — "Needs You", notifications, and the scheduled tick.
--
-- Nothing in the app sends a push. The pieces, all server-side:
--
--   pending actions  what each member still has to do (RSVP, vote, confirm,
--                    pay, predict, rate). DERIVED from the current state on
--                    every read, not stored, so it cannot drift from it: the
--                    moment someone answers, their action is gone.
--   inbox            public.notifications. Written only by private.notify,
--                    de-duplicated per recipient by dedupe_key.
--   outbox           private.notification_deliveries, one queued row per
--                    inbox row per enabled device, created by a trigger on
--                    the inbox. private.sms_outbox for the rare SMS.
--   planner          private.plan_notifications() turns pending actions into
--                    reminders. It only ever reads pending actions, so a
--                    reminder stops the moment its reason does (a paid charge
--                    is never reminded again). Its dedupe keys carry the
--                    stage or the day, which is the cooldown.
--   tick             private.tick(), every few minutes: settles deadlines
--                    that have passed, runs the automatic voting close, then
--                    the planner.
--   dispatcher       the notifications-dispatch Edge Function claims queued
--                    deliveries (dispatch_claim), sends them through Expo,
--                    and reports back (dispatch_report), including receipts,
--                    so dead tokens are switched off.
--
--   authenticated (member)  get_pending_actions, register_push_device,
--                           unregister_push_device
--   authenticated (Dino)    send_notification
--   service_role            run_tick, dispatch_claim, dispatch_report

-- ---------------------------------------------------------------------------
-- 1. Schema additions
-- ---------------------------------------------------------------------------

alter table private.notification_policy
  add column priority text not null default 'default',
  add constraint notification_policy_priority_check check (priority in ('default', 'high'));

alter table private.notification_deliveries
  add column claimed_at         timestamptz,
  add column receipt_checked_at timestamptz;

create index notification_deliveries_receipts_idx on private.notification_deliveries (sent_at)
  where status = 'sent' and provider_ticket_id is not null and receipt_checked_at is null;

-- SMS is for exactly one thing besides sign-in: a payment that has stayed
-- unpaid long past the reminders. One row per escalation; the dedupe key
-- makes it once per charge.
create table private.sms_outbox (
  id           uuid        primary key default gen_random_uuid(),
  member_id    uuid        not null references public.members (id) on delete cascade,
  event_id     uuid        references public.events (id) on delete cascade,
  kind         text        not null,
  body         text        not null,
  dedupe_key   text        not null,
  status       text        not null default 'queued',
  attempt_count integer    not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  constraint sms_outbox_status_check check (status in ('queued', 'sent', 'failed', 'cancelled')),
  constraint sms_outbox_body_check check (char_length(body) between 1 and 320),
  constraint sms_outbox_dedupe_key unique (dedupe_key)
);

alter table private.sms_outbox enable row level security;
revoke all on table private.sms_outbox from public, anon, authenticated, service_role;

-- Per-kind policy. A kind with no row pushes with default priority and no
-- cap. Payment reminders are capped; seat assignments (a future feature) are
-- the one high-priority kind.
insert into private.notification_policy (kind, send_push, max_per_member_per_day, priority) values
  ('event_created',     true, null, 'default'),
  ('rsvp_reminder',     true, 2,    'default'),
  ('vote_reminder',     true, 1,    'default'),
  ('confirm_reminder',  true, 2,    'default'),
  ('payment_posted',    true, null, 'default'),
  ('payment_reminder',  true, 1,    'default'),
  ('event_reminder',    true, null, 'default'),
  ('rating_reminder',   true, 1,    'default'),
  ('announcement',      true, null, 'default'),
  ('seat_assigned',     true, null, 'high')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Pending actions
-- ---------------------------------------------------------------------------

-- One row per thing a member still has to do. member_id is who must act (a
-- guest's host for the guest's rows); participant_id is who it is about.
create function private.pending_actions()
returns table (event_id uuid, member_id uuid, participant_id uuid, kind text, due_at timestamptz)
language sql stable set search_path = '' as $$
  -- RSVP: every active member who has not answered an open event.
  select e.id, m.id, p.id, 'rsvp', e.rsvp_deadline
  from public.events e
  cross join public.members m
  left join public.event_participants p on p.event_id = e.id and p.member_id = m.id
  where m.status = 'active' and e.selected_showtime_id is null and e.ended_at is null
    and now() < e.rsvp_deadline and p.rsvp_status is null

  union all
  select x.event_id, x.actor_id, x.participant_id, x.kind, x.due_at
  from (
    -- Vote: Going/Maybe with no current ballot while voting is open.
    select e.id as event_id, coalesce(p.member_id, g.host_member_id) as actor_id, p.id as participant_id,
           'vote' as kind, null::timestamptz as due_at
    from public.events e
    join public.event_participants p on p.event_id = e.id and p.rsvp_status in ('going', 'maybe')
    left join public.guests g on g.id = p.guest_id
    left join public.showtime_ballots b
      on b.participant_id = p.id and b.voting_revision = e.voting_revision and b.invalidated_at is null
    where e.selected_showtime_id is null and e.voting_closed_at is null and e.ended_at is null
      and b.participant_id is null
      and exists (select 1 from public.showtimes s where s.event_id = e.id and s.removed_at is null)

    union all
    -- Confirm: Going/Maybe, pending, while confirmation is open.
    select e.id, coalesce(p.member_id, g.host_member_id), p.id, 'confirm', e.confirmation_deadline
    from public.events e
    join public.event_participants p on p.event_id = e.id and p.rsvp_status in ('going', 'maybe')
    left join public.guests g on g.id = p.guest_id
    where e.selected_showtime_id is not null and e.tickets_purchased_at is null and e.ended_at is null
      and now() < e.confirmation_deadline and p.confirmation_status is null

    union all
    -- Pay: every unpaid charge, for as long as it is unpaid (into Past).
    select c.event_id, coalesce(p.member_id, g.host_member_id), p.id, 'pay', null
    from public.charges c
    join public.event_participants p on p.id = c.participant_id
    left join public.guests g on g.id = p.guest_id
    where c.status = 'unpaid'

    union all
    -- Predict: confirmed, no prediction yet, the night has not ended.
    select e.id, coalesce(p.member_id, g.host_member_id), p.id, 'predict', null
    from public.events e
    join public.event_participants p on p.event_id = e.id and p.confirmation_status = 'attending'
    left join public.guests g on g.id = p.guest_id
    where e.selected_showtime_id is not null and e.ended_at is null
      and not exists (select 1 from public.predictions pr where pr.participant_id = p.id)

    union all
    -- Rate: checked-in members, inside the 48 hours, no rating yet.
    select e.id, p.member_id, p.id, 'rate', e.ended_at + interval '48 hours'
    from public.events e
    join public.event_participants p on p.event_id = e.id and p.member_id is not null and p.checked_in_at is not null
    where e.ended_at is not null and now() < e.ended_at + interval '48 hours'
      and not exists (select 1 from public.ratings r where r.participant_id = p.id)
  ) x
  join public.members m on m.id = x.actor_id and m.status = 'active'
$$;

revoke all on function private.pending_actions() from public, anon, authenticated, service_role;

-- The caller's own "Needs You" list.
create function private.get_pending_actions_impl()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := private.require_member();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('event_id', a.event_id, 'participant_id', a.participant_id,
                                        'kind', a.kind, 'due_at', a.due_at)
                     order by a.due_at nulls last, a.kind)
    from private.pending_actions() a where a.member_id = v_me), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Push devices and the outbox
-- ---------------------------------------------------------------------------

create function private.register_push_device_impl(p_push_token text, p_platform text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_member();
begin
  if p_push_token is null or p_push_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_:-]{10,200}\]$' then
    raise exception 'That is not a push token.' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'Platform is ios or android.' using errcode = '22023';
  end if;
  -- A token belongs to one device; whoever is signed in on it now owns it.
  insert into private.push_devices as d (member_id, push_token, platform)
  values (v_me, p_push_token, p_platform)
  on conflict (push_token) do update
    set member_id = excluded.member_id, platform = excluded.platform, last_seen_at = now(),
        disabled_at = null, disabled_reason = null;
end;
$$;

-- On sign-out. Only the caller's own token can be removed.
create function private.unregister_push_device_impl(p_push_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me uuid := private.require_member();
begin
  delete from private.push_devices d where d.push_token = p_push_token and d.member_id = v_me;
end;
$$;

-- Every inbox row is offered to the recipient's devices, subject to the
-- kind's policy. Trigger function; nobody is granted EXECUTE.
create function private.queue_deliveries()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_policy private.notification_policy%rowtype;
begin
  select * into v_policy from private.notification_policy np where np.kind = new.kind;
  if found then
    if not v_policy.send_push then
      return new;
    end if;
    if v_policy.max_per_member_per_day is not null and (
      select count(*) from public.notifications n
      where n.recipient_member_id = new.recipient_member_id and n.kind = new.kind
        and n.id <> new.id and n.created_at > now() - interval '24 hours'
    ) >= v_policy.max_per_member_per_day then
      return new;
    end if;
  end if;
  insert into private.notification_deliveries (notification_id, push_device_id)
  select new.id, d.id from private.push_devices d
  where d.member_id = new.recipient_member_id and d.disabled_at is null
  on conflict (notification_id, push_device_id) do nothing;
  return new;
end;
$$;

revoke all on function private.queue_deliveries() from public, anon, authenticated, service_role;

create trigger queue_deliveries after insert on public.notifications
  for each row execute function private.queue_deliveries();

-- ---------------------------------------------------------------------------
-- 4. The planner
-- ---------------------------------------------------------------------------

-- Reads pending actions, writes reminders. Safe to run as often as you like:
-- every write carries a dedupe key, so running it twice sends nothing twice.
--
--   RSVP      gentle (a day after the event was posted), near (48 hours
--             before the deadline), final (6 hours before). Stops the moment
--             the member answers or the deadline passes.
--   vote      once a day while unresolved, starting 12 hours after the
--             showtimes last changed.
--   confirm   once a day while unresolved, plus a final one 6 hours before
--             the deadline.
--   pay       2 days after the charge was posted, then every 3 days. After
--             10 days unpaid, one SMS to the payer. Text never includes the
--             amount.
--   event     the day before the showtime, to everyone still coming.
--   rate      once, a day after the night ended, if still unrated.
create function private.plan_notifications()
returns void language plpgsql set search_path = '' as $$
declare
  a record;
  v_title text;
begin
  for a in
    select pa.*, e.rsvp_deadline, e.confirmation_deadline, e.created_at as event_created_at, e.ended_at,
           e.voting_revision, e.schedule_revision,
           coalesce(e.title_override, mv.title) as title
    from private.pending_actions() pa
    join public.events e on e.id = pa.event_id
    join public.movies mv on mv.id = e.movie_id
  loop
    v_title := a.title;
    if a.kind = 'rsvp' then
      if a.rsvp_deadline - now() <= interval '6 hours' then
        perform private.notify(a.member_id, a.event_id, 'rsvp_reminder', 'Last call: ' || v_title,
          'RSVP closes soon. Going, Maybe, or Can''t Go?', jsonb_build_object('event_id', a.event_id),
          'rsvp:' || a.event_id || ':final');
      elsif a.rsvp_deadline - now() <= interval '48 hours' then
        perform private.notify(a.member_id, a.event_id, 'rsvp_reminder', 'RSVP for ' || v_title,
          'The deadline is coming up.', jsonb_build_object('event_id', a.event_id),
          'rsvp:' || a.event_id || ':near');
      elsif now() - a.event_created_at >= interval '24 hours' then
        perform private.notify(a.member_id, a.event_id, 'rsvp_reminder', 'Are you in for ' || v_title || '?',
          'Let Dino know either way.', jsonb_build_object('event_id', a.event_id),
          'rsvp:' || a.event_id || ':gentle');
      end if;

    elsif a.kind = 'vote' then
      if now() - (select max(s.updated_at) from public.showtimes s where s.event_id = a.event_id) >= interval '12 hours' then
        perform private.notify(a.member_id, a.event_id, 'vote_reminder', 'Which showtimes work?',
          'Mark every time you can make for ' || v_title || '.', jsonb_build_object('event_id', a.event_id),
          'vote:' || a.event_id || ':' || a.voting_revision || ':' || to_char(now(), 'YYYY-MM-DD'));
      end if;

    elsif a.kind = 'confirm' then
      if a.confirmation_deadline - now() <= interval '6 hours' then
        perform private.notify(a.member_id, a.event_id, 'confirm_reminder', 'Last call to confirm',
          'Can you make the showtime for ' || v_title || '?', jsonb_build_object('event_id', a.event_id),
          'confirm:' || a.event_id || ':' || a.schedule_revision || ':final');
      else
        perform private.notify(a.member_id, a.event_id, 'confirm_reminder', 'Confirm your spot',
          'Can you make the showtime for ' || v_title || '?', jsonb_build_object('event_id', a.event_id),
          'confirm:' || a.event_id || ':' || a.schedule_revision || ':' || to_char(now(), 'YYYY-MM-DD'));
      end if;

    elsif a.kind = 'rate' then
      if now() - a.ended_at >= interval '24 hours' then
        perform private.notify(a.member_id, a.event_id, 'rating_reminder', 'Rate ' || v_title,
          'Ratings lock 48 hours after the movie.', jsonb_build_object('event_id', a.event_id),
          'rating_reminder:' || a.event_id);
      end if;
    end if;
  end loop;

  -- Payments: per charge, keyed on its own age.
  for a in
    select c.id as charge_id, c.event_id, c.created_at, coalesce(p.member_id, g.host_member_id) as member_id,
           coalesce(e.title_override, mv.title) as title
    from public.charges c
    join public.event_participants p on p.id = c.participant_id
    left join public.guests g on g.id = p.guest_id
    join public.events e on e.id = c.event_id
    join public.movies mv on mv.id = e.movie_id
    where c.status = 'unpaid' and now() - c.created_at >= interval '2 days'
  loop
    perform private.notify(a.member_id, a.event_id, 'payment_reminder', 'Movie night payment',
      'You still owe Dino for ' || a.title || '. Open the app to pay.', jsonb_build_object('event_id', a.event_id),
      'pay:' || a.charge_id || ':' || floor(extract(epoch from now() - a.created_at) / 259200)::integer);
    if now() - a.created_at >= interval '10 days' then
      insert into private.sms_outbox (member_id, event_id, kind, body, dedupe_key)
      select m.id, a.event_id, 'payment_escalation',
             'Opening Night: your share for ' || left(a.title, 60) || ' is still unpaid. Please settle up with Dino.',
             'pay_sms:' || a.charge_id
      from public.members m where m.id = a.member_id and m.status = 'active'
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;

  -- A charge that got paid (or deleted) takes its unsent SMS with it.
  update private.sms_outbox s set status = 'cancelled'
  where s.status = 'queued' and s.kind = 'payment_escalation'
    and not exists (select 1 from public.charges c
                    where 'pay_sms:' || c.id = s.dedupe_key and c.status = 'unpaid');

  -- The day before: everyone still coming.
  for a in
    select e.id as event_id, e.schedule_revision, coalesce(p.member_id, g.host_member_id) as member_id,
           coalesce(e.title_override, mv.title) as title
    from public.events e
    join public.showtimes s on s.id = e.selected_showtime_id
    join public.movies mv on mv.id = e.movie_id
    join public.event_participants p on p.event_id = e.id and p.rsvp_status in ('going', 'maybe')
         and p.confirmation_status is distinct from 'not_attending'
    left join public.guests g on g.id = p.guest_id
    where e.ended_at is null and s.starts_at > now() and s.starts_at - now() <= interval '24 hours'
  loop
    perform private.notify(a.member_id, a.event_id, 'event_reminder', a.title || ' is tomorrow',
      'Check the showtime and theater in the app.', jsonb_build_object('event_id', a.event_id),
      'event_reminder:' || a.event_id || ':' || a.schedule_revision);
  end loop;
end;
$$;

-- Everything time-driven, in one idempotent pass.
create function private.tick()
returns void language plpgsql set search_path = '' as $$
declare e record;
begin
  for e in select ev.id, ev.rsvp_deadline, ev.selected_showtime_id, ev.confirmation_deadline
           from public.events ev where ev.ended_at is null
  loop
    if now() >= e.rsvp_deadline then
      perform private.settle_rsvp(e.id);
    end if;
    perform private.event_changed(e.id);
    if e.selected_showtime_id is not null and now() >= e.confirmation_deadline then
      perform private.settle_confirmations(e.id);
    end if;
  end loop;
  perform private.plan_notifications();
end;
$$;

revoke all on function private.plan_notifications() from public, anon, authenticated, service_role;
revoke all on function private.tick() from public, anon, authenticated, service_role;

create function private.run_tick_impl()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.tick();
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Dispatch (service_role, from the notifications-dispatch Edge Function)
-- ---------------------------------------------------------------------------

-- Hands the dispatcher its work and marks it claimed, so two overlapping
-- runs do not send the same thing (a claim is honoured for 10 minutes).
--   push      queued deliveries: token, text, priority
--   receipts  deliveries Expo accepted at least 15 minutes ago whose receipt
--             has not been checked
--   sms       queued SMS with the member's number, only when asked for (the
--             dispatcher asks only if an SMS provider is configured)
-- This is the one place a push token or phone number leaves the database,
-- and only to service_role.
create function private.dispatch_claim_impl(p_limit integer default 100, p_include_sms boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_push  jsonb;
  v_rcpt  jsonb;
  v_sms   jsonb := '[]'::jsonb;
begin
  with claimed as (
    select d.id from private.notification_deliveries d
    join private.push_devices pd on pd.id = d.push_device_id and pd.disabled_at is null
    where d.status = 'queued' and d.attempt_count < 3
      and (d.claimed_at is null or d.claimed_at < now() - interval '10 minutes')
    order by d.created_at limit v_limit
    for update of d skip locked
  ), marked as (
    update private.notification_deliveries d
    set claimed_at = now(), attempt_count = d.attempt_count + 1
    from claimed where d.id = claimed.id
    returning d.id, d.notification_id, d.push_device_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'delivery_id', m.id, 'token', pd.push_token, 'title', n.title, 'body', n.body,
           'data', n.data || jsonb_build_object('notification_id', n.id, 'kind', n.kind),
           'priority', coalesce(np.priority, 'default'))), '[]'::jsonb)
    into v_push
  from marked m
  join private.push_devices pd on pd.id = m.push_device_id
  join public.notifications n on n.id = m.notification_id
  left join private.notification_policy np on np.kind = n.kind;

  -- Deliveries that kept failing stop being retried.
  update private.notification_deliveries d set status = 'failed', last_error = coalesce(d.last_error, 'gave up')
  where d.status = 'queued' and d.attempt_count >= 3 and d.claimed_at < now() - interval '10 minutes';

  select coalesce(jsonb_agg(jsonb_build_object('delivery_id', x.id, 'ticket_id', x.provider_ticket_id)), '[]'::jsonb)
    into v_rcpt
  from (
    select d.id, d.provider_ticket_id from private.notification_deliveries d
    where d.status = 'sent' and d.provider_ticket_id is not null and d.receipt_checked_at is null
      and d.sent_at < now() - interval '15 minutes'
    order by d.sent_at limit 300
  ) x;

  if p_include_sms then
    with claimed as (
      select s.id from private.sms_outbox s
      where s.status = 'queued' and s.attempt_count < 3
      order by s.created_at limit 20
      for update skip locked
    ), marked as (
      update private.sms_outbox s set attempt_count = s.attempt_count + 1
      from claimed where s.id = claimed.id
      returning s.id, s.member_id, s.body
    )
    select coalesce(jsonb_agg(jsonb_build_object('sms_id', m.id, 'phone', c.phone_e164, 'body', m.body)), '[]'::jsonb)
      into v_sms
    from marked m
    join private.auth_claims c on c.member_id = m.member_id and c.revoked_at is null;
  end if;

  return jsonb_build_object('push', v_push, 'receipts', v_rcpt, 'sms', v_sms);
end;
$$;

-- What happened to the claimed work:
--   push      [{ delivery_id, status: 'sent' | 'failed' | 'dead', ticket_id?, error? }]
--   receipts  [{ delivery_id, status: 'ok' | 'error' | 'dead', error? }]
--   sms       [{ sms_id, status: 'sent' | 'failed', error? }]
-- 'dead' means the provider says the device is gone: its token is switched
-- off and never tried again (registering again from the app re-enables it).
-- A failed push stays queued for another attempt until it has had three.
create function private.dispatch_report_impl(p_results jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results -> 'push', '[]'::jsonb)) loop
    if r ->> 'status' = 'sent' then
      update private.notification_deliveries d
      set status = 'sent', sent_at = now(), provider_ticket_id = r ->> 'ticket_id', last_error = null
      where d.id = (r ->> 'delivery_id')::uuid and d.status = 'queued';
    else
      update private.notification_deliveries d
      set last_error = left(coalesce(r ->> 'error', 'unknown'), 200), claimed_at = null,
          status = case when r ->> 'status' = 'dead' or d.attempt_count >= 3 then 'failed' else d.status end
      where d.id = (r ->> 'delivery_id')::uuid and d.status = 'queued';
    end if;
    if r ->> 'status' = 'dead' then
      update private.push_devices pd set disabled_at = now(), disabled_reason = left(coalesce(r ->> 'error', 'dead'), 200)
      from private.notification_deliveries d
      where d.id = (r ->> 'delivery_id')::uuid and pd.id = d.push_device_id and pd.disabled_at is null;
    end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_results -> 'receipts', '[]'::jsonb)) loop
    update private.notification_deliveries d
    set receipt_checked_at = now(),
        last_error = case when r ->> 'status' = 'ok' then d.last_error else left(coalesce(r ->> 'error', 'unknown'), 200) end
    where d.id = (r ->> 'delivery_id')::uuid;
    if r ->> 'status' = 'dead' then
      update private.push_devices pd set disabled_at = now(), disabled_reason = left(coalesce(r ->> 'error', 'dead'), 200)
      from private.notification_deliveries d
      where d.id = (r ->> 'delivery_id')::uuid and pd.id = d.push_device_id and pd.disabled_at is null;
    end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_results -> 'sms', '[]'::jsonb)) loop
    update private.sms_outbox s
    set status = case when r ->> 'status' = 'sent' then 'sent' when s.attempt_count >= 3 then 'failed' else s.status end,
        sent_at = case when r ->> 'status' = 'sent' then now() end,
        last_error = case when r ->> 'status' = 'sent' then null else left(coalesce(r ->> 'error', 'unknown'), 200) end
    where s.id = (r ->> 'sms_id')::uuid and s.status = 'queued';
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Dino's manual notification
-- ---------------------------------------------------------------------------

-- To everyone active (p_member_ids null) or to the listed members. This is
-- the only way anyone "sends a notification", and it is Dino's alone.
create function private.send_notification_impl(
  p_title text, p_body text default null, p_event_id uuid default null, p_member_ids uuid[] default null
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_count integer;
  v_batch text := gen_random_uuid()::text;
begin
  if p_title is null or btrim(p_title) = '' or char_length(p_title) > 120 or char_length(coalesce(p_body, '')) > 500 then
    raise exception 'A notification needs a short title.' using errcode = '22023';
  end if;
  if p_event_id is not null and not exists (select 1 from public.events e where e.id = p_event_id) then
    raise exception 'That event no longer exists.' using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.members m
  where m.status = 'active' and (p_member_ids is null or m.id = any (p_member_ids));
  perform private.notify(m.id, p_event_id, 'announcement', btrim(p_title), nullif(btrim(p_body), ''),
                         case when p_event_id is null then '{}'::jsonb else jsonb_build_object('event_id', p_event_id) end,
                         'announcement:' || v_batch)
  from public.members m
  where m.status = 'active' and (p_member_ids is null or m.id = any (p_member_ids));
  perform private.write_audit('notification.sent', 'public.notifications', null,
    jsonb_build_object('recipients', v_count, 'event_id', p_event_id));
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Public RPCs and grants
-- ---------------------------------------------------------------------------

create function public.get_pending_actions()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.get_pending_actions_impl() $$;

create function public.register_push_device(p_push_token text, p_platform text)
returns void language sql security invoker set search_path = ''
as $$ select private.register_push_device_impl(p_push_token, p_platform) $$;

create function public.unregister_push_device(p_push_token text)
returns void language sql security invoker set search_path = ''
as $$ select private.unregister_push_device_impl(p_push_token) $$;

create function public.send_notification(p_title text, p_body text default null, p_event_id uuid default null, p_member_ids uuid[] default null)
returns integer language sql security invoker set search_path = ''
as $$ select private.send_notification_impl(p_title, p_body, p_event_id, p_member_ids) $$;

create function public.run_tick()
returns void language sql security invoker set search_path = ''
as $$ select private.run_tick_impl() $$;

create function public.dispatch_claim(p_limit integer default 100, p_include_sms boolean default false)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.dispatch_claim_impl(p_limit, p_include_sms) $$;

create function public.dispatch_report(p_results jsonb)
returns void language sql security invoker set search_path = ''
as $$ select private.dispatch_report_impl(p_results) $$;

select private.grant_rpc('get_pending_actions', 'authenticated');
select private.grant_rpc('register_push_device', 'authenticated');
select private.grant_rpc('unregister_push_device', 'authenticated');
select private.grant_rpc('send_notification', 'authenticated');
select private.grant_rpc('run_tick', 'service_role');
select private.grant_rpc('dispatch_claim', 'service_role');
select private.grant_rpc('dispatch_report', 'service_role');

-- ---------------------------------------------------------------------------
-- 8. Schedule
-- ---------------------------------------------------------------------------

-- Calls the dispatcher Edge Function, if it has been told where it is. The
-- URL and the project secret key are read from Supabase Vault at run time
-- (names: dispatch_function_url, dispatch_secret_key); neither is in this
-- file or in any table the API can read. Until both secrets exist this does
-- nothing, and the inbox still fills: only the push leg waits.
create function private.invoke_dispatcher()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'vault')
     or not exists (select 1 from pg_catalog.pg_namespace where nspname = 'net') then
    return;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = ''dispatch_function_url''' into v_url;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = ''dispatch_secret_key''' into v_key;
  if v_url is null or v_key is null then
    return;
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := ''{}''::jsonb, timeout_milliseconds := 20000)'
    using v_url, jsonb_build_object('content-type', 'application/json', 'apikey', v_key);
end;
$$;

revoke all on function private.invoke_dispatcher() from public, anon, authenticated, service_role;

-- pg_cron and pg_net exist on the hosted project; the test database has
-- neither, and there this block does nothing.
do $$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net with schema extensions;
    perform cron.unschedule(jobid) from cron.job where jobname = 'opening-night-tick';
    perform cron.schedule('opening-night-tick', '*/5 * * * *',
                          'select private.tick(); select private.invoke_dispatcher();');
  end if;
end;
$$;
