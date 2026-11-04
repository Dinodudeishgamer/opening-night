-- Opening Night v3 — a guest's rating counts.
--
-- Whoever sat through the movie has an opinion of it, and the group's score
-- is everyone's who was there. Until now only members could have a rating:
-- a guest had a prediction and nothing to set against it, and the night's
-- score left them out.
--
-- A guest's rating works the way their prediction always has: their host
-- enters it (or Dino does), inside the same 48 hours, and it can be changed
-- until then. The table and its read rules already allowed for it (a host
-- reads their guest's rating); what was missing was a way to write one, and
-- being asked to.
--
--   authenticated (member)  submit_guest_rating (own guest; Dino for anyone's)
--   owner_set_rating        now also corrects a guest's rating
--   pending actions         "rate" is asked of the host for each guest

-- ---------------------------------------------------------------------------
-- 1. Entering it
-- ---------------------------------------------------------------------------

create function private.submit_guest_rating_impl(p_participant_id uuid, p_score numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_part  public.event_participants%rowtype;
  v_event public.events%rowtype;
begin
  if not private.valid_score(p_score) then
    raise exception 'A rating is 0.0 to 10.0 with one decimal.' using errcode = '22023';
  end if;
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  if not found or v_part.guest_id is null then
    raise exception 'That is not a guest on this movie night.' using errcode = 'P0002';
  end if;
  v_event := private.lock_event(v_part.event_id);
  if not exists (select 1 from public.guests g where g.id = v_part.guest_id and g.host_member_id = v_me) then
    perform private.require_owner();
  end if;
  if v_part.checked_in_at is null then
    raise exception 'Only people who were checked in can rate.' using errcode = 'P0001';
  end if;
  if v_event.ended_at is not null and now() >= v_event.ended_at + interval '48 hours' then
    raise exception 'Ratings locked 48 hours after the movie.' using errcode = 'P0001';
  end if;
  insert into public.ratings as r (participant_id, event_id, score)
  values (p_participant_id, v_part.event_id, p_score)
  on conflict (participant_id) do update set score = excluded.score, submitted_at = now();
end;
$$;

create function public.submit_guest_rating(p_participant_id uuid, p_score numeric)
returns void language sql security invoker set search_path = ''
as $$ select private.submit_guest_rating_impl(p_participant_id, p_score) $$;

select private.grant_rpc('submit_guest_rating', 'authenticated');

-- Dino's correction, at any time, now for anyone who was checked in.
create or replace function private.owner_set_rating_impl(p_participant_id uuid, p_score numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_part  public.event_participants%rowtype;
  v_old   numeric;
begin
  if not private.valid_score(p_score) then
    raise exception 'A rating is 0.0 to 10.0 with one decimal.' using errcode = '22023';
  end if;
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  if not found or v_part.checked_in_at is null then
    raise exception 'Only someone who was checked in has a rating.' using errcode = 'P0001';
  end if;
  select r.score into v_old from public.ratings r where r.participant_id = p_participant_id;
  insert into public.ratings as r (participant_id, event_id, score)
  values (p_participant_id, v_part.event_id, p_score)
  on conflict (participant_id) do update set score = excluded.score;
  perform private.write_audit('rating.corrected', 'public.ratings', p_participant_id,
    jsonb_build_object('event_id', v_part.event_id, 'from', v_old, 'to', p_score));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Being asked
-- ---------------------------------------------------------------------------

-- The body below is pending_actions from notifications with the last branch
-- widened from members to everyone who was checked in.
create or replace function private.pending_actions()
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
    -- Rate: everyone who was checked in, inside the 48 hours, no rating yet.
    -- A guest's rating is their host's to enter.
    select e.id, coalesce(p.member_id, g.host_member_id), p.id, 'rate', e.ended_at + interval '48 hours'
    from public.events e
    join public.event_participants p on p.event_id = e.id and p.checked_in_at is not null
    left join public.guests g on g.id = p.guest_id
    where e.ended_at is not null and now() < e.ended_at + interval '48 hours'
      and not exists (select 1 from public.ratings r where r.participant_id = p.id)
  ) x
  join public.members m on m.id = x.actor_id and m.status = 'active'
$$;
