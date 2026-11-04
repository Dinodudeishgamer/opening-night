-- Opening Night v3 — tickets and payments.
--
-- Dino buys every ticket, then enters what the night cost. That one step
-- (record_ticket_purchase) locks confirmations, turns every unanswered
-- confirmation into Not Attending, and creates one charge per attending
-- participant, guests included: the total split evenly, in whole cents.
--
--   split      floor(total / n) each; the leftover cents go one each to the
--              first participants in a stable order (when they joined the
--              event, then id), so the same inputs always give the same split
--              and the charges always sum to the total
--   overrides  Dino can set any single charge to any amount afterwards
--   Dino's     own ticket is part of the split and is recorded as a paid
--              charge straight away, so the event's charges still add up to
--              what the tickets cost
--   guests     a guest's charge is the guest's own row; the host sees it and
--              is the one reminded
--
-- Only Dino marks a charge paid or unpaid. Who can read what was decided in
-- the core schema: Dino all, a member their own and their guests', nobody a
-- peer's. Charges stay with the event until paid, into Past, and go only
-- when the event is deleted.
--
--   authenticated (Dino)  record_ticket_purchase, update_ticket_cost,
--                         set_charge_amount, set_charge_paid, delete_charge

-- Spreads p_total over the event's existing charges. Paid flags are kept.
create function private.split_charges(p_event_id uuid, p_total integer)
returns void language plpgsql set search_path = '' as $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.charges c where c.event_id = p_event_id;
  if v_count = 0 then
    return;
  end if;
  update public.charges c
  set amount_cents = p_total / v_count + case when o.position <= p_total % v_count then 1 else 0 end
  from (
    select c2.id, row_number() over (order by p.created_at, p.id) as position
    from public.charges c2 join public.event_participants p on p.id = c2.participant_id
    where c2.event_id = p_event_id
  ) o
  where o.id = c.id;
end;
$$;

-- Creates the participant's charge if they have none. Dino's own is paid.
create function private.ensure_charge(p_participant_id uuid, p_amount_cents integer)
returns void language plpgsql set search_path = '' as $$
declare
  v_part  public.event_participants%rowtype;
  v_owner uuid;
begin
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  select m.id into v_owner from public.members m where m.role = 'owner';
  if v_part.member_id is not null and v_part.member_id = v_owner then
    insert into public.charges (event_id, participant_id, amount_cents, status, paid_at, marked_paid_by_member_id)
    values (v_part.event_id, p_participant_id, p_amount_cents, 'paid', now(), v_owner)
    on conflict (participant_id) do nothing;
  else
    insert into public.charges (event_id, participant_id, amount_cents)
    values (v_part.event_id, p_participant_id, p_amount_cents)
    on conflict (participant_id) do nothing;
  end if;
end;
$$;

