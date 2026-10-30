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
- **Category headers lit while open.** An open category header is highlighted and a collapsed one
  is dark, the reverse of upstream, so a lit header means its channels are showing.
  File: `public/css/style-sidebar.css`.
- **Discord mentions in copied history read as names.** History copied from Discord keeps
  Discord's codes (`<@id>`, `<@&id>`, `<#id>`); the client shows them as names when it draws a
  message, and the stored text is left alone. A person who linked Discord for the Role Bot shows
  as their Haven name, a role in the Role Bot's rules as its Haven role, and a copied channel as a
  link to it, for people who can see it. Anything else shows by its Discord name, looked up once
  with `tools/bazaar-discord-names.js` (channels @everyone cannot see keep their names hidden).
  Nobody is pinged.
  Files: `src/bazaarDiscordRefs.js`, `tools/bazaar-discord-names.js`,
  `public/js/modules/app-bazaar-discord-refs.js`, with hooks in `src/database.js`,
  `src/socketHandlers/bazaarRoleBot.js`, `public/js/app.js`,
  `public/js/modules/app-bazaar-role-bot.js`, `public/js/modules/app-message-content.js` and
  `public/locales/en.json`. Test: `test/bazaarDiscordRefs.test.js`.

**2026-10-29, based on Haven v4.27.0**

- **Ferry carries threads that are sub-channels.** A Discord thread imported into a sub-channel
  of its own (see above) stays joined to it once the sub-channel's parent is paired: the thread's
  new messages come into the sub-channel as chat lines, and messages written in the sub-channel
  go into the thread through the parent pairing's webhook. Upstream Ferry pairs channels only,
  so these messages became a Haven thread in the parent and nothing went back.
  Files: `src/bazaarFerryThreads.js` (new), with hooks in `src/ferry.js` and
  `src/socketHandlers/index.js`. Test: `test/bazaarFerryThreads.test.js`.
- **Relayed thread replies keep their Discord id.** A reply Ferry brings into a Haven thread or
  forum topic now stores the Discord message id, as a relayed chat line already did, so
  importing the same history later skips it instead of adding it twice.
  Files: `server.js`, `src/ferry.js`. Test: `test/bazaarFerryThreads.test.js`.
- **Catching up an imported channel.** A channel picked for a Discord import may carry `after`,
  a Discord message id, and only the messages after it are read. Writing a catch-up of a forum
  post already in Haven keeps its first new reply as a reply; upstream took the earliest
  message read for the post's opening message.
  File: `src/routes/import.js`. Test: `test/bazaarCatchUp.test.js`.
- **Threads that share a name all import.** The importer found each picked channel's messages by
  Discord id or by name, whichever matched first, so of several threads with the same name
  (say, "spam") every one after the first was written from the first one's messages and its
  own were lost. A pick with a Discord id is now matched by id alone.
  File: `src/routes/import.js`. Test: `test/bazaarCatchUp.test.js`.
- **Thread replies in paired chat channels reach Discord.** Upstream Ferry sent thread replies
  only for forum topics. A reply in a Haven thread of a paired chat channel now goes into the
  Discord thread on the Discord copy of the message the thread hangs from, and the thread is
  made there when it does not exist yet (named after the message). Replies written in that
  Discord thread come back under the same Haven message. A message with no Discord copy keeps
  its thread in Haven. Which Discord thread a Haven thread is lives in
  `bazaar_ferry_chat_threads`.
  Files: `src/bazaarFerryThreads.js`, with hooks in `src/database.js`, `src/ferry.js`,
  `src/socketHandlers/index.js` and `server.js`. Test: `test/bazaarFerryThreads.test.js`, with
  thread routes added to `test/fakeDiscord.js`.
- **Voice bubble.** While a voice channel with people in it is scrolled out of the channel list,
  or sits in a collapsed category, a small bubble pinned to the top or bottom edge of the list
  shows their avatars and the channel's name (or how many channels); clicking it opens the
  channel. The server icon carries a 🔊 badge while anyone is in a voice channel (private calls
  are not counted).
  Files: `public/js/modules/app-bazaar-voice-bubble.js` (new), with hooks in `public/js/app.js`,
  `public/js/modules/app-channel-unread.js` and `public/locales/en.json`.
  Test: `test/bazaarVoiceBubble.test.js`.
