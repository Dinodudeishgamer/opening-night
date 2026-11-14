-- The welcome tour's video. Private like every other bucket: any signed-in
-- member can watch it (the app asks for a short-lived link), and only the
-- project owner uploads it, from the dashboard or the CLI.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('welcome', 'welcome', false, 52428800, array['video/mp4'])
on conflict (id) do nothing;

create policy "members watch the welcome video" on storage.objects
  for select to authenticated
  using (bucket_id = 'welcome' and (select private.current_member_id()) is not null);
