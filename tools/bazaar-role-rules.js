#!/usr/bin/env node
'use strict';
// Bizarre Bazaar fork: install the Role Bot's rules (src/bazaarRoleBot.js).
const path = require('path');
const fs = require('fs');

const USAGE = `Usage:
  node tools/bazaar-role-rules.js install <rules.json> --data <dir> [--dry-run]
  node tools/bazaar-role-rules.js show --data <dir>
  node tools/bazaar-role-rules.js reset <username> --data <dir>

install  stores the rules, with role and channel names turned into ids. Run it
         after the server templates are imported, so every name resolves.
show     prints how many rules are installed and how many people linked.
reset    lets that person link Discord again. Roles already given stay.
--data is Haven's data folder (the one holding haven.db).`;

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const at = argv.indexOf('--data');
  const dataDir = at > -1 ? argv[at + 1] : '';
  if (!cmd || !dataDir || !['install', 'show', 'reset'].includes(cmd)) { console.error(USAGE); process.exit(2); }
  const Database = require('better-sqlite3');
  const db = new Database(path.join(path.resolve(dataDir), 'haven.db'), { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const bot = require('../src/bazaarRoleBot');
  try {
    if (cmd === 'install') {
      const input = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
      const dry = argv.includes('--dry-run');
      if (dry) db.exec('BEGIN');
      const counts = bot.installRules(db, input);
      if (dry) { db.exec('ROLLBACK'); console.log('Dry run, nothing stored.'); }
      console.log(`Rules ${dry ? 'would be' : ''} installed: ${counts.roles} Discord roles mapped, ${counts.channelOnly} channel-only roles, extra grants for ${counts.extra} people, snapshot of ${counts.snapshot} people.`);
    } else if (cmd === 'show') {
      const rules = bot.readRules(db);
      console.log(rules ? `Rules installed for guild ${rules.guildId}: ${Object.keys(rules.roleMap).length} roles mapped, ${Object.keys(rules.channelOnly).length} channel-only, ${Object.keys(rules.snapshot).length} in the snapshot.` : 'No rules installed.');
      const n = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'bazaar_discord_links'").get().n
        ? db.prepare('SELECT COUNT(*) AS n FROM bazaar_discord_links').get().n : 0;
      console.log(`${n} account(s) linked.`);
    } else {
      const u = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(argv[1] || '');
      if (!u) throw new Error(`no user named ${argv[1]}`);
      console.log(bot.resetLink(db, u.id) ? `${argv[1]} can link Discord again.` : `${argv[1]} had not linked Discord.`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
