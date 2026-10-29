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
