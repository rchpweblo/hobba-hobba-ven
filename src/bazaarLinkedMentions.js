'use strict';

// Bizarre Bazaar fork: Discord @mentions of linked people become Haven
// @mentions.
//
// Messages that came from Discord (copied history and Ferry) mention people
// as Discord's code, <@id>, which the client shows by name
// (src/bazaarDiscordRefs.js). Search, the @ button (mentions:me) and the
// mention marks in the channel list only know @login, so for someone who
// linked Discord through the Role Bot (src/bazaarRoleBot.js) the code is
// written as @theirlogin instead, in the message itself:
//  - every message already in Haven, when they link (and at each start, for
//    anything copied in since);
//  - every new or edited message Ferry brings in (src/bazaarFerryPings.js).
//
// Only messages that belong to no Haven account (user_id IS NULL) are
// touched: those are the Discord ones, and changing them sends nothing back
// to Discord (bazaar_ferry_outbox_edit skips them). No edited mark, no
// notifications: an old message stays read and pings nobody.
//
// bazaar_linked_mentions remembers whose codes were written as which login,
// so when a link goes (tools/bazaar-role-rules.js reset, or the account is
// deleted) or the login changes, @login goes back to <@id> and, for a new
// login, forward again. bazaar_linked_mention_msgs lists the messages
// rewritten afterwards, which never light up an unread @mention mark in the
// channel list (src/socketHandlers/channelList.js): someone who never opened
// a channel would otherwise find years-old mentions waiting there.

const SNOWFLAKE = /^\d{15,25}$/;
const LOGIN = /^[A-Za-z0-9_]{1,32}$/;
const BATCH = 50; // about 150 ms of work at most, between breaths

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_linked_mentions (
      discord_id TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      login      TEXT NOT NULL,
      done_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bazaar_linked_mention_msgs (message_id INTEGER PRIMARY KEY);
  `);
}

// ── Old mentions stay quiet ──
let quietSet = null;
function quietIds(db) {
  if (!quietSet) {
    try { quietSet = new Set(db.prepare('SELECT message_id FROM bazaar_linked_mention_msgs').all().map(r => r.message_id)); }
    catch { return new Set(); } // no table yet: nothing rewritten
  }
  return quietSet;
}

/**
 * An unread-mentions query (src/mentionFilter.js) that leaves out messages
 * rewritten here, so they never count as new mentions.
 */
function quiet(db, q) {
  if (!q) return q;
  return { ...q, pick: (rows) => { const s = quietIds(db); return q.pick(s.size ? rows.filter(r => !s.has(Number(r.id))) : rows); } };
}

// Linked people: Map discord id -> { userId, login }.
function linkedLogins(db) {
  const out = new Map();
  for (const r of db.prepare(`
    SELECT l.discord_id, u.id AS user_id, u.username AS login
    FROM bazaar_discord_links l JOIN users u ON u.id = l.user_id
    WHERE l.source != 'none'
  `).all()) {
    if (SNOWFLAKE.test(String(r.discord_id)) && LOGIN.test(String(r.login || ''))) {
      out.set(String(r.discord_id), { userId: r.user_id, login: r.login });
    }
  }
  return out;
}

// One person's code written as @login. A space keeps it a mention when the
// code was written against a word ("hi<@id>", "<@id>s").
function codeToLogin(text, discordId, login) {
  const re = new RegExp(`<@!?${discordId}>`, 'g');
  return String(text).replace(re, (code, at, all) => {
    const before = at > 0 && /[\w@]/.test(all[at - 1]) ? ' ' : '';
    const after = /\w/.test(all[at + code.length] || '') ? ' ' : '';
    return `${before}@${login}${after}`;
  });
}

function loginToCode(text, discordId, login) {
  const re = new RegExp(`(?<![\\w@])@${login}(?!\\w)`, 'g');
  return String(text).replace(re, `<@${discordId}>`);
}

/** Every linked person's code in this text as @login (for Ferry). */
function forText(db, text) {
  const s = String(text || '');
  if (!db || s.indexOf('<@') === -1) return s;
  let out = s;
  try {
    for (const [id, p] of linkedLogins(db)) {
      if (out.indexOf(id) !== -1) out = codeToLogin(out, id, p.login);
    }
  } catch (err) {
    // The codes stay; they still show by name.
    console.warn('[linked-mentions] could not look up linked people:', err.message);
  }
  return out;
}

// The Discord messages whose text has this word, from the search index.
function candidates(db, word) {
  return db.prepare(`
    SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid
    WHERE messages_fts MATCH ? AND m.user_id IS NULL
  `).all(`"${String(word).replace(/"/g, '""')}"`).map(r => r.id);
}

