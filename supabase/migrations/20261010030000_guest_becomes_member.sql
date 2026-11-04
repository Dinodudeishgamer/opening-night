-- Opening Night v3 — a guest can become a member, and two unused RPCs go.
--
-- 1. Guest to member
--
-- A guest is a name on one movie night, brought by a member who answers for
-- them. When that person joins the club, Dino can now say so. There was a
-- function for it (link_guest_to_member) that only wrote a note on the guest
-- row which nothing read; it is replaced by one that does the real thing:
--
--   promote_guest(guest, member)   the guest's place on that night becomes
--                                  the member's own. The same row, so
--                                  everything recorded on it carries over
--                                  untouched: their RSVP, the showtimes they
--                                  could make, their confirmation, check-in,
--                                  prediction, and ticket charge.
--
-- After it, that night is part of the member's history like any other: they
-- appear on it under their own name and picture, it counts in their totals,
-- and a ticket still unpaid is theirs to settle (reminders go to them, not
-- to the member who brought them). The guest row is deleted; it has nothing
-- left to say.
--
-- Someone who came as a guest three times is three guest rows, one per
-- night, and is promoted once on each. Nothing is ever matched by name.
--
-- Refused when the member already has a place of their own on that night:
-- one person cannot be on a night twice, and which row to keep is a decision
-- for Dino (remove the guest, or the member's own RSVP, first).
--
-- 2. Unused RPCs
--
-- run_tick (a manual "run the reminders now"; the schedule calls
-- private.tick() directly) and save_app_settings (the payment details are
-- set in the table itself now; see docs/operations.md) had no caller.

-- ---------------------------------------------------------------------------
-- 1. Guest to member
-- ---------------------------------------------------------------------------

drop function public.link_guest_to_member(uuid, uuid);
drop function private.link_guest_to_member_impl(uuid, uuid);
alter table public.guests drop column linked_member_id;

create function private.promote_guest_impl(p_guest_id uuid, p_member_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner       uuid := private.require_owner();
  v_guest       public.guests%rowtype;
  v_participant uuid;
begin
  select g.* into v_guest from public.guests g where g.id = p_guest_id for update;
  if not found then
    raise exception 'That guest no longer exists.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.members m where m.id = p_member_id and m.status = 'active') then
    raise exception 'Pick an active member.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.event_participants p where p.event_id = v_guest.event_id and p.member_id = p_member_id) then
    raise exception 'They already have their own place on that movie night. Remove one of the two first.' using errcode = 'P0001';
  end if;

  update public.event_participants p
  set member_id = p_member_id, guest_id = null
  where p.guest_id = p_guest_id
  returning p.id into v_participant;

  delete from public.guests g where g.id = p_guest_id;

  perform private.write_audit('guest.promoted', 'public.members', p_member_id,
    jsonb_build_object('guest_id', p_guest_id, 'guest_name', v_guest.display_name, 'host_member_id', v_guest.host_member_id,
                       'event_id', v_guest.event_id, 'participant_id', v_participant));
  return v_participant;
end;
$$;

create function public.promote_guest(p_guest_id uuid, p_member_id uuid)
returns uuid language sql security invoker set search_path = ''
as $$ select private.promote_guest_impl(p_guest_id, p_member_id) $$;

select private.grant_rpc('promote_guest', 'authenticated');

-- ---------------------------------------------------------------------------
-- 2. Unused RPCs
-- ---------------------------------------------------------------------------

drop function public.run_tick();
drop function private.run_tick_impl();

drop function public.save_app_settings(text, text, text);
drop function private.save_app_settings_impl(text, text, text);
