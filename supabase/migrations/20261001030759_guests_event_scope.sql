-- Opening Night v3 — guests belong to exactly one event.
--
-- Deleting an event is deliberate and total, but guests were not
-- event-scoped, so their rows outlived the event they were added for. A guest
-- is now created for one event and goes away with it. The same real-world
-- person coming to another event is simply entered again; there is no guest
-- directory and no reuse across events.
--
-- Scoping a guest to an event also makes the guest row say who was invited
-- to what, so reading guests now follows the RSVP privacy boundary instead of
-- being open to every active member (section 3).
--
-- This migration must run while public.guests is empty: event_id is added
-- NOT NULL with no default and no backfill, so the first statement fails, and
-- the migration with it, if any guest row exists. No data is written here.

-- ---------------------------------------------------------------------------
-- 1. A guest's event
-- ---------------------------------------------------------------------------

alter table public.guests
  add column event_id uuid not null,
  add constraint guests_event_id_fkey
    foreign key (event_id) references public.events (id) on delete cascade,
  -- Target for the composite key below, like showtimes_id_event_key and
  -- event_participants_id_event_key.
  add constraint guests_id_event_key unique (id, event_id);

create index guests_event_id_idx on public.guests (event_id);

-- ---------------------------------------------------------------------------
-- 2. A guest participates only in its own event
-- ---------------------------------------------------------------------------

-- Replaces the single-column key to guests (id). The composite key makes a
-- participant row's guest and event agree, so a guest can never straddle
-- events. With event_participants_event_guest_key, a guest therefore has at
-- most one participation row, in the event it belongs to. Member rows have a
-- null guest_id and are not checked.
--
-- The key still does not cascade: a guest that has a participation row cannot
-- be deleted on its own, and cannot be moved to another event. It is
-- DEFERRABLE INITIALLY DEFERRED for the same reason as
-- showtime_availability_showtime_fkey: deleting the event removes both the
-- guest and its participant row through their own event keys. Which cascade
-- runs first follows internal trigger names, not anything declared here, so
-- the check runs at commit, after both, instead of depending on that order.
-- The cost is that a mismatched guest/event is also reported at commit rather
-- than by the statement that wrote it.
alter table public.event_participants
  drop constraint event_participants_guest_id_fkey,
  add constraint event_participants_guest_fkey
    foreign key (guest_id, event_id) references public.guests (id, event_id)
    deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- 3. Guest visibility follows RSVP privacy
-- ---------------------------------------------------------------------------

-- Whether the guest is on a roster the caller may see: the guest's
-- participation row is going or maybe, and the caller has answered that
-- event's RSVP. This is the same rule as the last branch of "read
-- participants per rsvp privacy". SECURITY DEFINER because the guests policy
-- cannot read event_participants itself: that table's policy reads guests
-- (the host check), so the two policies would recurse into each other. It
-- reports only on rows the caller could already read through
-- event_participants.
create function private.current_member_can_see_roster_guest(p_guest_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.event_participants p
    where p.guest_id = p_guest_id
      and p.rsvp_status in ('going', 'maybe')
      and private.current_member_has_rsvped(p.event_id)
  )
$$;

revoke all on function private.current_member_can_see_roster_guest(uuid) from public, anon, authenticated, service_role;
grant execute on function private.current_member_can_see_roster_guest(uuid) to authenticated;

-- A guest row is visible to:
--   - Dino: every guest.
--   - its host, whatever the guest answered and before any answer exists.
--   - any other active member only while the guest is going or maybe AND the
--     viewer has answered that event's RSVP. cant_go and unanswered guests,
--     and guests with no participation row yet, are never visible to
--     ordinary members.
drop policy "active members read guests" on public.guests;

create policy "read guests per rsvp privacy" on public.guests
  for select to authenticated
  using (
    (select private.current_owner_id()) is not null
    or host_member_id = (select private.current_member_id())
    or private.current_member_can_see_roster_guest(id)
  );

-- Which columns: who the guest is and who brought them. A guest's event is
-- read from its participation row, which carries the same privacy rule;
-- event_id and the change timestamps on guests stay server-side.
revoke select on table public.guests from authenticated;
grant select (id, display_name, host_member_id) on table public.guests to authenticated;
