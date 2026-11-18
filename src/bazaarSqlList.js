'use strict';

// Bizarre Bazaar fork: a list bound as ONE parameter (a JSON array) instead
// of one "?" per item. SQLite refuses more than 32,766 parameters, and topics
// copied from Discord hold up to 48,000 replies. SQLite only (json_each), so
// use it only on the synchronous SQLite interface, never through db.async.
//
//   db.prepare(`SELECT ... WHERE message_id ${IN_JSON}`).all(jsonList(ids))
//
// The column on the left must be a plain column, so its type converts the
// list's values the way it converted the old "?" ones.

const IN_JSON = 'IN (SELECT value FROM json_each(?))';
const jsonList = (values) => JSON.stringify(Array.from(values));

module.exports = { IN_JSON, jsonList };
