# Print League

A friendly, invite-only competition for people who love making things with a 3D printer.

## How it works

1. Suggest a theme and vote for your favorite.
2. Join the challenge and make your print.
3. Meet up for judging and celebrate the winners.
4. Share a link so the crew can explore what you made.

## Features

- Topic suggestions, voting windows, and competition countdowns.
- Participation, entries, category awards, and trophy shelves.
- MakerWorld and Printables links with optional preview images.
- Member profiles and recovery codes.
- A shared ideas board.
- Mobile layouts, appearance themes, and a Benchy-inspired design.

Print files stay on their original model platforms; members share links rather than uploading project files.

## Credits

The visual identity is inspired by #3DBenchy. See [artwork credits](tools/assets/README.md) for the trophy and model-photo sources.

## Filament shopping

Any member can start a spree for Bambu Lab, Polymaker, or SUNLU. The organizer sets a roll target based on the vendor’s offer and can set or change an optional deadline. Members can pick a featured filament or paste a vendor product link, then add the exact variant and quantity. The organizer can close or cancel the spree at any roll count. Participants see an update on the site, and the organizer handles checkout with the vendor.

## Database migrations

`supabase/migrations/` records each change needed to upgrade the hosted database. Several older migrations are long because they replace the complete `league_rpc` function each time they change one of its branches. These files define schema and behavior. Live league data is stored separately in Supabase. To release changes, apply pending migrations before deploying the `league-api` Edge Function and publishing the frontend.

The Edge Function now runs the main league operations in server-side JavaScript. It connects using the Supabase-provided `SUPABASE_DB_URL` and uses the existing private tables, transaction lock, and shared database helpers. The database URL and service-role key belong in function secrets.

For a backend rollback, set the function secret `LEAGUE_RPC_MODE=sql` to route the main operations through the previous database function. Both implementations use the same tables and accept the same sessions. Confirm the linked migration history, apply pending migrations, and verify sign-in and a private league request after deploying. Keep the old function available until the cutover has been verified.

## Signal shopping bridge

The optional bridge posts openings, closures, deadline expirations, and cancellations to one Signal group. In that group, `!league` links to the site and `!shopping` links to the shopping board. Members sign in to Print League to create and manage sprees and picks.

1. Install a current version of [signal-cli](https://github.com/AsamK/signal-cli) on an always-on host, link the bot’s Signal account, and add that account to your group. Use `signal-cli -a ACCOUNT --output=json listGroups` to find the group ID.
2. Generate a 64-character hex secret with `openssl rand -hex 32`. Set it as `LEAGUE_SIGNAL_TOKEN` in the deployed Edge Function’s Supabase secrets and in the bridge’s private environment.
3. Set `SIGNAL_ACCOUNT` to the bot account, `SIGNAL_GROUP_ID` to the group ID, `LEAGUE_API_URL` to the deployed function URL ending in `/league-api/`, and `LEAGUE_SITE_URL` to the public site URL. Run `node tools/signal-bot.mjs` with Node 22 or newer under a service supervisor. Run one instance per Print League deployment.