- **Long threads load in pages.** A thread or forum topic opens on its newest 150 replies, and
  older ones load 150 at a time from a "Show older replies" button at the top, or by scrolling up
  to it. Topics copied from Discord run to tens of thousands of replies, and upstream drew them
  all at once, which froze the desktop app. The server pages only for a client that asks
  (`paged` or `before` on `get-thread-messages`), so other clients and blog-mode topics still get
  the whole thread.
  Files: `public/js/modules/app-bazaar-thread-pages.js` (new), with hooks in
  `src/socketHandlers/messages.js`, `public/js/app.js`, `public/js/modules/app-socket-events.js`,
  `public/js/modules/app-threads.js`, `public/js/modules/app-move-to-thread.js` and
  `public/locales/en.json`. Test: `test/bazaarThreadPages.test.js`.

**2026-10-30, based on Haven v4.27.0**

- **Edits and deletes cross Ferry both ways.** A message deleted on either side is deleted on
  the other, whatever deleted it (a person, a moderator, a bulk delete, a self-destruct timer, a
  deleted account), and an edit follows its message. Upstream Ferry applied only Discord edits,
  and only to the last 500 messages relayed since the server started. Copied history counts too:
  each imported message keeps its Discord id. Exceptions: deleting a whole channel or its pairing
  deletes nothing on Discord; a protected Haven message stays; and a Discord delete of a message
  that has Haven thread replies marks it "[deleted on Discord]" instead of deleting it, because
  Discord keeps a thread's replies when its first message goes. A Discord edit to copied history
  replaces the words and keeps the pictures stored in Haven.
  Haven's deletes and edits are caught by triggers on `messages` into `bazaar_ferry_outbox`, and
  Ferry sends them while the setting `bazaar_ferry_sync_out` is `on`; more than 200 in a minute
  sets it to `paused` and sends nothing until it is turned back on. A thread's first message
  deleted in Haven deletes its whole Discord thread when the bot has Manage Threads. The bot needs
  Manage Messages to delete messages other people wrote. Pairs of Haven and Discord messages
  (`ferry_message_map`) are now kept for good instead of 90 days, and forum topics, forum replies
  and thread replies sent to Discord now record theirs.
  Files: `src/bazaarFerrySync.js` (new), with hooks in `src/ferry.js`, `src/ferryReplies.js`,
  `src/database.js`, `src/socketHandlers/index.js` and `src/socketHandlers/messages.js`.
  Test: `test/bazaarFerrySync.test.js`, with delete and edit routes added to `test/fakeDiscord.js`.
- **The voice bubble is a little bigger** (half again as big, then trimmed by a quarter on the
  user's word, so about an eighth bigger than release 10), and follows the reduced-motion setting when it
  scrolls to a channel. File: `public/js/modules/app-bazaar-voice-bubble.js`.
- **Ferry copies Discord's files into Haven.** A message Ferry brings in from Discord is posted at
  once with Discord's links to its pictures and files, as upstream; then each file on Discord's
  file servers is copied into Haven like an import's attachments (`src/importFiles.js`, privacy
  pass included), and the link becomes the picture, or the file with its player or download
  button. Discord signs those links and they stop working after about a day, so upstream's
  relayed pictures went dead. Links people paste count too. Open screens get the new text with no
  "edited" mark. The size cap is the server's upload limit, but at least 500 MB (Discord's largest
  upload); a file over it, or already gone, stays a link.
  Files: `src/ferry.js`, `src/importFiles.js`, `public/js/modules/app-socket-events.js`,
  `public/js/app.js`. Test: `test/bazaarFerrySync.test.js`, with Discord's file servers added to
  `test/fakeDiscord.js`.
- **Discord's stickers are Haven stickers.** A sticker sent on Discord is copied once into
  `uploads/stickers/` as `discord-<id>.png` (or `.gif`) and shows in Haven as a sticker; upstream
  relayed a link to Discord's picture. The guild's own stickers also go into the sticker picker as
  a "Discord" pack, each the first time Ferry sees it (GUILD_CREATE, GUILD_STICKERS_UPDATE), so
  one an admin removes in Haven stays removed. Discord's Lottie stickers become
  "*[sticker: name]*". A pasted sticker link is copied the same way. Going out, a sticker from
  Haven's library is sent to Discord as its picture; upstream wrote "(file not found)". The
  importer keeps a message that is only a sticker, which upstream left out.
  Files: `src/bazaarStickers.js` (new, with table `bazaar_discord_stickers`), `src/ferry.js`,
  `src/database.js`, `src/routes/import.js`. Test: `test/bazaarFerrySync.test.js`.
