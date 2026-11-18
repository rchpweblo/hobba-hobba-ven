'use strict';

/**
 * Votes on forum topics (#5742), kept out of database.js, which is already
 * past its size budget.
 *
 * channels.forum_votes is the per-forum switch: 0 off (the default),
 * 1 likes, 2 likes and dislikes. forum_votes holds one row per person per
 * topic, value 1 for a like and -1 for a dislike; taking a vote back deletes
 * the row. In a blog forum each picture of a post is its own message (the
 * topic, or one of its author's additions), so picture votes (#5784) are
 * rows here too, keyed by that message. Rows go with their topic or their voter through the cascades.
 * Turning votes off hides them without deleting any, so turning them back
 * on brings the counts back.
 */

const { IN_JSON, jsonList } = require('./bazaarSqlList'); // Bizarre Bazaar fork

const MODES = { off: 0, likes: 1, both: 2 };
const MODE_NAMES = ['off', 'likes', 'both'];

function migrateForumVotes(db, addColumn) {
  addColumn('channels', 'forum_votes', 'INTEGER DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_votes (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value      INTEGER NOT NULL CHECK (value IN (1, -1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_forum_votes_user ON forum_votes(user_id);
  `);
}

// { likes, dislikes } for one topic.
function totalsOf(db, messageId) {
  const r = db.prepare(`SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes
    FROM forum_votes WHERE message_id = ?`).get(messageId);
  return { likes: r.likes, dislikes: r.dislikes };
}

// Map of message id to { likes, dislikes, mine } for a page of topics, where
// mine is this reader's own vote (1, -1 or 0).
function votesFor(db, userId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  // Bizarre Bazaar fork: one JSON parameter, so a blog post with thousands
  // of pieces (a topic copied from Discord) still fits.
  const list = jsonList(ids);
  for (const r of db.prepare(`SELECT message_id, SUM(value = 1) AS likes, SUM(value = -1) AS dislikes
    FROM forum_votes WHERE message_id ${IN_JSON} GROUP BY message_id`).all(list)) {
    out.set(r.message_id, { likes: r.likes, dislikes: r.dislikes, mine: 0 });
  }
  for (const r of db.prepare(`SELECT message_id, value FROM forum_votes WHERE user_id = ? AND message_id ${IN_JSON}`).all(userId, list)) {
    const v = out.get(r.message_id);
    if (v) v.mine = r.value;
  }
  return out;
}

// The same for the pieces of a blog post (#5784), as a plain object keyed by
// message id, with every piece present even before anyone votes.
function pieceVotesFor(db, userId, ids) {
  const found = votesFor(db, userId, ids);
  const out = {};
  for (const id of ids) out[id] = found.get(id) || { likes: 0, dislikes: 0, mine: 0 };
  return out;
}

// Set one person's vote: 1, -1, or 0 to take it back.
function setVote(db, messageId, userId, value) {
  if (value === 0) {
    db.prepare('DELETE FROM forum_votes WHERE message_id = ? AND user_id = ?').run(messageId, userId);
  } else {
    db.prepare(`INSERT INTO forum_votes (message_id, user_id, value) VALUES (?, ?, ?)
      ON CONFLICT(message_id, user_id) DO UPDATE SET value = excluded.value, created_at = CURRENT_TIMESTAMP`).run(messageId, userId, value);
  }
  return totalsOf(db, messageId);
}

// Why this person may not cast `value` on a message in this forum, or null
// when they may. Topic votes and picture votes (#5784) share it, so both
// follow the same rules. `row` carries channel_id, role_gate and
// forum_votes. Any error refuses the vote.
function voteRefusal(ctx, user, row, value) {
  const { db } = ctx;
  let allowed = false;
  try {
    // Only people who can see the forum may vote in it.
    const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(row.channel_id, user.id);
    const banned = db.prepare('SELECT 1 FROM bans WHERE user_id = ?').get(user.id);
    allowed = !!member && !banned && (user.isAdmin || ctx.roleGateAllows(user.id, { id: row.channel_id, role_gate: row.role_gate }));
  } catch (err) {
    console.warn('[forum-votes] access check failed, refusing the vote:', err.message);
    allowed = false;
  }
  if (!allowed) return 'Not a member of this channel';

  const mode = row.forum_votes || 0;
  if (mode === MODES.off) return 'Votes are turned off in this forum';
  if (value === -1 && mode !== MODES.both) return 'Dislikes are turned off in this forum';

  // A muted member cannot vote, the same as reacting.
  const mute = db.prepare("SELECT 1 FROM mutes WHERE user_id = ? AND expires_at > datetime('now') LIMIT 1").get(user.id);
  if (mute) return 'You are in a timeout';
  return null;
}

module.exports = { MODES, MODE_NAMES, migrateForumVotes, totalsOf, votesFor, pieceVotesFor, setVote, voteRefusal };
