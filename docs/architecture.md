# Architecture

## Identity

| Thing | Where | What it is |
| --- | --- | --- |
| Member | `public.members` | The application identity. Everything (RSVPs, charges, scores, photos) is keyed on `members.id`. |
| Auth user | `auth.users` | One phone's session: an anonymous Supabase Auth user, created when an invite code is entered. Never used as an application identity. |
| Claim | `private.auth_claims` | The only bridge: "this Auth user is this member". Revoking it cuts access on the member's very next request, whatever token they hold. |

Dino is the one owner. A member's role never changes (a trigger enforces it even for the table owner), there is no promotion path, and there is no "first user becomes admin".

Members cannot edit their name; they choose their own avatar. Removing a member revokes their claim and keeps their row, so history keeps its author.

## Sign-in

The invite code is the whole credential. There is no phone number, no text message, and nothing that costs money.

```
invite code ──► invite-preview        "Welcome, Alice A."
"Sign in"   ──► invite-claim-begin    returns a one-time claim ticket; its hash goes on the invite
                signInAnonymously     Before User Created hook: allowed only because the
                                      sign-in carries a ticket that is on a valid invite
                complete_invite_claim links the Auth user to the member, closes the invite
```

- Invite codes are generated server-side (16 characters, 80 bits), shown to Dino once, and stored only as `HMAC-SHA-256(INVITE_CODE_HMAC_SECRET, normalized code)`. The database never sees a plaintext code. The contract is documented at the top of `supabase/functions/_shared/invite-gateway.ts`.
- The claim ticket is 32 random bytes, valid for 10 minutes and once, stored only as its SHA-256. It is what ties the anonymous sign-in to the invite without the database seeing the code.
- The session lives on the phone the code was entered on. There is no signing back in: a new phone, a reinstall, or signing out needs a new code from Dino.
- A code replaces the member's current login. Using a new code on a new phone signs the old phone out. Codes come only from Dino, work once, and expire; that is the protection.
- Dino can also sign a member out everywhere without issuing a code (Manage → the member).
- Dino himself gets in the same way. His owner row and first invite come from a one-time bootstrap (`npm run owner:bootstrap`) whose database function revokes itself the moment he first signs in. To move phones he makes himself a code in Manage first.

## Two layers of functions

`public` is the only schema exposed through the Data API, and it contains no `SECURITY DEFINER` function.

```
public.set_rsvp(...)          SECURITY INVOKER, one line: calls its implementation
private.set_rsvp_impl(...)    SECURITY DEFINER, search_path = '', does its own authorization
```

The implementation is the privilege boundary. It never trusts that it was reached through the wrapper, and it never takes the caller's identity as a parameter: it reads `auth.uid()` and resolves the member itself.

`supabase/tests/security.test.ts` checks the structure after every migration: no definer in `public`, every definer pins `search_path`, `anon` can execute nothing, every table has RLS, members have no direct write on any table (except marking their own notifications read), wrapper and implementation grants match.

## One event, independent milestones

There is no phase column. An event has independent timestamps, and its stage is derived from them (`src/lib/stage.ts` in the app, the same conditions in SQL):

| Milestone | Set by |
| --- | --- |
| `rsvp_deadline` | Dino at creation; pulled in to "now" when a showtime is selected |
| `voting_closed_at` | Dino, or automatically once RSVP is locked and every eligible participant has a current ballot |
| `selected_showtime_id`, `confirmation_deadline`, `schedule_revision` | `select_showtime` / `reschedule_event`. Selecting also confirms, on the spot, everyone who RSVPed Going and ticked that showtime on their current ballot: they have already answered. Maybe, non-voters, and everyone after a reschedule are asked |
| `tickets_purchased_at`, `total_cost_cents` | `record_ticket_purchase` |
| `ended_at` | `end_event`. The night moves to the Past tab at once. Ratings lock, and everything about the night opens to every member, at `ended_at + 48 hours`: derived, nothing has to run |

Every per-person fact hangs off one `event_participants` row, for members and guests alike, so a guest gets the same independent RSVP, availability, confirmation, prediction, and charge as a member without a parallel workflow.

### Revisions

- `events.voting_revision` goes up when a showtime is added or edited. A ballot is current only if it was submitted under the current revision, so everyone re-reviews. Removing a showtime invalidates only the ballots that had picked it.
- `events.schedule_revision` goes up on every change to the selected showtime. Reminders and the phone's calendar entry are keyed on it.

### Pending actions

"Needs You" is derived on every read (`private.pending_actions()`), not stored. The moment someone answers, their action is gone; there is nothing to keep in sync. The notification planner reads the same function, which is why a reminder stops the instant its reason does.

## Who can read what

