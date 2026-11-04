# Operations

The hosted project is **Opening Night** (`vabgqjbgkhovgzylhezp`). It is the only deployment target. The old project is never touched by anything in this repository.

## First-time setup

These are the things only Dino can do, in order.

### 1. Nothing to buy

Sign-in uses the invite code alone, so there is no SMS provider to set up and nothing to pay for.

> Auth is configured from `supabase/config.toml` (anonymous sign-ins on, phone sign-ups off, the Before User Created hook on). If you ever change Auth settings in the dashboard, put the same change in `config.toml`, or the next `npx supabase config push` will undo it.

### 2. Bootstrap yourself

```bash
node scripts/owner-bootstrap.mjs --first Dino --last-initial W
```

Deploys a temporary function, creates your owner row, prints your invite code, and deletes the function again. The code lasts 7 days. Open the app, enter the code, and tap Sign in. If the code is lost or expires first, run the command again.

Once you have signed in, the database revokes the function behind this for good.

### 3. Movie search

The TMDB key that the old app shipped is in old git history, so it is not reused. Get a new one at themoviedb.org (free), then:

```bash
npx supabase secrets set TMDB_API_KEY=<your new key>
```

Either a v3 API key or a v4 read access token works. Until this is set, creating a movie night says movie search is not set up. Revoke the old key in your TMDB account.

### 4. Where members pay you

Your Venmo username, your Apple Cash number, and the short note shown under the pay buttons live in one row of `public.app_settings`. They are set, and there is no screen for them: they rarely change, and a form for it was clutter on Manage. They are deliberately not in the code either, so the phone number is not in git and changing them needs no new build. To change them, in the Supabase SQL editor:

```sql
update public.app_settings
set venmo_username = 'Your-Venmo',            -- no @
    apple_cash_recipient = '+15555550123',    -- with country code
    payment_note = 'Cash at the movie works too.'
where id;
```

### 5. A build

```bash
eas build --profile development --platform ios     # and/or android
```

Push notifications also need the usual Expo credentials for the EAS project (APNs key for iOS, FCM for Android); `eas credentials` walks through it.

### 6. Updating the app without a new build

The app takes over-the-air updates (`expo-updates`). After a change that touches only the JavaScript side (screens, wording, fixes):

```bash
eas update --channel production --message "what changed"
```

Phones pick it up the next time the app is opened, and show it on the open after that. `--channel preview` and `--channel development` reach those builds instead.

An update only reaches builds with the same app version (`runtimeVersion` follows `version` in `app.json`). So when the native side changes (a package with native code is added or upgraded, or `app.json` plugins change): raise `version`, make a new build, and send that through TestFlight. Never send an update that needs native code the installed build does not have.

### 7. The welcome video

`src/constants/intro.ts` holds the address of the video in the welcome tour. While it is `null` the tour shows a "coming soon" card. Upload the video somewhere it can be streamed from, set the address, and send an update.

## What is already deployed

| | State |
| --- | --- |
| Migrations | all of `supabase/migrations/` |
| Edge Functions | `invite-preview`, `invite-claim-begin`, `owner-members`, `tmdb`, `notifications-dispatch` |
| Edge secrets | `INVITE_CODE_HMAC_SECRET` (do not rotate: it would invalidate every outstanding invite) |
| Auth | anonymous sign-in on (gated by the hook), phone sign-ups off, email off, Before User Created hook on |
| Schedule | `pg_cron` job `opening-night-tick`, every 5 minutes |
| Vault | `dispatch_function_url`, `dispatch_secret_key` (how the schedule calls the dispatcher) |
| Storage | private buckets `avatars`, `event-photos` |

## Deploying changes

```bash
npm test && npm run lint && npm run typecheck

npx supabase db push                                   # migrations
npx supabase functions deploy <name> --use-api         # one function, by name
```

Deploy functions by name. `owner-bootstrap` lives in the same folder and must not be deployed by hand; a bare `supabase functions deploy` would deploy it. (It is harmless without the secret key and inert after your first sign-in, but it should not be left running.)

After rotating the project's secret key:

```bash
npm run setup:dispatch      # stores the new key in Vault for the scheduled job
```

## Checking the hosted database

```bash
npx supabase db query --linked -f supabase/tests/hosted-rollback-check.sql
```

Runs a complete movie night (members, RSVP, voting, selection, tickets, check-in, a photo, ratings, delete) as real roles on the real database, inside a block that always ends by raising, so everything is rolled back. Success is the error `HOSTED_CHECK_OK ...`. Nothing is kept, and no SMS or push is sent.

```bash
npx supabase db advisors --linked     # Supabase's own security and performance checks
```

Every finding should be a warning, and each of these is expected:

- "Multiple permissive policies" on `event_participants`, `predictions`, and `ratings`. Deliberate: the second policy on each is the reveal rule.
- "Anonymous sign-ins allowed", once per table policy. Deliberate: sign-in is an anonymous Auth user created from an invite code. Every policy checks for a live member claim, not merely for being signed in, and the Before User Created hook refuses an anonymous sign-in that did not come from a valid code.
- "Leaked password protection" and "MFA options". Not applicable: nobody has a password.

Anything at error level, or a warning not on this list, is worth reading.

## When something goes wrong

**A member has a new phone, reinstalled the app, or signed out.** Manage → the member → Create invite code, and send it to them. Using it signs them in on the new phone and signs the old one out. Their history is untouched.

**A member's phone was lost or stolen.** Manage → the member → Sign them out everywhere. Then Create invite code when they are ready.

**You are moving to a new phone yourself.** While you are still signed in on the old one: Manage → yourself → Create invite code, then enter it on the new phone.

**You lost your own phone, or signed out without a code.** The app cannot reset the owner, on purpose: a slip there would lock the group out of its organizer. Recovery is a deliberate step in the Supabase SQL editor, which only you can reach:

```sql
-- 1. End your current login.
update private.auth_claims set revoked_at = now()
where revoked_at is null and member_id = (select id from public.members where role = 'owner');

-- 2. Reopen the one-time owner invite function.
grant execute on function public.bootstrap_owner_invite(text, text, text) to service_role;
grant execute on function private.bootstrap_owner_invite_impl(text, text, text) to service_role;
```

Then run `node scripts/owner-bootstrap.mjs --first Dino --last-initial W` and sign in with the code. Your member row, role, and history are unchanged, and your name is not altered. The moment you sign in, the database revokes the function again by itself.

Both steps are needed: the function refuses while the owner still holds a login, and nothing can call it without the grant.

**Pushes are not arriving.** Inbox entries are written regardless, so check whether the notification is in the member's Inbox. If it is, look at the dispatcher:

```sql
select status, count(*) from private.notification_deliveries group by 1;
select status_code, left(content, 120) from net._http_response order by created desc limit 5;
select * from cron.job_run_details order by start_time desc limit 5;
```

**What happened, and who did it.** Every organizer action and override writes to `private.audit_log`:

```sql
select occurred_at, action, target_id, details from private.audit_log order by occurred_at desc limit 50;
```

## Things never to do

- Put a secret in an `EXPO_PUBLIC_*` variable, the root `.env`, or git.
- Deploy to, or change anything in, the old Supabase project.
- Rotate `INVITE_CODE_HMAC_SECRET` while invites are outstanding.
- Add a `SECURITY DEFINER` function to the `public` schema (the test suite will fail if you do).
