-- A full movie night, run against the REAL hosted database and then thrown
-- away. Everything happens inside one DO block that always ends by raising,
-- so Postgres rolls back every row, grant, and file entry it touched: no
-- members, Auth users, events, or notifications are left behind, and no
-- push is sent (nothing is committed for the dispatcher to see).
--
--   npx supabase db query --linked -f supabase/tests/hosted-rollback-check.sql
--
-- Success is the error "HOSTED_CHECK_OK ..."; anything else is a failure and
-- says which step. The phone numbers are from the 555-01xx range reserved
-- for fiction. This complements the PGlite suites: it proves the same
-- functions behave on the real platform (real auth schema, real storage
-- tables, real roles).
do $check$
declare
  v_owner_uid uuid := gen_random_uuid();
  v_alice_uid uuid := gen_random_uuid();
  v_owner uuid;
  v_alice uuid;
  v_event uuid;
  v_theater uuid;
  v_early uuid;
  v_late uuid;
  v_p_owner uuid;
  v_p_alice uuid;
  v_p_guest uuid;
  v_guest uuid;
  v_media uuid;
  v_path text;
  v_json jsonb;
  v_count integer;
  v_total integer;
  v_refused boolean;
begin
  if exists (select 1 from public.members) and current_setting('opening_night.allow_with_members', true) is distinct from 'yes' then
    -- Harmless either way (it all rolls back), but say so plainly.
    raise notice 'members exist; the check still runs and still rolls back';
  end if;

  -- Two people, written the way no API caller can.
  insert into auth.users (id, aud, role, phone, phone_confirmed_at)
  values (v_owner_uid, 'authenticated', 'authenticated', '14155550191', now()),
         (v_alice_uid, 'authenticated', 'authenticated', '14155550192', now());
  if exists (select 1 from public.members where role = 'owner') then
    select id into v_owner from public.members where role = 'owner';
    update private.auth_claims set revoked_at = now() where member_id = v_owner and revoked_at is null;
  else
    insert into public.members (first_name, last_initial, role) values ('Check', 'O', 'owner') returning id into v_owner;
  end if;
  insert into public.members (first_name, last_initial) values ('Check', 'A') returning id into v_alice;
  insert into private.auth_claims (auth_user_id, member_id)
  values (v_owner_uid, v_owner), (v_alice_uid, v_alice);

  -- Dino builds the night.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  if (public.whoami() ->> 'role') is distinct from 'owner' then raise exception 'step whoami(owner)'; end if;
  v_event := public.create_event(
    '{"tmdb_id": 999999001, "title": "Hosted Check", "poster_path": "/check.jpg"}'::jsonb, now() + interval '3 days');
  v_theater := public.save_theater(null, 'Check Theater', '1 Main St');
  v_early := public.add_showtime(v_event, v_theater, now() + interval '10 days', 'imax');
  v_late := public.add_showtime(v_event, v_theater, now() + interval '11 days', 'standard');
  perform public.set_rsvp(v_event, 'going');

  -- Alice: RSVP, a guest, votes.
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice_uid, 'role', 'authenticated')::text, true);
  if (public.whoami() ->> 'role') is distinct from 'member' then raise exception 'step whoami(member)'; end if;
  perform public.set_rsvp(v_event, 'going');
  v_guest := public.add_guest(v_event, 'Check Guest');
  select id into v_p_alice from public.event_participants where event_id = v_event and member_id = v_alice;
  select id into v_p_guest from public.event_participants where event_id = v_event and guest_id = v_guest;
  perform public.submit_ballot(v_p_alice, array[v_early, v_late]);
  perform public.submit_ballot(v_p_guest, array[v_early]);
  v_json := public.get_voting(v_event);
  if (v_json ->> 'voted')::int <> 2 or v_json -> 'matrix' <> 'null'::jsonb then raise exception 'step get_voting(member): %', v_json; end if;

  -- A member is refused the organizer's actions, by RPC and by table.
  v_refused := false;
  begin
    perform public.select_showtime(v_event, v_early, now() + interval '8 days');
  -- He said Going and ticked that showtime, so picking it confirmed him.
  if (select confirmation_status from public.event_participants where id = v_p_owner) is distinct from 'attending' then
    raise exception 'step select_showtime did not confirm the organizer from his ballot';
  end if;
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'step member select_showtime was not refused'; end if;
  v_refused := false;
  begin
    update public.events set owner_note = 'x' where id = v_event;
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'step member table write was not refused'; end if;
  v_refused := false;
  begin
    perform 1 from public.showtime_availability;
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'step raw availability was readable'; end if;

  -- Dino votes, selects; both confirm; tickets.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_uid, 'role', 'authenticated')::text, true);
  select id into v_p_owner from public.event_participants where event_id = v_event and member_id = v_owner;
  perform public.submit_ballot(v_p_owner, array[v_early]);
  if jsonb_array_length(public.get_voting(v_event) -> 'matrix') <> 3 then raise exception 'step get_voting(owner)'; end if;
  perform public.select_showtime(v_event, v_early, now() + interval '8 days');
  perform public.set_confirmation(v_p_owner, 'attending');
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice_uid, 'role', 'authenticated')::text, true);
  perform public.set_confirmation(v_p_alice, 'attending');
  perform public.set_confirmation(v_p_guest, 'attending');
  perform public.submit_prediction(v_p_alice, 4.25);
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_uid, 'role', 'authenticated')::text, true);
  perform public.record_ticket_purchase(v_event, 5000);
  select count(*), sum(amount_cents) into v_count, v_total from public.charges where event_id = v_event;
  if v_count <> 3 or v_total <> 5000 then raise exception 'step ticket split: % charges totalling %', v_count, v_total; end if;

  -- Alice sees her own and her guest's charge, not Dino's.
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice_uid, 'role', 'authenticated')::text, true);
  if (select count(*) from public.charges where event_id = v_event) <> 2 then raise exception 'step charge visibility'; end if;
  if (select count(*) from public.predictions where event_id = v_event) <> 1 then raise exception 'step prediction blinding'; end if;
  if jsonb_array_length(public.get_pending_actions()) < 2 then raise exception 'step pending actions'; end if;

  -- Check-in, a photo in the real storage tables, the end, a rating.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_uid, 'role', 'authenticated')::text, true);
  if not (select bool_or((r ->> 'has_prediction')::boolean) from jsonb_array_elements(public.owner_roster(v_event)) r) then
    raise exception 'step owner_roster';
  end if;
  perform public.check_in(v_p_alice);
  perform public.check_in(v_p_owner, 3.0);
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice_uid, 'role', 'authenticated')::text, true);
  v_path := v_event || '/' || v_alice || '/check1.jpg';
  insert into storage.objects (bucket_id, name) values ('event-photos', v_path);
  v_refused := false;
  begin
    insert into storage.objects (bucket_id, name) values ('event-photos', v_event || '/' || v_owner || '/check2.jpg');
  exception when insufficient_privilege then v_refused := true;
  end;
  if not v_refused then raise exception 'step storage: wrote into another member''s folder'; end if;
  v_media := public.register_event_photo(v_event, v_path, 2048, 1536, 400000);
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_uid, 'role', 'authenticated')::text, true);
  perform public.end_event(v_event);
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice_uid, 'role', 'authenticated')::text, true);
  perform public.submit_rating(v_event, 4.88);
  if (select count(*) from public.predictions where event_id = v_event) <> 2 then raise exception 'step predictions revealed after the end'; end if;

  -- The server-side pieces: the tick as the schedule runs it, then what the dispatcher would be handed.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  perform private.tick();
  perform set_config('role', 'service_role', true);
  v_json := public.dispatch_claim(10);
  if jsonb_typeof(v_json -> 'push') <> 'array' then raise exception 'step dispatch_claim'; end if;

  -- Delete Event takes everything with it.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_uid, 'role', 'authenticated')::text, true);
  perform public.delete_event(v_event);
  perform set_config('role', 'postgres', true);
  set constraints all immediate;
  if exists (select 1 from public.event_participants where event_id = v_event)
     or exists (select 1 from public.charges where event_id = v_event)
     or exists (select 1 from public.guests where id = v_guest) then
    raise exception 'step delete cascade';
  end if;

  raise exception 'HOSTED_CHECK_OK: % charges totalling % cents (rolled back, nothing kept)', v_count, v_total;
end;
$check$;