| Data | Rule |
| --- | --- |
| Roster | Going/Maybe are visible to members who have answered the RSVP themselves. Can't Go and unanswered are visible only to Dino and to the person (or a guest's host). After a night ends, the people who were checked in are visible to every current member. |
| Raw showtime picks | Nobody but Dino, through `get_voting`. Members get totals and their own answers. |
| Predictions | Your own and your guests'. Everyone else's once you have submitted yours, or once the night has ended. |
| Ratings | Your own. Everyone else's once you have submitted yours, or once the 48 hours are up. |
| Charges | Dino: all. A member: their own and their guests'. Nobody sees a peer's. |
| Push tokens, invites, audit log | `private` schema. No API role can read them. |
| Photos | Private bucket, signed URLs. Any current member can view; only checked-in members upload, into their own folder. |

Dino uses the same screens with the same blinding for predictions and ratings. His corrections go through separate, audited functions.

## Notifications

The app never sends a push. Server-side:

1. `private.notify` writes an inbox row (`public.notifications`), de-duplicated by key.
2. A trigger queues one delivery per enabled device (`private.notification_deliveries`), subject to a per-kind policy.
3. `pg_cron` runs `private.tick()` every 5 minutes: settles passed deadlines, runs the automatic voting close, then the planner, which turns pending actions into reminders.
4. The same job calls the `notifications-dispatch` Edge Function, which claims queued deliveries, sends them through Expo, records tickets and receipts, and switches off dead tokens.

The phone is asked for notification permission in the welcome tour (or later from You), after the app has said what it sends; signing in alone never brings up the system prompt.

Payment notifications never contain the amount. The app sends no text messages and stores no phone numbers; the only number in it is Dino's own, for Apple Cash.

## Edge Functions

| Function | Caller | Auth mode |
| --- | --- | --- |
| `invite-preview`, `invite-claim-begin` | the app, before sign-in | `publishable` (`verify_jwt = false`) |
| `owner-members` | Dino | `user`; the database decides he is the owner |
| `tmdb` | Dino | `user`; the database decides he is the owner |
| `notifications-dispatch` | `pg_cron` | `secret` (`verify_jwt = false`) |
| `owner-bootstrap` | `scripts/owner-bootstrap.mjs` | `secret`; deployed and deleted by the script, never left running |

All use `withSupabase` from `@supabase/server`. None invents its own authorization, and none relies on a request header for a security decision.

## Decisions worth knowing

- **Guests**: a guest belongs to one event. The same person next time is a new guest. Nothing ever infers that a guest is a member. When a guest joins the club, Dino says so (`promote_guest`, from the guest's row on the night): their place on that night becomes the member's own, the same row, so their RSVP, prediction, check-in and ticket carry over and the night counts in their history. A ticket still unpaid becomes theirs to settle.
- **Removing a member** deletes them outright (logins, Auth users, invites, inbox) when no movie night points at them; the foreign keys decide. Someone who was on a night stays as a `removed` member so their name still shows there, hidden from the Manage list unless Dino asks to see removed members, and can be brought back.
- **The welcome tour** (`src/app/intro.tsx`) is shown once per member per phone, remembered on the phone only (`src/lib/intro.ts`). It is skippable and nothing depends on it.
- **The recap picture** is drawn on the phone from what the page already shows and handed to the share sheet (`src/components/event/recap.tsx`). It carries the group's numbers and first names; no individual score leaves the app on it, and nothing is uploaded.
- **Trailers**: when a night is created the `tmdb` function keeps the YouTube id of the film's trailer in the movie's metadata. Nights made before that open a YouTube search instead.
- **Dino's ticket** is part of the split and recorded as a paid charge, so an event's charges always sum to what the tickets cost.
- **Split remainder**: `floor(total / n)` each, leftover cents one each to the first participants in joining order.
- **Late arrivals after tickets** (a check-in of someone who had declined, or a walk-in) are charged the amount most people on that event were charged; Dino can change it. Someone who drops out after tickets keeps their charge until Dino removes it.
- **Check-in implies attending**: checking someone in settles their confirmation as attending.
- **Reschedule** creates a new showtime row and switches to it; the old showtime and the votes on it are untouched. Correcting theater or format on the selected showtime resets nothing.
- **Scores are out of 5, to two decimals** (0.00 to 5.00), because that is how the club has always scored. One place decides what a valid score is in the database (`private.valid_score`) and one in the app (`MAX_SCORE` and `parseScore` in `src/lib/format.ts`). The slider lands on tenths; its two buttons move a hundredth.
- **Guests' scores**: a guest has a prediction and a rating like anyone else, both entered by their host (or Dino), and their rating counts in the night's score. Entering a guest's rating does not open the other ratings to the host; only the host's own rating does.
- **Delete Event** removes everything about the event. Only the audit entry remains.
- **Wipe History** (permanently deleting a member's personal history) is intentionally not built; nothing needs it yet.
