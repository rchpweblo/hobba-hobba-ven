// The thread panel follows new replies only while you are reading the newest.
//
// Every reply used to scroll the panel to the bottom, so someone reading a
// busy thread from the start was pulled away each time the others posted.
// Now a reply keeps the view where it is unless the reader was already at
// the bottom (the same 40px rule the chat feed uses, app-feed-anchor.js).
// Your own reply always takes you down. Replies that arrive while you are
// scrolled up are counted on a button at the foot of the panel, which also
// works as "jump to latest" once you are far from the end. The pop-out
// thread is the same panel, so it behaves the same.

// How far from the end the jump button appears with nothing new to count.
const JUMP_SHOW_PX = 400;

export default {

_setupThreadScroll() {
  const box = document.getElementById('thread-messages');
  const btn = document.getElementById('thread-jump-latest');
  if (!box || !btn) return;
  this._threadUnseen = 0;
  box.addEventListener('scroll', () => {
    if (this._threadGap(box) <= 40) this._threadUnseen = 0;
    this._updateThreadJump();
  }, { passive: true });
  btn.addEventListener('click', () => this._threadJumpToLatest());
},

_threadGap(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight;
},

// A reply was just added at the end. gapBefore is how far from the end the
// reader was before it went in.
_threadAfterLiveReply(box, gapBefore, msg) {
  const mine = !!(msg && this.user && msg.user_id != null && msg.user_id === this.user.id);
  const blog = !!this._forumBlogThread;
  const follow = this._feedShouldStick({ live: true, coupled: mine, gapBefore, startsAtEnd: !blog, scrolled: box.scrollTop > 0 });
  if (follow) {
    box.scrollTop = box.scrollHeight;
    this._threadUnseen = 0;
  } else if (!mine) {
    this._threadUnseen = (this._threadUnseen || 0) + 1;
  }
  this._updateThreadJump();
},

// A thread was just opened or loaded again: nothing is waiting.
_resetThreadJump() {
  this._threadUnseen = 0;
  this._updateThreadJump();
},

_threadJumpToLatest() {
  const box = document.getElementById('thread-messages');
  if (!box) return;
  // Bizarre Bazaar fork: from a window of older replies, the newest are fetched.
  if (this._bazaarThreadNewer && this._bazaarThreadReloadLatest) { this._threadUnseen = 0; return this._bazaarThreadReloadLatest(); }
  box.scrollTop = box.scrollHeight;
  this._threadUnseen = 0;
  this._updateThreadJump();
},

_updateThreadJump() {
  const box = document.getElementById('thread-messages');
  const btn = document.getElementById('thread-jump-latest');
  const label = document.getElementById('thread-jump-count');
  if (!box || !btn) return;
  const n = this._threadUnseen || 0;
  const show = n > 0 || this._threadGap(box) > JUMP_SHOW_PX || !!this._bazaarThreadNewer; // Bizarre Bazaar fork
  btn.classList.toggle('visible', show);
  btn.classList.toggle('has-count', n > 0);
  const text = n > 0 ? t(n === 1 ? 'thread_runtime.new_replies_one' : 'thread_runtime.new_replies_other', { count: n > 99 ? '99+' : n }) : '';
  if (label) label.textContent = text;
  btn.title = text || t('thread_runtime.jump_latest');
},

};
