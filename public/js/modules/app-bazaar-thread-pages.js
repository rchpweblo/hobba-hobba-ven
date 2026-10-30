// Bizarre Bazaar fork: a thread or forum topic opens on its newest replies
// and loads older ones a page at a time (get-thread-messages with `before`),
// from a button at the top or by scrolling up to it. Topics copied from
// Discord run to tens of thousands of replies, and drawing them all at once
// froze the desktop app.

export default {

// After a page is drawn: remember whether older replies remain and put the
// button above the replies.
_bazaarThreadPaged(data) {
  this._bazaarThreadMore = !!(data && data.hasMore);
  this._bazaarThreadLoading = false;
  this._bazaarThreadWatchScroll();
  const box = document.getElementById('thread-messages');
  if (!box) return;
  let btn = box.querySelector('.bz-thread-older');
  if (!this._bazaarThreadMore) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-sm bz-thread-older';
    btn.style.cssText = 'display:block;margin:6px auto;';
    btn.addEventListener('click', () => this._bazaarThreadLoadOlder());
  }
  btn.textContent = t('bazaar_thread_pages.older');
  btn.disabled = false;
  box.insertBefore(btn, box.querySelector(':scope > .thread-message'));
},

_bazaarThreadWatchScroll() {
  if (this._bazaarThreadScrollBound) return;
  const box = document.getElementById('thread-messages');
  if (!box) return;
  this._bazaarThreadScrollBound = true;
  box.addEventListener('scroll', () => { if (box.scrollTop < 150) this._bazaarThreadLoadOlder(); }, { passive: true });
},

_bazaarThreadLoadOlder() {
  if (!this._bazaarThreadMore || this._bazaarThreadLoading || !this._activeThreadParent) return;
  const box = document.getElementById('thread-messages');
  const first = box && box.querySelector(':scope > .thread-message');
  if (!first) return;
  this._bazaarThreadLoading = true;
  const btn = box.querySelector('.bz-thread-older');
  if (btn) { btn.disabled = true; btn.textContent = t('bazaar_thread_pages.loading'); }
  this.socket.emit('get-thread-messages', { parentId: this._activeThreadParent, before: parseInt(first.dataset.msgId, 10) });
},

// An older page goes above the replies already showing, and the view stays
// on the reply the reader was looking at.
_bazaarThreadPrepend(data) {
  const box = document.getElementById('thread-messages');
  if (!box || Number(data.parentId) !== Number(this._activeThreadParent)) { this._bazaarThreadLoading = false; return; }
  const fromBottom = box.scrollHeight - box.scrollTop;
  const shown = [...box.querySelectorAll(':scope > .thread-message')];
  for (const el of shown) el.remove();
  box.querySelector('.bz-thread-older')?.remove();
  for (const msg of data.messages || []) this._appendThreadMessage(msg);
  for (const el of shown) box.appendChild(el);
  this._bazaarThreadPaged(data);
  box.scrollTop = box.scrollHeight - fromBottom;
  this._bazaarThreadSeekStep?.(); // a jump to a pinned reply (app-bazaar-thread-pins.js)
},

};
