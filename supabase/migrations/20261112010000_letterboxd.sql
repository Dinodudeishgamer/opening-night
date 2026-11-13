-- Opening Night v3 — members can link their Letterboxd.
--
-- A Letterboxd username on the member row, set only by that member, shown on
-- their profile in the club page as a link to letterboxd.com/<username>.
-- Nothing is fetched from Letterboxd: it is a name and a link.
--
-- Letterboxd usernames are letters, digits and underscores. People often
-- paste their profile address instead, so the setter takes either and keeps
-- the username alone. An empty value unlinks.

alter table public.members
  add column letterboxd text,
  add constraint members_letterboxd_check check (letterboxd ~ '^[A-Za-z0-9_]{2,30}$');

create function private.set_my_letterboxd_impl(p_username text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me   uuid := private.require_member();
  v_name text := nullif(btrim(coalesce(p_username, '')), '');
begin
  if v_name is not null then
    -- "https://letterboxd.com/name/films/", "letterboxd.com/name", "@name": all become "name".
    v_name := regexp_replace(v_name, '^(https?://)?(www\.)?(boxd\.it/|letterboxd\.com/)?@?', '', 'i');
    v_name := split_part(v_name, '/', 1);
    if v_name !~ '^[A-Za-z0-9_]{2,30}$' then
      raise exception 'That does not look like a Letterboxd username. It is the name in your profile address, letterboxd.com/yourname.' using errcode = '22023';
    end if;
  end if;
  update public.members m set letterboxd = v_name where m.id = v_me;
  return v_name;
end;
$$;

create function public.set_my_letterboxd(p_username text)
returns text language sql security invoker set search_path = ''
as $$ select private.set_my_letterboxd_impl(p_username) $$;

select private.grant_rpc('set_my_letterboxd', 'authenticated');
