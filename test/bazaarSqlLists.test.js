'use strict';

// Bizarre Bazaar fork: SQL lists built as one "?" per item.
//
// SQLite refuses a statement with more than 32,766 parameters, and topics
// copied from Discord hold up to 48,000 replies, so a list that grows with
// the data (every reply of a topic, every message of a channel) must be bound
// as one JSON array instead (src/bazaarSqlList.js). Every "IN (${...})" list
// left in the server was checked on 2026-11-18 and is bounded: a page of
// history (100 at most), a client selection capped at 500 or less, the
// newest 1,000 replies of a topic, the users, roles or channels of the server,
// or a fixed set of setting keys. A few are subqueries with no parameters.
//
// This test counts them per file. A new one (from upstream or from us) fails
// it: check what bounds that list, then raise the count here, or bind it
// with IN_JSON when nothing does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIST = /IN \(\$\{/g;

const ALLOWED = {
  'src/bazaarEvents.js': 1,
  'src/bazaarRoleExclude.js': 1,
  'src/db/postgres/register.js': 1,
  'src/db/readPositions.js': 1,
  'src/forumBlog.js': 1,
  'src/forumUnread.js': 1,
  'src/messageQuotes.js': 1,
  'src/moveMessages.js': 10,
  'src/moveOutOfThread.js': 2,
  'src/moveToThread.js': 13,
  'src/permissionThresholds.js': 1,
  'src/protectedMessages.js': 4,
  'src/pushMutes.js': 2,
  'src/routes/maintenance.js': 5,
  'src/socketHandlers/admin.js': 2,
  'src/socketHandlers/asyncPermissions.js': 3,
  'src/socketHandlers/bazaarRoleExclude.js': 1,
  'src/socketHandlers/channelList.js': 7,
  'src/socketHandlers/channels.js': 3,
  'src/socketHandlers/groupE2E.js': 4,
  'src/socketHandlers/index.js': 2,
  'src/socketHandlers/messages.js': 19,
  'src/socketHandlers/moderation.js': 1,
  'src/socketHandlers/permissions.js': 4,
  'src/socketHandlers/roles.js': 8,
  'src/socketHandlers/users.js': 1,
  'src/threadNotify.js': 2,
  'src/uploadTagRoles.js': 2,
};

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no new one-"?"-per-item SQL list without a look at its size', () => {
  const found = {};
  for (const file of [path.join(ROOT, 'server.js'), ...jsFiles(path.join(ROOT, 'src'))]) {
    const n = (fs.readFileSync(file, 'utf8').match(LIST) || []).length;
    if (n) found[path.relative(ROOT, file).split(path.sep).join('/')] = n;
  }
  const grown = Object.entries(found).filter(([file, n]) => n > (ALLOWED[file] || 0));
  assert.deepEqual(grown, [], 'new IN (${...}) lists: see the note at the top of this test');
});
