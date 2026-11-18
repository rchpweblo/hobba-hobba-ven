'use strict';

// Official messages: someone whose role has Highlight Messages can mark what
// they post as said on behalf of their role. The message then carries that
// role's name and colour. The role is stored, not its look, so renaming or
// recolouring the role updates every message it marked; a deleted role
// leaves the mark with no name.
//
// Official mode (users.official_mode) is the sender's "keep it on" switch:
// while it is on, the composer arms every message instead of one at a time.
// The client still sends highlight: true per message, so the server never
// marks anything the sender did not ask for. Off unless the person turns it on.

const { IN_JSON, jsonList } = require('./bazaarSqlList'); // Bizarre Bazaar fork

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_highlights (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Official mode, for databases from before it.
  const hasMode = db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'official_mode');
  if (!hasMode) db.exec('ALTER TABLE users ADD COLUMN official_mode INTEGER NOT NULL DEFAULT 0');
}

// What a client can rely on from this server, sent in session-info so apps
// that talk to servers of different versions know what to show.
const FEATURES = ['highlight_messages', 'official_mode'];

function officialMode(db, userId) {
  try {
    const row = db.prepare('SELECT official_mode FROM users WHERE id = ?').get(userId);
    return !!(row && row.official_mode);
  } catch (err) {
    // Read on load: a failure means plain messages until it works again.
    console.warn('[highlight] reading official mode failed:', err.message);
    return false;
  }
}

function setOfficialMode(db, userId, on) {
  db.prepare('UPDATE users SET official_mode = ? WHERE id = ?').run(on ? 1 : 0, userId);
  return !!on;
}

function lookup(db, messageIds) {
  const out = new Map();
  if (!messageIds || !messageIds.length) return out;
  // Bizarre Bazaar fork: one JSON parameter, so a whole long topic fits.
  db.prepare(`
    SELECT h.message_id, r.name, r.color, r.color2, r.color_shimmer
    FROM message_highlights h LEFT JOIN roles r ON r.id = h.role_id
    WHERE h.message_id ${IN_JSON}
  `).all(jsonList(messageIds)).forEach(r => out.set(r.message_id, toPayload(r)));
  return out;
}

function forMessage(db, messageId) {
  return lookup(db, [messageId]).get(messageId) || null;
}

function toPayload(row) {
  return {
    role: row.name || null,
    color: row.color || null,
    color2: row.color2 || null,
    shimmer: !!row.color_shimmer,
  };
}

// The role a message speaks for: the author's highest role in that channel.
// An admin who holds no role gets a mark with no role name.
function mark(db, { messageId, userId, channelId, getUserHighestRole }) {
  let roleId = null;
  try {
    const role = getUserHighestRole ? getUserHighestRole(userId, channelId) : null;
    roleId = role ? role.id : null;
  } catch (err) {
    console.warn('[highlight] role lookup failed:', err.message);
  }
  db.prepare('INSERT OR REPLACE INTO message_highlights (message_id, role_id, user_id) VALUES (?, ?, ?)')
    .run(messageId, roleId, userId);
  return forMessage(db, messageId);
}

function unmark(db, messageId) {
  db.prepare('DELETE FROM message_highlights WHERE message_id = ?').run(messageId);
}

module.exports = { FEATURES, ensureTable, lookup, forMessage, mark, unmark, officialMode, setOfficialMode };
