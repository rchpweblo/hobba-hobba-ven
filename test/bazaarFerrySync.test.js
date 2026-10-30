/**
 * Bizarre Bazaar fork: edits and deletes cross Ferry both ways
 * (src/bazaarFerrySync.js and its part of src/ferry.js).
 *
 * Boots a Haven server on a scratch port and data dir, pointed at the
 * stand-in Discord in test/fakeDiscord.js, as test/bazaarFerryThreads.test.js does:
 *   node --test test/bazaarFerrySync.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');
const { startFakeDiscord, GUILD_ID, TEXT_ID } = require('./fakeDiscord');

const PORT = 3431;
const DISCORD_PORT = 3432;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-bazaar-ferry-sync-${Date.now()}`);
const FAKE_TOKEN = 'FAKE' + 'x'.repeat(66);

let server;
let discord;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return null;
}

async function bootServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true',
      NODE_ENV: 'test',
      FERRY_TEST_DISCORD_API: `http://127.0.0.1:${DISCORD_PORT}`,
      FERRY_TEST_DISCORD_GATEWAY: `ws://127.0.0.1:${DISCORD_PORT}`,
      FERRY_TEST_DISCORD_CDN: `http://127.0.0.1:${DISCORD_PORT}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  discord = await startFakeDiscord(DISCORD_PORT);
  await bootServer();
});

test.after(async () => {
  await new Promise((res) => {
    if (!server || server.exitCode !== null) return res();
    server.once('exit', () => res());
    server.kill();
  });
  await discord?.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

const ALICE = { id: '1300000000000000100', username: 'alice', global_name: 'Alice', avatar: null, discriminator: '0' };
const discordMessage = (id, channelId, content, extra = {}) =>
  ({ id, channel_id: channelId, guild_id: GUILD_ID, type: 0, content, author: ALICE, attachments: [], embeds: [], mentions: [], ...extra });

test('edits and deletes cross both ways', async (t) => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'ferrysync1234', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const A = await connect(admin.token);

  const tokenOk = next(A, 'ferry:token-ok');
  A.emit('ferry:set-token', { token: FAKE_TOKEN });
  assert.ok(await tokenOk, 'the fake Discord accepted the token');
  A.emit('ferry:set-option', { key: 'ferry_enabled', value: true });
  const connected = await until(async () => {
    const p = next(A, 'ferry:config');
    A.emit('ferry:get-config');
    const c = await p;
    return c && c.state.connected && c.guilds.length ? c : null;
  }, 10000);
  assert.ok(connected, 'Ferry connected to the fake gateway');

  const list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'talk'));
  A.emit('create-channel', { name: 'talk' });
  const talk = (await list).find((c) => c.name === 'talk');
  const cfg = next(A, 'ferry:config', (c) => c.links.length === 1);
  A.emit('ferry:create-link', { channelCode: talk.code, guildId: GUILD_ID, discordChannelId: TEXT_ID, direction: 'both', outMode: 'all' });
  assert.ok(await cfg, 'paired');
  A.emit('enter-channel', { code: talk.code });

  const db = new Database(path.join(DATA, 'haven.db'));
  t.after(() => db.close());
  const talkId = db.prepare('SELECT id FROM channels WHERE code = ?').get(talk.code).id;
  const setMode = (v) => db.prepare("INSERT INTO server_settings (key, value) VALUES ('bazaar_ferry_sync_out', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
  const modeNow = () => db.prepare("SELECT value FROM server_settings WHERE key = 'bazaar_ferry_sync_out'").get()?.value;
  const outbox = () => db.prepare('SELECT COUNT(*) AS n FROM bazaar_ferry_outbox').get().n;
  // History the importer copied: no Haven author, Discord's id kept.
  const imported = (discordId, content) => {
    discord.messages.set(discordId, TEXT_ID);
    return Number(db.prepare("INSERT INTO messages (channel_id, user_id, content, imported_from, discord_message_id, webhook_username) VALUES (?, NULL, ?, 'discord', ?, 'Alice')")
      .run(talkId, content, discordId).lastInsertRowid);
  };
  setMode('on');

  await t.test('a Discord delete removes the Haven copy, and nothing goes back', async () => {
    const MID = discord.newId();
    discord.messages.set(MID, TEXT_ID);
    discord.dispatch('MESSAGE_CREATE', discordMessage(MID, TEXT_ID, 'soon gone'));
    const row = await until(() => db.prepare('SELECT id FROM messages WHERE content = ?').get('soon gone'));
    assert.ok(row, 'it arrived');
    const gone = next(A, 'message-deleted', (d) => d && d.messageId === row.id);
    discord.dispatch('MESSAGE_DELETE', { id: MID, channel_id: TEXT_ID, guild_id: GUILD_ID });
    assert.ok(await gone, 'open screens are told');
    assert.strictEqual(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(row.id), undefined, 'deleted in Haven');
    await wait(3500);
    assert.strictEqual(discord.deletions.filter((d) => d.messageId === MID).length, 0, 'not deleted back on Discord');
    assert.strictEqual(outbox(), 0);
  });

  await t.test('a bulk delete on Discord reaches history the importer copied', async () => {
    const one = discord.newId();
    const two = discord.newId();
    const a = imported(one, 'old one');
    const b = imported(two, 'old two');
    discord.dispatch('MESSAGE_DELETE_BULK', { ids: [one, two], channel_id: TEXT_ID, guild_id: GUILD_ID });
    assert.ok(await until(() => !db.prepare('SELECT 1 FROM messages WHERE id IN (?, ?)').get(a, b)), 'both deleted in Haven');
  });

  await t.test('a Discord edit to copied history changes the words and keeps its pictures', async () => {
    const MID = discord.newId();
    const id = imported(MID, 'old words\n/uploads/pic.png');
    discord.dispatch('MESSAGE_UPDATE', discordMessage(MID, TEXT_ID, 'new words',
      { attachments: [{ id: '1', url: 'https://cdn.discordapp.com/attachments/1/2/pic.png', filename: 'pic.png' }] }));
    const row = await until(() => db.prepare("SELECT content, edited_at FROM messages WHERE id = ? AND content LIKE 'new words%'").get(id));
    assert.ok(row, 'edited');
    assert.strictEqual(row.content, 'new words\n/uploads/pic.png');
    assert.ok(row.edited_at, 'marked edited');
    await wait(3500);
    assert.strictEqual(discord.edits.length, 0, 'nothing sent back');
  });

  await t.test('a thread start deleted on Discord keeps its Haven replies', async () => {
    const MID = discord.newId();
    const root = imported(MID, 'start of a big thread');
    db.prepare("INSERT INTO messages (channel_id, user_id, content, thread_id) VALUES (?, ?, 'a reply', ?)").run(talkId, admin.user.id, root);
    discord.dispatch('MESSAGE_DELETE', { id: MID, channel_id: TEXT_ID, guild_id: GUILD_ID });
    const row = await until(() => db.prepare("SELECT content FROM messages WHERE id = ? AND content LIKE '%deleted on Discord%'").get(root));
    assert.ok(row, 'the start is marked deleted');
    assert.ok(db.prepare('SELECT 1 FROM messages WHERE thread_id = ?').get(root), 'its replies are kept');
  });

  let copyId;
  let havenId;
  await t.test('a message written in Haven: its edit and its delete reach Discord', async () => {
    const sentNow = discord.executions.length;
    const sent = next(A, 'new-message', (d) => d && d.message && d.message.content === 'written in haven');
    A.emit('send-message', { code: talk.code, content: 'written in haven' });
    havenId = (await sent).message.id;
    const out = await until(() => discord.executions.slice(sentNow).find((e) => e.body && e.body.content === 'written in haven'));
    assert.ok(out, 'relayed');
    copyId = out.result.id;
    assert.ok(await until(() => db.prepare('SELECT 1 FROM ferry_message_map WHERE haven_message_id = ?').get(havenId)), 'paired');

    A.emit('edit-message', { messageId: havenId, content: 'written in haven, then fixed', channelCode: talk.code });
    const edit = await until(() => discord.edits.find((e) => e.messageId === copyId));
    assert.ok(edit, 'the edit reached Discord');
    assert.strictEqual(edit.body.content, 'written in haven, then fixed');
    assert.strictEqual(edit.threadId, null);

    // Discord echoes our own edit back; the Haven message is left alone.
    const hook = [...discord.webhooks.values()].find((w) => w.channelId === TEXT_ID);
    discord.dispatch('MESSAGE_UPDATE', discordMessage(copyId, TEXT_ID, 'written in haven, then fixed', { webhook_id: hook.id, author: { id: hook.id, username: 'admin', bot: true } }));
    await wait(500);
    assert.strictEqual(db.prepare('SELECT user_id FROM messages WHERE id = ?').get(havenId).user_id, admin.user.id, 'still the Haven author');

    A.emit('delete-message', { messageId: havenId, channelCode: talk.code });
    const del = await until(() => discord.deletions.find((d) => d.messageId === copyId && d.status === 204));
    assert.ok(del, 'deleted on Discord');
    assert.strictEqual(del.channelId, TEXT_ID);
    assert.ok(await until(() => outbox() === 0), 'the outbox empties');
  });

  await t.test('deleting copied history in Haven deletes it on Discord', async () => {
    const MID = discord.newId();
    const id = imported(MID, 'an old post');
    A.emit('delete-message', { messageId: id, channelCode: talk.code });
    assert.ok(await until(() => discord.deletions.find((d) => d.messageId === MID && d.status === 204)), 'deleted on Discord');
  });

  await t.test('while sync is off nothing goes, and it waits', async () => {
    setMode('off');
    const MID = discord.newId();
    const id = imported(MID, 'wait for it');
    A.emit('delete-message', { messageId: id, channelCode: talk.code });
    assert.ok(await until(() => outbox() === 1), 'queued');
    await wait(3500);
    assert.ok(!discord.deletions.find((d) => d.messageId === MID), 'not sent');
    setMode('on');
    assert.ok(await until(() => discord.deletions.find((d) => d.messageId === MID && d.status === 204)), 'sent once on');
  });

  await t.test('a burst pauses sync and sends nothing', async () => {
    const before = discord.deletions.length;
    const add = db.prepare("INSERT INTO bazaar_ferry_outbox (kind, haven_message_id, channel_id, discord_message_id) VALUES ('delete', ?, ?, ?)");
    db.transaction(() => { for (let i = 0; i < 201; i++) add.run(900000 + i, talkId, discord.newId()); })();
    assert.ok(await until(() => modeNow() === 'paused'), 'paused');
    assert.strictEqual(discord.deletions.length, before, 'nothing sent');
    assert.strictEqual(outbox(), 201, 'all still waiting');
    db.prepare('DELETE FROM bazaar_ferry_outbox').run();
    setMode('on');
  });

  await t.test("a relayed message's Discord files are copied into Haven", async () => {
    const MID = discord.newId();
    const quiet = next(A, 'message-edited', (d) => d && d.quiet === true, 10000);
    discord.dispatch('MESSAGE_CREATE', discordMessage(MID, TEXT_ID, 'look at this', {
      attachments: [
        { id: '11', filename: 'cat.png', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1&is=2&hm=3&' },
        { id: '12', filename: 'gone.png', url: 'https://cdn.discordapp.com/attachments/1/3/gone.png?ex=1' },
      ],
    }));
    const row = await until(() => db.prepare("SELECT id, content FROM messages WHERE discord_message_id = ? AND content LIKE '%/uploads/%'").get(MID), 10000);
    assert.ok(row, 'the copy is in the message');
    const lines = row.content.split('\n');
    assert.strictEqual(lines[0], 'look at this');
    assert.match(lines[1], /^\/uploads\/\d+-[0-9a-f]{16}\.png$/, 'the picture is a Haven upload');
    assert.ok(fs.existsSync(path.join(DATA, 'uploads', lines[1].slice('/uploads/'.length))), 'stored on disk');
    assert.strictEqual(lines[2], 'https://cdn.discordapp.com/attachments/1/3/gone.png?ex=1', 'an expired file stays a link');
    const ev = await quiet;
    assert.ok(ev && ev.messageId === row.id, 'open screens get it without an edited mark');
    assert.strictEqual(db.prepare('SELECT edited_at FROM messages WHERE id = ?').get(row.id).edited_at, null, 'not marked edited');

    // A later Discord edit changes the words and keeps the copy.
    discord.dispatch('MESSAGE_UPDATE', discordMessage(MID, TEXT_ID, 'look at this cat', {
      attachments: [{ id: '11', filename: 'cat.png', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=9' }],
    }));
    const edited = await until(() => db.prepare("SELECT content FROM messages WHERE id = ? AND content LIKE 'look at this cat%'").get(row.id));
    assert.ok(edited, 'edited');
    assert.ok(edited.content.includes(lines[1]), 'the copy is kept');
  });

  await t.test("Discord's stickers come into Haven, and go back out", async () => {
    const PIG = '1400000000000000001';
    const update = (stickers) => discord.dispatch('GUILD_STICKERS_UPDATE', { guild_id: GUILD_ID, stickers });
    const library = next(A, 'library-updated', (d) => d && d.kind === 'stickers', 10000);
    update([
      { id: PIG, name: 'Big Pig', format_type: 1 },
      { id: '1400000000000000002', name: 'wumpus wave', format_type: 3 },
    ]);
    const pig = await until(() => db.prepare("SELECT name, filename FROM stickers WHERE pack_name = 'Discord'").get(), 10000);
    assert.deepStrictEqual(pig, { name: 'big_pig', filename: `discord-${PIG}.png` }, "the guild's sticker is in the picker");
    assert.ok(fs.existsSync(path.join(DATA, 'uploads', 'stickers', pig.filename)), 'stored');
    assert.ok(await library, 'open pickers are told');
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM stickers WHERE pack_name = 'Discord'").get().n, 1, 'a Lottie sticker is left out');

    // Removed in Haven, it stays removed.
    db.prepare("DELETE FROM stickers WHERE pack_name = 'Discord'").run();
    update([{ id: PIG, name: 'Big Pig', format_type: 1 }]);
    await wait(1500);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM stickers WHERE pack_name = 'Discord'").get().n, 0, 'not put back');

    const relayed = async (stickers, content = '') => {
      const MID = discord.newId();
      discord.dispatch('MESSAGE_CREATE', discordMessage(MID, TEXT_ID, content, { sticker_items: stickers }));
      return { MID, row: await until(() => db.prepare('SELECT id, content FROM messages WHERE discord_message_id = ?').get(MID)) };
    };
    const known = await relayed([{ id: PIG, name: 'Big Pig', format_type: 1 }]);
    assert.strictEqual(known.row.content, `/uploads/stickers/discord-${PIG}.png`, 'a copied sticker shows at once');

    const other = await relayed([{ id: '1400000000000000003', name: 'Hanging', format_type: 4 }]);
    // Another server's sticker: Discord's picture first (often too briefly to see), then the copy.
    assert.ok(await until(() => db.prepare("SELECT 1 FROM messages WHERE id = ? AND content = '/uploads/stickers/discord-1400000000000000003.gif'").get(other.row.id), 10000), 'then the copy');

    const lottie = await relayed([{ id: '1400000000000000002', name: 'wumpus wave', format_type: 3 }]);
    assert.strictEqual(lottie.row.content, '*[sticker: wumpus wave]*', 'a Lottie sticker by name');

    // A pasted sticker link ("Copy link" on a sticker). Typed links meet the
    // link filter first, which on this server keeps Discord's domain out.
    const { linksIn } = require('../src/bazaarStickers');
    const url = 'https://media.discordapp.net/stickers/1400000000000000004.png?size=160&name=Nugdups';
    assert.deepStrictEqual(linksIn(`lol [Nugdups](${url})`), [{ url, id: '1400000000000000004', name: 'Nugdups', format: 1 }]);

    // A Haven sticker goes to Discord as its picture.
    const sentNow = discord.executions.length;
    A.emit('send-message', { code: talk.code, content: `/uploads/stickers/discord-${PIG}.png` });
    const out = await until(() => discord.executions.slice(sentNow).find((e) => e.body && Array.isArray(e.body.files) && e.body.files.length));
    assert.ok(out, 'sent with the picture attached');
    assert.strictEqual(out.body.files[0].filename, `discord-${PIG}.png`);
    assert.ok(!String(out.body.content || '').includes('file not found'));
  });

  await t.test('deleting a whole channel deletes nothing on Discord', async () => {
    const before = discord.deletions.length;
    const MID = discord.newId();
    imported(MID, 'lives on in discord');
    const gone = next(A, 'channels-list', (chs) => Array.isArray(chs) && !chs.some((c) => c.name === 'talk'));
    A.emit('delete-channel', { code: talk.code });
    assert.ok(await gone, 'channel deleted');
    await wait(3500);
    assert.strictEqual(discord.deletions.length, before, 'nothing deleted on Discord');
    assert.strictEqual(outbox(), 0);
  });

  A.disconnect();
});
