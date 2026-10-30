// Bizarre Bazaar fork: a thread or forum topic opens on its newest replies
// and loads older ones a page at a time (get-thread-messages with `before`),
// from a button at the top or by scrolling up to it. Topics copied from
// Discord run to tens of thousands of replies, and drawing them all at once
// froze the desktop app.
//
// A jump to an old reply (a pin, app-bazaar-thread-pins.js) opens the replies
// around it instead (`around`), without drawing everything in between; from
// there newer replies load the same way at the foot (`after`), and "jump to
// latest" goes back to the newest. While such a window is open, a reply
// posted meanwhile is counted on that button rather than added below.

export default {

// After a page is drawn: remember whether older (and newer) replies remain
// and put the buttons at the ends.
_bazaarThreadPaged(data) {
  this._bazaarThreadMore = !!(data && data.hasMore);
  if (data && !data.before) this._bazaarThreadNewer = !!data.hasNewer;
  this._bazaarThreadLoading = false;
  this._bazaarThreadWatchScroll();
  this._bazaarThreadNewerBtn();
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

_bazaarThreadNewerBtn() {
  const box = document.getElementById('thread-messages');
  if (!box) return;
  let btn = box.querySelector('.bz-thread-newer');
  if (!this._bazaarThreadNewer) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-sm bz-thread-newer';
    btn.style.cssText = 'display:block;margin:6px auto;';
    btn.addEventListener('click', () => this._bazaarThreadLoadNewer());
  }
  btn.textContent = t('bazaar_thread_pages.newer');
  btn.disabled = false;
  box.appendChild(btn);
},

_bazaarThreadWatchScroll() {
  if (this._bazaarThreadScrollBound) return;
  const box = document.getElementById('thread-messages');
  if (!box) return;
  this._bazaarThreadScrollBound = true;
  box.addEventListener('scroll', () => {
    if (box.scrollTop < 150) this._bazaarThreadLoadOlder();
    if (this._bazaarThreadNewer && box.scrollHeight - box.scrollTop - box.clientHeight < 150) this._bazaarThreadLoadNewer();
  }, { passive: true });
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

_bazaarThreadLoadNewer() {
  if (!this._bazaarThreadNewer || this._bazaarThreadLoading || !this._activeThreadParent) return;
  const box = document.getElementById('thread-messages');
  const shown = box && box.querySelectorAll(':scope > .thread-message');
  const last = shown && shown[shown.length - 1];
  if (!last) return;
  this._bazaarThreadLoading = true;
  const btn = box.querySelector('.bz-thread-newer');
  if (btn) { btn.disabled = true; btn.textContent = t('bazaar_thread_pages.loading_newer'); }
  this.socket.emit('get-thread-messages', { parentId: this._activeThreadParent, after: parseInt(last.dataset.msgId, 10) });
},

// Back to the newest replies, from a window further up.
_bazaarThreadReloadLatest() {
  if (!this._activeThreadParent) return;
  this._bazaarThreadNewer = false;
  this.socket.emit('get-thread-messages', { parentId: this._activeThreadParent, paged: true });
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
},

// A newer page goes below, and the view stays where it was.
_bazaarThreadAppendNewer(data) {
  const box = document.getElementById('thread-messages');
  this._bazaarThreadLoading = false;
  if (!box || Number(data.parentId) !== Number(this._activeThreadParent)) return;
  const fromTop = box.scrollTop;
  box.querySelector('.bz-thread-newer')?.remove();
  for (const msg of data.messages || []) this._appendThreadMessage(msg);
  this._bazaarThreadNewer = !!data.hasNewer;
  this._bazaarThreadNewerBtn();
  box.scrollTop = fromTop;
  this._updateThreadJump?.();
},

};
