-- Opening Night v3 — a notification pops up when it is sent, not up to five
-- minutes later.
--
-- Pushes were only ever sent by the scheduled job: every five minutes it ran
-- the tick and then called the dispatcher. So an announcement, a new movie
-- night, or "showtime picked" sat in the queue until the next run. Dino's
-- first announcement was sent, looked at, and removed inside that gap, and
-- no phone ever buzzed.
--
-- Now, whenever deliveries are queued, the dispatcher is called as soon as
-- that transaction commits (pg_net sends on commit). The scheduled call
-- stays: it is still what sends the tick's own reminders reliably, retries
-- what failed, and collects receipts.
--
-- Once per transaction is enough however many notifications it wrote, so a
-- transaction-local flag remembers that the call has been made. And a push
-- is never allowed to fail the thing that caused it: any error here is
-- swallowed, and the scheduled job picks the delivery up instead.
create function private.dispatch_soon()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('opening_night.dispatch_requested', true) = '1' then
    return null;
  end if;
  perform set_config('opening_night.dispatch_requested', '1', true);
  begin
    perform private.invoke_dispatcher();
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke all on function private.dispatch_soon() from public, anon, authenticated, service_role;

create trigger dispatch_soon after insert on private.notification_deliveries
  for each statement execute function private.dispatch_soon();
