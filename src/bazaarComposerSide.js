'use strict';

// Bizarre Bazaar fork: "Right side message buttons" (Settings > Layout &
// Density > Message Box, public/js/modules/app-bazaar-composer-side.js) is
// on by default for accounts made from release 26 on. Members who joined
// before keep the button bar on the left, where they are used to it. The
// client asks once per browser, through session-info.

const NEW_ACCOUNTS_SINCE = '2026-11-18 00:00:00'; // users.created_at, UTC

function isNewAccount(db, userId) {
  try {
    const row = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
    return !!(row && row.created_at && String(row.created_at).replace('T', ' ') >= NEW_ACCOUNTS_SINCE);
  } catch {
    return false; // unknown: leave the buttons where they always were
  }
}

module.exports = { isNewAccount, NEW_ACCOUNTS_SINCE };
