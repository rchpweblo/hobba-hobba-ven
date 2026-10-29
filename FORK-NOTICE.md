# Bizarre Bazaar fork of Haven

This is a modified version of [Haven](https://github.com/ancsemi/Haven), licensed under the
GNU Affero General Public License v3 (see `LICENSE`). It is the source code of the Haven server
the Bizarre Bazaar community runs, offered to its users as section 13 of that licence requires.
It is not the official Haven project. Report problems with this fork to its maintainer, not to
Haven's developers.

The `bazaar` branch is upstream Haven with the changes below on top. Upstream releases are merged
in as they come out. Each deployed version is tagged `bazaar-<upstream version>-<n>`.

## Changes from upstream

**2026-10-28, based on Haven v4.27.0**

- **Staff-only new posts in forums.** Channel Functions → "Staff-only new posts" (forums only).
  With it on, only the admin and roles with Read-only override can start a new post, and everyone
  else can still reply inside existing posts. This works like a Discord forum where Send Messages
  is off and Send Messages in Threads is on. It's stored in `channels.bazaar_staff_topics` and
  server templates can set it (`bazaarStaffTopics`).
  Files: `src/bazaarForum.js` (new), with hooks in `src/database.js`,
  `src/socketHandlers/messages.js`, `src/socketHandlers/channels.js`,
  `src/socketHandlers/index.js`, `src/serverTemplate.js`, `public/app.html`,
  `public/js/modules/app-channel-context.js`, `public/js/modules/app-channel-menu.js`,
  `public/js/modules/app-forum.js` and `public/locales/en.json`. Test: `test/bazaarForum.test.js`.
- **Role names up to 100 characters**, up from 30, so roles copied from Discord keep their full
  names. Discord's own limit is 100. Files: `src/socketHandlers/roles.js`,
  `src/serverTemplate.js`, `public/js/modules/app-roles.js`, `test/serverTemplate.test.js`, plus
  a width cap on the role badge beside message authors in
  `public/css/style-presence-connections.css`.
- **Hidden from roles.** Channel Functions → "Hidden from roles" (admin only). Anyone holding one
  of the chosen roles, server-wide or in that channel, cannot see or open the channel, even if they
  hold its required roles. The admin always can. This works like a Discord role with View Channel
  denied. It's stored in `channels.bazaar_role_exclude` (a JSON list of role ids) and checked
  inside `roleGateAllows`, so every place that honours required roles honours it too. Deleting a
  role takes it off the list. Server templates don't carry it yet.
  Files: `src/bazaarRoleExclude.js` and `src/socketHandlers/bazaarRoleExclude.js` (new), with
  hooks in `src/roleGate.js`, `src/database.js`, `src/socketHandlers/index.js`,
  `src/socketHandlers/roles.js`, `public/app.html`, `public/js/modules/app-channel-context.js`,
  `public/js/modules/app-channel-menu.js`, `public/js/modules/app-role-tools.js` and
  `public/locales/en.json`. Test: `test/bazaarRoleExclude.test.js`.
- **Channel roles in the Required roles editor.** Upstream left channel-scoped roles out of the
  list, although one held in a channel opens that channel's lock, so saving the editor quietly
  removed them from the lock. They are listed now, marked "Channel".
  File: `public/js/modules/app-role-tools.js`.
- **Discord threads can be imported into sub-channels.** When a Discord thread's own id is linked
  to a Haven channel (`channels.discord_channel_id`), the Discord history importer writes the
  thread's messages into that channel instead of making a Haven thread in its parent. This is how
  chosen threads come over as sub-channels; every other thread still becomes a Haven thread.
  File: `src/routes/import.js`. Test: `test/bazaarThreadChannel.test.js`.
- **Voice channels look different, and voice starts off.** In the channel list a channel with
  voice on shows 🗣️ instead of `#` (sub-channels instead of `↳`), the way forums show 🗂️.
  In Create Channel the Voice box starts unticked and a "Voice channel" template ticks it; new
  sub-channels start with voice off and Channel Functions turns it on. The server's own default
  is unchanged, so anything else that creates channels behaves as upstream.
  Files: `public/js/modules/app-channels.js`, `public/js/modules/app-role-tools.js`,
  `public/js/modules/app-channel-menu.js`, `public/app.html`, `public/locales/en.json`,
  `src/socketHandlers/channels.js`.
- **The Role Bot.** A member can link their Discord account once, from a first-login pop-up or
  Settings → Connections. Discord OAuth (the `identify` scope) says who they are; the Ferry bot
  then reads their roles in the community's Discord server and Haven gives them the matching
  roles, with channel-only roles given in their channels. Someone no longer in the Discord server
  gets their roles from a snapshot. It only ever adds roles, and a Discord account links to one
  Haven account. The rules (Discord role ids to Haven roles) live in the database, installed with
  `tools/bazaar-role-rules.js`, so no community data is in this repository. It stays off until
  `BAZAAR_DISCORD_CLIENT_ID`, `BAZAAR_DISCORD_CLIENT_SECRET`, the rules and a Ferry bot token
  are all set.
  Files: `src/bazaarRoleBot.js`, `src/bazaarDiscordLinkRoutes.js`,
  `src/socketHandlers/bazaarRoleBot.js`, `tools/bazaar-role-rules.js`,
  `public/js/modules/app-bazaar-role-bot.js`, with hooks in `server.js`, `src/database.js`,
  `src/socketHandlers/index.js`, `src/socketHandlers/users.js`, `public/js/app.js`,
  `public/js/modules/app-platform.js`, `public/app.html` and `public/locales/en.json`.
  Test: `test/bazaarRoleBot.test.js`.
- **Scheduled events.** An Events section above Join a Channel lists upcoming and live events.
  An event has a name, description, start and optional end, cover image, and a place: a channel
  or somewhere else. It can repeat (weekly, every other week, monthly on the nth weekday, yearly,
  every weekday), keeping its wall-clock time in its own time zone across clock changes. People
  mark themselves Interested. Two new role permissions, Create Events and Manage Events, checked in
  the event's channel. A channel event starts when someone allowed presses Start; everyone
  Interested gets a pop-up with a Join button, and a push notification when away. An event
  somewhere else starts and ends at its times. A live event ends at its end time, or with no end
  time after 30 minutes with nobody in voice (24 hours at most); a channel event nobody started is
  missed after 12 hours; a repeating event then moves to its next date. Discord's scheduled events
  can be copied with `tools/bazaar-discord-events.js`; people Interested there become Interested
  here when they link Discord for the Role Bot.
  Files: `src/bazaarEvents.js`, `src/bazaarEventTime.js`, `src/bazaarEventImageRoute.js`,
  `src/socketHandlers/bazaarEvents.js`, `tools/bazaar-discord-events.js`,
  `public/js/modules/app-bazaar-events.js`, with hooks in `server.js`, `src/database.js`,
  `src/socketHandlers/index.js`, `src/socketHandlers/helpers.js`, `src/bazaarDiscordLinkRoutes.js`,
  `public/app.html`, `public/js/app.js`, `public/js/modmode.js`,
  `public/js/modules/perm-catalog.js`, `public/js/modules/app-perm-matrix.js` and
  `public/locales/en.json`. Tests: `test/bazaarEvents.test.js`, `test/bazaarEventTime.test.js`.
- **Several TURN addresses.** `TURN_URL` may list addresses separated by commas, such as the same
  relay over UDP and over TCP for networks that block UDP. File: `server.js`.
