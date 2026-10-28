'use strict';
/**
 * Bizarre Bazaar fork: forums where only staff start new posts.
 *
 * channels.bazaar_staff_topics is the per-forum switch (0 off, the default;
 * 1 on). With it on, only the admin and holders of read_only_override (the
 * same people who may post in a read-only channel) start new posts; everyone
 * else can still reply inside the posts that already exist, as in a Discord
 * forum where Send Messages is off and Send Messages in Threads is on.
 *
 * A top-level message in a forum is a post, so every way a member makes one
 * checks here: send-message, create-poll, and a scheduled message both when
 * it is queued and when it goes out. Thread replies (send-thread-message) are
 * left alone on purpose.
 *
 * Kept in its own file, like forumBlog.js, so merging an upstream release
 * only meets one-line hooks in database.js and socketHandlers/messages.js.
 */
const REFUSAL = 'Only staff can start new posts in this forum. Reply inside an existing post instead.';

function migrateBazaarForum(addColumn) {
  addColumn('channels', 'bazaar_staff_topics', 'INTEGER DEFAULT 0');
}

// True when this person may not start a new post in the channel with this id.
// userHasPermission is passed in because it lives in the socket handlers.
function blocksNewPost(db, channelId, { userId, isAdmin }, userHasPermission) {
  if (isAdmin) return false;
  const row = db.prepare('SELECT is_forum, is_dm, bazaar_staff_topics FROM channels WHERE id = ?').get(channelId);
  if (!row || !row.is_forum || row.is_dm || Number(row.bazaar_staff_topics) !== 1) return false;
  return !userHasPermission(userId, 'read_only_override', channelId);
}

module.exports = { REFUSAL, migrateBazaarForum, blocksNewPost };
