-- Two fixes after the first full movie night.
--
-- 1. Ratings open when Dino ends the night. Until now anyone checked in could
--    rate from the moment they were checked in, before the movie had even
--    started. (Ratings already given are kept.)
--
-- 2. Dino's Cinemark rewards card. Everyone buys with his member QR so the
--    points pool on one account; the app shows it on its own screen. The
--    picture itself is set in the table by hand (see docs/operations.md),
--    never in this repository, which is public. Members can read it; nobody
--    else can.

create or replace function private.submit_rating_impl(p_event_id uuid, p_score numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me    uuid := private.require_member();
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_part  uuid;
begin
  if not private.valid_score(p_score) then
    raise exception 'A rating is 0.0 to 10.0 with one decimal.' using errcode = '22023';
  end if;
  select p.id into v_part from public.event_participants p
  where p.event_id = p_event_id and p.member_id = v_me and p.checked_in_at is not null;
  if v_part is null then
    raise exception 'Only people who were checked in can rate.' using errcode = 'P0001';
  end if;
  if v_event.ended_at is null then
    raise exception 'Rating opens when Dino ends the night.' using errcode = 'P0001';
  end if;
  if now() >= v_event.ended_at + interval '48 hours' then
    raise exception 'Ratings locked 48 hours after the movie.' using errcode = 'P0001';
  end if;
  insert into public.ratings as r (participant_id, event_id, score)
  values (v_part, p_event_id, p_score)
  on conflict (participant_id) do update set score = excluded.score, submitted_at = now();
end;
$$;

create or replace function private.submit_guest_rating_impl(p_participant_id uuid, p_score numeric)
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
  if v_event.ended_at is null then
    raise exception 'Rating opens when Dino ends the night.' using errcode = 'P0001';
  end if;
  if now() >= v_event.ended_at + interval '48 hours' then
    raise exception 'Ratings locked 48 hours after the movie.' using errcode = 'P0001';
  end if;
  insert into public.ratings as r (participant_id, event_id, score)
  values (p_participant_id, v_part.event_id, p_score)
  on conflict (participant_id) do update set score = excluded.score, submitted_at = now();
end;
$$;

alter table public.app_settings
  add column rewards_label text,
  add column rewards_qr text,
  add constraint app_settings_rewards_label_check
    check (rewards_label is null or char_length(btrim(rewards_label)) between 1 and 60),
  add constraint app_settings_rewards_qr_check
    check (rewards_qr is null or (rewards_qr ~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$' and char_length(rewards_qr) <= 200000));

grant select (rewards_label, rewards_qr) on public.app_settings to authenticated;
