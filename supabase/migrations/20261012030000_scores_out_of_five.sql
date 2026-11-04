-- Opening Night v3 — scores are out of 5, to two decimals.
--
-- The app was built scoring 0.0 to 10.0 with one decimal. The club has always
-- scored out of 5, and to the hundredth when someone feels strongly (4.88,
-- 2.91): thirteen nights of records say so. The app follows the club.
--
--   predictions.score, ratings.score   numeric(3,2), 0.00 to 5.00
--   private.valid_score                in range and exact at two decimals
--
-- Nothing is converted: there are no scores stored yet. If there were, this
-- migration stops rather than guess what a 7.5 out of 10 should become.
do $$
begin
  if exists (select 1 from public.predictions where score > 5) or exists (select 1 from public.ratings where score > 5) then
    raise exception 'There are scores above 5 stored. Decide how to convert them before changing the scale.';
  end if;
end $$;

alter table public.predictions drop constraint predictions_score_check;
alter table public.ratings drop constraint ratings_score_check;

alter table public.predictions alter column score type numeric(3, 2);
alter table public.ratings alter column score type numeric(3, 2);

alter table public.predictions add constraint predictions_score_check check (score between 0.00 and 5.00);
alter table public.ratings add constraint ratings_score_check check (score between 0.00 and 5.00);

comment on column public.predictions.score is
  '0.00-5.00. numeric(3,2) rounds on cast: writers must reject raw input that '
  'is not already exact at two decimal places before storing.';
comment on column public.ratings.score is
  '0.00-5.00. numeric(3,2) rounds on cast: writers must reject raw input that '
  'is not already exact at two decimal places before storing.';

-- A score as the user gave it: 0.00 to 5.00 and already exact at two
-- decimals (numeric(3,2) would silently round 4.885 to 4.89, so this runs on
-- the raw value).
--
-- Every function that takes a score calls this first and has its own
-- sentence ready for a bad one, written for the old scale. Rather than
-- re-issue each of those functions to change one sentence, a bad score is
-- refused here, in words that are right; their sentences are never reached.
create or replace function private.valid_score(p_score numeric)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_score is null or p_score < 0 or p_score > 5 or p_score <> round(p_score, 2) then
    raise exception 'A score is 0.00 to 5.00, with at most two decimals.' using errcode = '22023';
  end if;
  return true;
end;
$$;