-- Tells the payer (the member, or a guest's host) that there is something to
-- pay. The amount is deliberately not in the text: it would show on a lock
-- screen. The app shows it once opened.
create function private.notify_payment_posted(p_event_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform private.notify(x.member_id, p_event_id, 'payment_posted', 'Tickets are bought',
                         'Your share is ready. Open the app to pay Dino.',
                         jsonb_build_object('event_id', p_event_id), 'payment_posted:' || p_event_id)
  from (
    select distinct coalesce(p.member_id, g.host_member_id) as member_id
    from public.charges c
    join public.event_participants p on p.id = c.participant_id
    left join public.guests g on g.id = p.guest_id
    where c.event_id = p_event_id and c.status = 'unpaid'
  ) x;
end;
$$;

-- After tickets are bought, someone newly attending (a late add, a walk-in)
-- gets a charge at the going rate: the amount most people on this event were
-- charged. Dino can change it. Someone who drops out after tickets keeps
-- their charge until Dino decides otherwise; that is the conversation.
create or replace function private.participant_attendance_changed(p_participant_id uuid)
returns void language plpgsql set search_path = '' as $$
declare
  v_part  public.event_participants%rowtype;
  v_event public.events%rowtype;
  v_rate  integer;
begin
  select * into v_part from public.event_participants p where p.id = p_participant_id;
  if not found or v_part.confirmation_status is distinct from 'attending' then
    return;
  end if;
  select * into v_event from public.events e where e.id = v_part.event_id;
  if v_event.tickets_purchased_at is null
     or exists (select 1 from public.charges c where c.participant_id = p_participant_id) then
    return;
  end if;
  select mode() within group (order by c.amount_cents) into v_rate
  from public.charges c where c.event_id = v_event.id;
  perform private.ensure_charge(p_participant_id, coalesce(v_rate, 0));
  perform private.notify_payment_posted(v_event.id);
end;
$$;

revoke all on function private.split_charges(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.ensure_charge(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.notify_payment_posted(uuid) from public, anon, authenticated, service_role;
revoke all on function private.participant_attendance_changed(uuid) from public, anon, authenticated, service_role;

create function private.record_ticket_purchase_impl(p_event_id uuid, p_total_cost_cents integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
  v_count integer;
begin
  if v_event.selected_showtime_id is null then
    raise exception 'Select a showtime before buying tickets.' using errcode = 'P0001';
  end if;
  if v_event.tickets_purchased_at is not null then
    raise exception 'Tickets are already recorded. Update the cost instead.' using errcode = 'P0001';
  end if;
  if p_total_cost_cents is null or p_total_cost_cents < 0 or p_total_cost_cents > 100000000 then
    raise exception 'Enter what the tickets cost.' using errcode = '22023';
  end if;

  perform private.settle_confirmations(p_event_id);
  select count(*) into v_count from public.event_participants p
  where p.event_id = p_event_id and p.confirmation_status = 'attending';
  if v_count = 0 then
    raise exception 'Nobody has confirmed, so there is nobody to split the cost with.' using errcode = 'P0001';
  end if;

  update public.events e
  set tickets_purchased_at = now(), total_cost_cents = p_total_cost_cents
  where e.id = p_event_id;
  update public.predictions pr set is_active = false
  where pr.event_id = p_event_id and exists (
    select 1 from public.event_participants p
    where p.id = pr.participant_id and p.confirmation_status = 'not_attending');

  perform private.ensure_charge(p.id, 0)
  from public.event_participants p
  where p.event_id = p_event_id and p.confirmation_status = 'attending';
  perform private.split_charges(p_event_id, p_total_cost_cents);
  perform private.notify_payment_posted(p_event_id);

  perform private.write_audit('tickets.purchased', 'public.events', p_event_id,
    jsonb_build_object('total_cost_cents', p_total_cost_cents, 'participants', v_count));
end;
$$;

-- A corrected total. Re-splits evenly over the charges that exist now, which
-- also replaces any individual overrides; who has paid is kept.
create function private.update_ticket_cost_impl(p_event_id uuid, p_total_cost_cents integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_event public.events%rowtype := private.lock_event(p_event_id);
begin
  if v_event.tickets_purchased_at is null then
    raise exception 'Record the ticket purchase first.' using errcode = 'P0001';
  end if;
  if p_total_cost_cents is null or p_total_cost_cents < 0 or p_total_cost_cents > 100000000 then
    raise exception 'Enter what the tickets cost.' using errcode = '22023';
  end if;
  update public.events e set total_cost_cents = p_total_cost_cents where e.id = p_event_id;
  perform private.split_charges(p_event_id, p_total_cost_cents);
  perform private.write_audit('tickets.cost_updated', 'public.events', p_event_id,
    jsonb_build_object('from', v_event.total_cost_cents, 'to', p_total_cost_cents));
end;
$$;

create function private.set_charge_amount_impl(p_charge_id uuid, p_amount_cents integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := private.require_owner();
  v_old   integer;
begin
  if p_amount_cents is null or p_amount_cents < 0 or p_amount_cents > 100000000 then
    raise exception 'Enter an amount.' using errcode = '22023';
  end if;
  select c.amount_cents into v_old from public.charges c where c.id = p_charge_id for update;
  if not found then
    raise exception 'That charge no longer exists.' using errcode = 'P0002';
  end if;
  update public.charges c set amount_cents = p_amount_cents where c.id = p_charge_id;
  perform private.write_audit('charge.amount_set', 'public.charges', p_charge_id,
    jsonb_build_object('from', v_old, 'to', p_amount_cents));
end;
$$;

create function private.set_charge_paid_impl(p_charge_id uuid, p_paid boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner  uuid := private.require_owner();
  v_charge public.charges%rowtype;
begin
  if p_paid is null then
    raise exception 'Paid or not paid?' using errcode = '22023';
  end if;
  select * into v_charge from public.charges c where c.id = p_charge_id for update;
  if not found then
    raise exception 'That charge no longer exists.' using errcode = 'P0002';
  end if;
  if (v_charge.status = 'paid') = p_paid then
    return;
  end if;
  update public.charges c
  set status = case when p_paid then 'paid' else 'unpaid' end,
      paid_at = case when p_paid then now() end,
      marked_paid_by_member_id = case when p_paid then v_owner end
  where c.id = p_charge_id;
  perform private.write_audit(case when p_paid then 'charge.marked_paid' else 'charge.marked_unpaid' end,
    'public.charges', p_charge_id, jsonb_build_object('event_id', v_charge.event_id, 'amount_cents', v_charge.amount_cents));
end;
$$;

-- For someone who should not be charged after all (a cancellation Dino lets
-- off). The participant row stays.
create function private.delete_charge_impl(p_charge_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_owner  uuid := private.require_owner();
  v_charge public.charges%rowtype;
begin
  delete from public.charges c where c.id = p_charge_id returning * into v_charge;
  if not found then
    raise exception 'That charge no longer exists.' using errcode = 'P0002';
  end if;
  perform private.write_audit('charge.deleted', 'public.charges', p_charge_id,
    jsonb_build_object('event_id', v_charge.event_id, 'participant_id', v_charge.participant_id,
                       'amount_cents', v_charge.amount_cents, 'status', v_charge.status));
end;
$$;

create function public.record_ticket_purchase(p_event_id uuid, p_total_cost_cents integer)
returns void language sql security invoker set search_path = ''
as $$ select private.record_ticket_purchase_impl(p_event_id, p_total_cost_cents) $$;

create function public.update_ticket_cost(p_event_id uuid, p_total_cost_cents integer)
returns void language sql security invoker set search_path = ''
as $$ select private.update_ticket_cost_impl(p_event_id, p_total_cost_cents) $$;

create function public.set_charge_amount(p_charge_id uuid, p_amount_cents integer)
returns void language sql security invoker set search_path = ''
as $$ select private.set_charge_amount_impl(p_charge_id, p_amount_cents) $$;

create function public.set_charge_paid(p_charge_id uuid, p_paid boolean)
returns void language sql security invoker set search_path = ''
as $$ select private.set_charge_paid_impl(p_charge_id, p_paid) $$;

create function public.delete_charge(p_charge_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.delete_charge_impl(p_charge_id) $$;

select private.grant_rpc('record_ticket_purchase', 'authenticated');
select private.grant_rpc('update_ticket_cost', 'authenticated');
select private.grant_rpc('set_charge_amount', 'authenticated');
select private.grant_rpc('set_charge_paid', 'authenticated');
select private.grant_rpc('delete_charge', 'authenticated');
