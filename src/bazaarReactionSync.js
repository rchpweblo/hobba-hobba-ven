'use strict';

// Bizarre Bazaar fork: brings the reactions on messages already in Haven in
// line with Discord's (tools/bazaar-reaction-sync.js runs it).
//
// Ferry keeps reactions in step from the moment it sees them
// (src/ferryReactions.js), but not the ones from before:
//  - Copied history got Discord's reactions as if the admin who ran the
//    import had made them all, one per emoji whatever the count
//    (src/routes/import.js). Those rows are replaced by the real people, as
//    Discord reactions (ferry_reactions), the way Ferry stores them.
//  - Reactions made on Discord before Ferry carried reactions, or where it
//    did not yet (sub-channels), are added; ones since taken off go.
//  - Reactions made on Haven before then get the bot's reaction on Discord.
//
// It reads each Discord channel and thread a page at a time, and for every
// message with a Haven copy sets that copy's Discord reactions to what
// Discord has. A reaction with an emoji Haven has no match for is left alone,
// as Ferry leaves it.

const ferryReactions = require('./ferryReactions');
const bazaarFerryReactions = require('./bazaarFerryReactions');

const SNOWFLAKE = /^\d{15,25}$/;
const MAX_NAME = 80;

/**
 * Every Discord channel and thread with messages copied into Haven, biggest
 * first: [{ id, label, size }].
 */
function targets(db) {
  const out = new Map();
  for (const c of db.prepare(`
    SELECT c.id, c.name, c.discord_channel_id,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.thread_id IS NULL AND m.discord_message_id IS NOT NULL) AS size
    FROM channels c WHERE c.discord_channel_id IS NOT NULL AND c.is_dm = 0
  `).all()) {
    if (c.size && SNOWFLAKE.test(String(c.discord_channel_id))) out.set(String(c.discord_channel_id), { id: String(c.discord_channel_id), label: `#${c.name}`, size: c.size });
  }
  // Threads and forum topics: their replies, and a topic's first message.
  const roots = db.prepare(`
    SELECT r.id, r.discord_message_id, c.name, c.is_forum,
      (SELECT COUNT(*) FROM messages t WHERE t.thread_id = r.id) AS size
    FROM messages r JOIN channels c ON c.id = r.channel_id
    WHERE c.is_dm = 0 AND (r.id IN (SELECT DISTINCT thread_id FROM messages WHERE thread_id IS NOT NULL)
                           OR (c.is_forum = 1 AND r.thread_id IS NULL))
  `).all();
  for (const r of roots) {
    const id = bazaarFerryReactions.discordThreadOf(db, r);
    if (id && !out.has(id)) out.set(id, { id, label: `#${r.name} thread ${id}`, size: r.size + 1 });
  }
  return [...out.values()].sort((a, b) => b.size - a.size);
}

// Haven copies of a Discord message: copied or carried in, or sent out as it.
function copiesOf(db, discordMessageId) {
  return db.prepare(`
    SELECT m.id, m.channel_id, m.imported_from FROM messages m
    WHERE m.id IN (SELECT id FROM messages WHERE discord_message_id = ?
                   UNION SELECT haven_message_id FROM ferry_message_map WHERE discord_message_id = ?)
  `).all(discordMessageId, discordMessageId);
}

function reactorName(db, u) {
  let name = '';
  try {
    const saved = db.prepare("SELECT name FROM bazaar_discord_names WHERE kind = 'user' AND discord_id = ?").get(String(u.id));
    name = saved && saved.name;
  } catch { /* no saved names: Discord's */ }
  name = String(name || u.global_name || u.username || 'Discord user').replace(/[\r\n]+/g, ' ').trim();
  return name.slice(0, MAX_NAME) || 'Discord user';
}

const apiEmoji = (e) => encodeURIComponent(e.id ? `${e.name}:${e.id}` : e.name);

/**
 * Discord's reactions on one message, as Haven writes them:
 * { mapped: Map emoji -> { users: Map id -> name, botOn }, unmapped: Set of :name: }.
 * reactors(code, type) gives every user who reacted with that emoji.
 */
