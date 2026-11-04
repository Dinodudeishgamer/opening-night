-- Opening Night v3 — remove what only text messages needed.
--
-- Sign-in stopped using phone numbers and SMS in code_only_sign_in. That
-- left a set of things with nothing behind them: nobody has a number on
-- file, there is no SMS provider, and there is not going to be one. They are
-- removed here rather than left to be wondered about:
--
--   private.sms_outbox       the queue for the one text the app could send,
--                            a nudge after a ticket had gone unpaid 10 days
--   the planner              no longer queues that text. Payment reminders
--                            by push and Inbox are unchanged.
--   dispatch_claim/report    no longer hand out or settle SMS work
--   phone_e164               on member_invites and auth_claims, with the
--                            checks and unique indexes that went with it
--   rate-limit scopes        otp_request and otp_verify
--
-- Nothing a member can see or do changes.

-- ---------------------------------------------------------------------------
-- 1. The planner
-- ---------------------------------------------------------------------------

-- The body below is the planner from confirm_reminder_grace with the two SMS
-- statements taken out; everything else is as it was.
create or replace function private.plan_notifications()
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
      elsif not exists (
        select 1 from public.notifications n
        where n.recipient_member_id = a.member_id and n.event_id = a.event_id
          and n.kind in ('showtime_selected', 'event_rescheduled')
          and n.created_at > now() - interval '12 hours'
      ) then
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
  end loop;

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

-- ---------------------------------------------------------------------------
-- 2. Dispatch
-- ---------------------------------------------------------------------------

-- The claim loses its p_include_sms argument, so it is dropped and made again
-- rather than replaced. What is left is as it was.
drop function public.dispatch_claim(integer, boolean);
drop function private.dispatch_claim_impl(integer, boolean);

create function private.dispatch_claim_impl(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_push  jsonb;
  v_rcpt  jsonb;
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

  return jsonb_build_object('push', v_push, 'receipts', v_rcpt);
end;
$$;

create function public.dispatch_claim(p_limit integer default 100)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.dispatch_claim_impl(p_limit) $$;

select private.grant_rpc('dispatch_claim', 'service_role');

create or replace function private.dispatch_report_impl(p_results jsonb)
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
end;
$$;

drop table private.sms_outbox;

-- ---------------------------------------------------------------------------
-- 3. Phone numbers
-- ---------------------------------------------------------------------------

-- The guard on a claim's history, without the phone it used to watch.
create or replace function private.auth_claims_guard_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.auth_user_id is distinct from old.auth_user_id
     or new.member_id is distinct from old.member_id
     or new.claimed_at is distinct from old.claimed_at then
    raise exception 'auth_claims id, auth_user_id, member_id, and claimed_at are immutable; link a new claim instead'
      using errcode = 'check_violation';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at
          or (new.invite_id is distinct from old.invite_id and new.invite_id is not null)
          or (new.revoked_by_member_id is distinct from old.revoked_by_member_id
              and new.revoked_by_member_id is not null)) then
    raise exception 'revoked auth_claims are frozen'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop index private.auth_claims_one_active_per_phone;
alter table private.auth_claims
  drop constraint auth_claims_phone_check,
  drop column phone_e164;

drop index private.member_invites_one_open_per_phone;
alter table private.member_invites
  drop constraint member_invites_phone_check,
  drop column phone_e164;

-- ---------------------------------------------------------------------------
-- 4. Rate limits
-- ---------------------------------------------------------------------------

-- Only invite codes are throttled now. Old otp rows, if any, go first so the
-- narrower check holds.
delete from private.rate_limits where scope <> 'invite_redeem';
alter table private.rate_limits
  drop constraint rate_limits_scope_check,
  add constraint rate_limits_scope_check check (scope = 'invite_redeem');

create or replace function private.rate_limit_consume(p_scope text, p_subject_hash text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_max     integer;
  v_window  interval;
  v_lockout interval;
  v_start   timestamptz;
  v_count   integer;
begin
  case p_scope
    when 'invite_redeem' then v_max := 10; v_window := interval '15 minutes'; v_lockout := interval '1 hour';
    else raise exception 'unknown rate-limit scope: %', p_scope using errcode = '22023';
  end case;
  if p_subject_hash is null or p_subject_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'rate-limit subject must be a 64-character hex hash' using errcode = '22023';
  end if;

  -- Housekeeping for this subject only: windows and lockouts long past.
  delete from private.rate_limits r
  where r.scope = p_scope
    and r.subject_hash = p_subject_hash
    and r.window_started_at < now() - interval '1 day'
    and (r.locked_until is null or r.locked_until < now());

  if exists (
    select 1 from private.rate_limits r
    where r.scope = p_scope and r.subject_hash = p_subject_hash and r.locked_until > now()
  ) then
    return false;
  end if;

  v_start := date_bin(v_window, now(), timestamptz '2000-01-01 00:00:00+00');
  insert into private.rate_limits as r (scope, subject_hash, window_started_at, attempt_count)
  values (p_scope, p_subject_hash, v_start, 1)
  on conflict (scope, subject_hash, window_started_at)
    do update set attempt_count = r.attempt_count + 1
  returning r.attempt_count into v_count;

  if v_count > v_max then
    update private.rate_limits r
    set locked_until = now() + v_lockout
    where r.scope = p_scope and r.subject_hash = p_subject_hash and r.window_started_at = v_start;
    return false;
  end if;
  return true;
end;
$$;
