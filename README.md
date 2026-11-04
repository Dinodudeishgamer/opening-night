# Opening Night

A private movie-night app for one group of friends, built for iPhone and invitation only.

The organizer posts a movie night, and one page carries it from "are you in?" to the photos afterwards:

1. **RSVP**: Going, Maybe, or Can't Go, with guests.
2. **Vote** on showtimes: tick every one that works.
3. **Confirm** the showtime that gets picked. People who already ticked it are confirmed automatically.
4. **Pay** the organizer back: the ticket cost splits itself, with Venmo and Apple Cash links filled in.
5. **Guess** a score out of 5 before the lights go down. It locks, and you only see others' guesses after.
6. **Get checked in** at the theater, walk-ins included.
7. **Rate** it. The group score rolls onto the screen with how your guess held up.
8. **Look back**: results with closest guess, biggest surprise, biggest fan; a shareable recap picture; photos; a poster wall of every night.

Reminders arrive only while something is actually waiting on you, and stop the moment you act.

## Built with

| | |
| --- | --- |
| App | Expo SDK 54, React Native 0.81, Expo Router, TypeScript, React Compiler |
| Backend | Supabase: Postgres with Row Level Security, Edge Functions (Deno), Storage, `pg_cron`, `pg_net` |
| Delivery | EAS Build, TestFlight / App Store, over-the-air updates (`expo-updates`) |
| Data | The Movie Database (TMDB) for films, posters and trailers |

## Design decisions worth a look

- **The database is the rulebook.** The app has no write access to any table. Every change is a Postgres function (`public.<name>` as a thin `SECURITY INVOKER` wrapper over a `private.<name>_impl` `SECURITY DEFINER` implementation), so who may RSVP when, who sees whose scores, and how tickets split are enforced in one place. A structural test fails the build if any function or grant breaks the pattern.
- **Sign-in is an invite code and nothing else.** No passwords, email, or phone numbers. A code is exchanged for a one-time claim ticket, and a Supabase Auth hook refuses to create any user that is not carrying a live ticket. Codes are stored only as HMACs, expire, work once, and are rate-limited.
- **Privacy by row.** Guesses are hidden until you lock in yours, ratings until you have rated, rosters until you have RSVPed. All of it is Row Level Security, not app logic.
- **No stored phase.** A movie night's stage is derived from independent timestamps (RSVP deadline, showtime picked, tickets bought, ended), the same way in SQL and in the app, so nothing can drift out of sync.
- **Notifications are server-side.** Writing an inbox row queues a push to every device and calls the sender as the transaction commits. A five-minute `pg_cron` tick handles deadlines and reminders, each de-duplicated by key so running it twice sends nothing twice.

## Running it

```bash
npm install
cp .env.example .env    # two public values: the Supabase URL and publishable key
npm start               # open in a development build
```

Push notifications, the photo picker, haptics, and the share picture need a development build on a real device (`eas build --profile development`).

## Tests

```bash
npm test                 # all of the below: 160 tests, no Docker, no network
npm run test:db          # every migration applied to an in-process Postgres (PGlite), then the
                         #   whole movie-night workflow, access rules, and structural security checks
npm run test:functions   # Edge Functions and their auth gates, with the network stubbed
npm run test:lib         # the app's pure logic: formatting, stages, statistics, links
npm run lint && npm run typecheck
```

`supabase/tests/hosted-rollback-check.sql` runs a complete movie night against the live database inside a transaction that always rolls back.

## More

- [`docs/architecture.md`](docs/architecture.md): the design and the security model
- [`docs/operations.md`](docs/operations.md): setup, deploying, and what to do when something goes wrong
- [Privacy policy](docs/privacy.md)
