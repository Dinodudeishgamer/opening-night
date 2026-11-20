-- Two things for the night itself.
--
-- 1. Every notification about a movie night says which movie. Titles like
--    "Tickets are bought", "How was it?" or one of Dino's own announcements
--    left people asking whether it was about this night or another one. The
--    rule lives here, in the one place every notification is written: if the
--    title does not already name the movie, " · <movie>" is added to it.
--
-- 2. Seats. event_participants.seat_label has been waiting for this since
--    the start. Dino writes where each person sits (set_seat), members can
--    read it, and on showday the app shows who is sitting where.

create or replace function private.notify(
  p_member_id uuid, p_event_id uuid, p_kind text, p_title text, p_body text,
  p_data jsonb default '{}'::jsonb, p_dedupe_key text default null
)
returns void language plpgsql set search_path = '' as $$
declare
  v_title text := p_title;
  v_movie text;
begin
  if p_event_id is not null then
    select coalesce(e.title_override, mv.title) into v_movie
    from public.events e join public.movies mv on mv.id = e.movie_id
    where e.id = p_event_id;
    if v_movie is not null and position(lower(v_movie) in lower(p_title)) = 0 then
      v_title := p_title || ' · ' || v_movie;
    end if;
  end if;

  insert into public.notifications (recipient_member_id, event_id, kind, title, body, data, dedupe_key)
  select m.id, p_event_id, p_kind, v_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key
  from public.members m
  where m.id = p_member_id and m.status = 'active'
  on conflict (recipient_member_id, dedupe_key) do nothing;
end;
$$;

-- Members read seats on the rows they can already see.
grant select (seat_label) on public.event_participants to authenticated;

-- Dino sets (or clears, with null or '') where someone sits. Seats are
-- written the way the ticket says them, tidied: " f 12 " is "F12".
create function private.set_seat_impl(p_participant_id uuid, p_seat text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_part  public.event_participants%rowtype;
  v_event public.events%rowtype;
  v_seat  text := nullif(upper(regexp_replace(coalesce(p_seat, ''), '\s+', '', 'g')), '');
begin
  if v_seat is not null and char_length(v_seat) > 20 then
    raise exception 'A seat is at most 20 characters, like F12.' using errcode = '22023';
  end if;
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  if not found then
    raise exception 'That person is not on this event.' using errcode = 'P0002';
  end if;
  v_event := private.lock_event(v_part.event_id);
  if v_event.selected_showtime_id is null then
    raise exception 'Pick the showtime before adding seats.' using errcode = 'P0001';
  end if;
  if v_event.ended_at is not null then
    raise exception 'This movie night is over.' using errcode = 'P0001';
  end if;
  if v_part.seat_label is not distinct from v_seat then
    return;
  end if;
  update public.event_participants p set seat_label = v_seat where p.id = p_participant_id;
  perform private.write_audit('participant.seat_set', 'public.event_participants', p_participant_id,
    jsonb_build_object('event_id', v_part.event_id, 'from', v_part.seat_label, 'to', v_seat));
end;
$$;

create function public.set_seat(p_participant_id uuid, p_seat text)
returns void language sql security invoker set search_path = ''
as $$ select private.set_seat_impl(p_participant_id, p_seat) $$;

select private.grant_rpc('set_seat', 'authenticated');