const pause = () => new Promise(r => setImmediate(r));

// Rewrites the messages in small transactions, letting Haven breathe between
// them. Returns how many changed. `remember` lists them as quiet.
async function rewrite(db, ids, change, { remember = false } = {}) {
  const read = db.prepare('SELECT content FROM messages WHERE id = ? AND user_id IS NULL');
  const write = db.prepare('UPDATE messages SET content = ? WHERE id = ? AND user_id IS NULL');
  const note = db.prepare('INSERT OR IGNORE INTO bazaar_linked_mention_msgs (message_id) VALUES (?)');
  let changed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH);
    changed += db.transaction(() => {
      let n = 0;
      for (const id of part) {
        const row = read.get(id);
        if (!row || typeof row.content !== 'string') continue;
        const next = change(row.content);
        if (next === row.content || !write.run(next, id).changes) continue;
        n++;
        if (remember) { note.run(id); if (quietSet) quietSet.add(id); }
      }
      return n;
    })();
    await pause();
  }
  return changed;
}

let running = null;
let again = false;

/**
 * Brings every message in line with the links: codes of linked people as
 * @login, and @login back to the code where a link went or a login changed.
 * Safe to call any time; calls while it runs make it go round once more.
 * Resolves to { written, restored }.
 */
function reconcile(db, log = console) {
  if (running) { again = true; return running; }
  running = (async () => {
    const total = { written: 0, restored: 0 };
    do {
      again = false;
      const wanted = linkedLogins(db);
      // Gone or changed: back to the code first.
      for (const done of db.prepare('SELECT discord_id, user_id, login FROM bazaar_linked_mentions').all()) {
        const now = wanted.get(done.discord_id);
        if (now && now.userId === done.user_id && now.login === done.login) continue;
        if (LOGIN.test(done.login)) {
          total.restored += await rewrite(db, candidates(db, done.login), t => loginToCode(t, done.discord_id, done.login));
        }
        db.prepare('DELETE FROM bazaar_linked_mentions WHERE discord_id = ?').run(done.discord_id);
      }
      // Linked: every code still in a message, including history copied
      // in since the last time.
      for (const [id, p] of wanted) {
        total.written += await rewrite(db, candidates(db, id), t => codeToLogin(t, id, p.login), { remember: true });
        db.prepare(`INSERT INTO bazaar_linked_mentions (discord_id, user_id, login) VALUES (?, ?, ?)
          ON CONFLICT(discord_id) DO UPDATE SET user_id = excluded.user_id, login = excluded.login, done_at = CURRENT_TIMESTAMP`)
          .run(id, p.userId, p.login);
      }
    } while (again);
    if (total.written || total.restored) {
      log.log(`[linked-mentions] ${total.written} message(s) now @mention linked people, ${total.restored} back to Discord codes`);
    }
    return total;
  })().catch((err) => {
    log.warn('[linked-mentions] stopped:', err.message);
    return { written: 0, restored: 0, error: err.message };
  }).finally(() => {
    running = null;
    if (again) { again = false; reconcile(db, log); } // asked for after the last round
  });
  return running;
}

module.exports = { ensureSchema, reconcile, forText, quiet, codeToLogin, loginToCode, linkedLogins };