async function discordState(db, dmsg, { botId, isUsableEmoji, reactors, known }) {
  const mapped = new Map();
  const unmapped = new Set();
  for (const r of Array.isArray(dmsg.reactions) ? dmsg.reactions : []) {
    if (!r || !r.emoji) continue;
    const emoji = ferryReactions.havenEmojiFor(db, r.emoji, isUsableEmoji);
    if (!emoji) { if (r.emoji.name) unmapped.add(r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name); continue; }
    if (!mapped.has(emoji)) mapped.set(emoji, { users: new Map(), botOn: false });
    const entry = mapped.get(emoji);
    if (r.me) entry.botOn = true;
    const normal = r.count_details ? Number(r.count_details.normal) || 0 : Number(r.count) || 0;
    const burst = r.count_details ? Number(r.count_details.burst) || 0 : 0;
    const people = normal + burst - (r.me ? 1 : 0) - (r.me_burst || r.burst_me ? 1 : 0);
    if (people <= 0) continue;
    // Already right (Ferry saw them come in): no need to ask Discord.
    const have = known(emoji);
    if (have && have.size === people && !mapped.get(emoji).users.size) {
      for (const [id, name] of have) entry.users.set(id, name);
      continue;
    }
    for (const type of [0, 1]) {
      if ((type === 0 ? normal : burst) <= 0) continue;
      for (const u of await reactors(apiEmoji(r.emoji), type)) {
        if (!u || !SNOWFLAKE.test(String(u.id)) || String(u.id) === String(botId)) continue;
        entry.users.set(String(u.id), reactorName(db, u));
      }
    }
  }
  return { mapped, unmapped };
}

/**
 * Sets one Discord message's Haven copies to Discord's reactions.
 * opts: { botId, isUsableEmoji, reactors(code, type), importerId,
 * artifactsBefore, dryRun, react(copy, havenEmoji) }. Adds to `stats`.
 */
async function syncMessage(db, dmsg, opts, stats) {
  if (!dmsg || !SNOWFLAKE.test(String(dmsg.id))) return;
  const copies = copiesOf(db, String(dmsg.id));
  if (!copies.length) return;
  stats.messages = (stats.messages || 0) + 1;

  const knownStmt = db.prepare('SELECT discord_user_id, name FROM ferry_reactions WHERE message_id = ? AND emoji = ?');
  const known = (emoji) => {
    const rows = knownStmt.all(copies[0].id, emoji);
    return rows.length ? new Map(rows.map(r => [r.discord_user_id, r.name])) : null;
  };
  const state = await discordState(db, dmsg, { ...opts, known });

  for (const copy of copies) {
    // The import's stand-ins: the importing admin, on a copied message,
    // written before this run began.
    const artifacts = copy.imported_from === 'discord' && opts.importerId
      ? db.prepare('SELECT id, emoji FROM reactions WHERE message_id = ? AND user_id = ? AND created_at < ?').all(copy.id, opts.importerId, opts.artifactsBefore)
      : [];
    const dropArtifacts = artifacts.filter(a => !state.unmapped.has(a.emoji)); // no match on Haven: left as it was
    const have = db.prepare('SELECT emoji, discord_user_id FROM ferry_reactions WHERE message_id = ?').all(copy.id);
    const gone = have.filter(h => !(state.mapped.get(h.emoji)?.users.has(h.discord_user_id)));
    const add = [];
    for (const [emoji, e] of state.mapped) {
      for (const [id, name] of e.users) {
        if (!have.some(h => h.emoji === emoji && h.discord_user_id === id)) add.push({ emoji, id, name });
      }
    }
    stats.artifactsRemoved = (stats.artifactsRemoved || 0) + dropArtifacts.length;
    stats.artifactsKept = (stats.artifactsKept || 0) + (artifacts.length - dropArtifacts.length);
    stats.added = (stats.added || 0) + add.length;
    stats.removed = (stats.removed || 0) + gone.length;
    if (!opts.dryRun && (dropArtifacts.length || gone.length || add.length)) {
      db.transaction(() => {
        const delA = db.prepare('DELETE FROM reactions WHERE id = ?');
        for (const a of dropArtifacts) delA.run(a.id);
        const delF = db.prepare('DELETE FROM ferry_reactions WHERE message_id = ? AND emoji = ? AND discord_user_id = ?');
        for (const g of gone) delF.run(copy.id, g.emoji, g.discord_user_id);
        const ins = db.prepare('INSERT OR IGNORE INTO ferry_reactions (message_id, emoji, discord_user_id, name) VALUES (?, ?, ?, ?)');
        for (const a of add) ins.run(copy.id, a.emoji, a.id, a.name);
      })();
    }

    // Haven's own reactions that Discord has not seen: the bot's goes on.
    if (opts.react && bazaarFerryReactions.sendsOut(db, copy.channel_id)) {
      const dropped = new Set(dropArtifacts.map(a => a.id));
      const keptArtifacts = new Set(artifacts.map(a => a.id));
      const mine = db.prepare('SELECT id, emoji FROM reactions WHERE message_id = ?').all(copy.id)
        .filter(r => !dropped.has(r.id) && !keptArtifacts.has(r.id));
      for (const emoji of new Set(mine.map(r => r.emoji))) {
        if (state.mapped.get(emoji)?.botOn) continue;
        stats.botReactions = (stats.botReactions || 0) + 1;
        if (!opts.dryRun) await opts.react(copy, emoji);
      }
    }
  }
}

module.exports = { targets, copiesOf, discordState, syncMessage, reactorName };
