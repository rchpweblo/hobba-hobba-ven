// Bizarre Bazaar fork: pins inside a forum topic or thread. A reply can be
// pinned from its toolbar (Pin or Unpin, for those who may pin), and the
// thread panel's 📌 button lists what is pinned in this topic only. The
// channel's own pins, and a forum's pinned topics, stay as upstream has them.
// Server side: bazaarPinReply and bazaar:get-thread-pins in
// src/socketHandlers/messages.js.

export default {

_bazaarSetupThreadPins() {
  this.socket.on('bazaar:thread-pin', (data) => {
    if (!data || Number(data.threadId) !== Number(this._activeThreadParent)) return;
    const el = document.querySelector(`#thread-messages [data-msg-id="${data.messageId}"]`);
    if (el) this._bazaarMarkThreadPin(el, !!data.pinned);
    this._bazaarThreadPinCount(data.count);
    if (this._bazaarThreadPinsOpen()) this._bazaarRequestThreadPins();
  });
  this.socket.on('bazaar:thread-pins', (data) => {
    if (!data || Number(data.parentId) !== Number(this._activeThreadParent)) return;
    this._bazaarThreadPinCount((data.pins || []).length);
    this._bazaarRenderThreadPins(data.pins || []);
  });
  this._bazaarThreadPinsStyle();
},

_bazaarCanPinThread() {
  return !!(this.user?.isAdmin || (this._hasPerm && this._hasPerm('pin_message')));
},

// The toolbar button for a reply (app-threads.js puts it in the overflow).
_bazaarThreadPinBtn(msg, iconPair) {
  if (!this._bazaarCanPinThread()) return '';
  const action = msg.pinned ? 'unpin' : 'pin';
  const icon = iconPair('📌', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3H7l3-3-1-6z" stroke-width="1.8" stroke-linejoin="round"></path><path d="M12 13v7" stroke-width="1.8" stroke-linecap="round"></path></svg>');
  const title = msg.pinned ? t('msg_toolbar.unpin') : t('msg_toolbar.pin');
  return `<button data-thread-action="${action}" title="${title}">${icon}</button>`;
},

async _bazaarThreadPinAction(msgId, action) {
  if (action === 'pin' && !(await this._showConfirmModal(t('confirm.pin_message'), ''))) return;
  this.socket.emit(action === 'pin' ? 'pin-message' : 'unpin-message', { messageId: msgId });
},

// A reply's look and its toolbar button follow its pin.
_bazaarMarkThreadPin(el, pinned) {
  el.classList.toggle('pinned', pinned);
  if (pinned) el.dataset.pinned = '1'; else delete el.dataset.pinned;
  const header = el.querySelector('.thread-msg-header');
  const tag = el.querySelector('.thread-msg-header .pinned-tag');
  if (pinned && header && !tag) {
    header.querySelector('.thread-msg-time')?.insertAdjacentHTML('afterend', `<span class="pinned-tag" title="${t('app.messages.pinned')}">📌</span>`);
  } else if (!pinned && tag) tag.remove();
  const btn = el.querySelector('[data-thread-action="pin"], [data-thread-action="unpin"]');
  if (btn) {
    btn.dataset.threadAction = pinned ? 'unpin' : 'pin';
    btn.title = t(pinned ? 'msg_toolbar.unpin' : 'msg_toolbar.pin');
  }
},

// After a topic opens: the 📌 button in the panel's header, with the count.
_bazaarThreadPinsLoaded(data) {
  const top = document.querySelector('#thread-panel .thread-panel-header-top');
  if (!top) return;
  let btn = document.getElementById('bz-thread-pins-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'bz-thread-pins-btn';
    btn.type = 'button';
    btn.className = 'icon-btn small';
    btn.innerHTML = '📌<span class="bz-thread-pins-count"></span>';
    btn.addEventListener('click', () => this._bazaarToggleThreadPins());
    top.insertBefore(btn, document.getElementById('thread-panel-pip'));
  }
  btn.title = t('bazaar_thread_pins.title');
  btn.setAttribute('aria-label', t('bazaar_thread_pins.title'));
  this._bazaarThreadPinCount(data && data.pinCount);
  this._bazaarCloseThreadPins();
},

_bazaarThreadPinCount(n) {
  const btn = document.getElementById('bz-thread-pins-btn');
  if (!btn || n == null) return;
  btn.querySelector('.bz-thread-pins-count').textContent = n > 0 ? ` ${n}` : '';
  btn.classList.toggle('bz-has-pins', n > 0);
},

_bazaarThreadPinsOpen() {
  return !!document.getElementById('bz-thread-pins-list');
},

_bazaarCloseThreadPins() {
  document.getElementById('bz-thread-pins-list')?.remove();
},

_bazaarToggleThreadPins() {
  if (this._bazaarThreadPinsOpen()) return this._bazaarCloseThreadPins();
  const header = document.querySelector('#thread-panel .thread-panel-header');
  if (!header) return;
  const list = document.createElement('div');
  list.id = 'bz-thread-pins-list';
  list.className = 'bz-thread-pins-list';
  list.textContent = '…';
  header.querySelector('.thread-panel-header-top').after(list);
  this._bazaarRequestThreadPins();
},

_bazaarRequestThreadPins() {
  if (this._activeThreadParent) this.socket.emit('bazaar:get-thread-pins', { parentId: Number(this._activeThreadParent) });
},

_bazaarRenderThreadPins(pins) {
  const list = document.getElementById('bz-thread-pins-list');
  if (!list) return;
  const canPin = this._bazaarCanPinThread();
  list.innerHTML = `<div class="bz-thread-pins-title">${this._escapeHtml(t('bazaar_thread_pins.title'))}</div>` + (pins.length
    ? pins.map(p => {
      return `<div class="bz-thread-pin${p.nsfw ? ' bz-thread-pin-nsfw' : ''}" data-msg-id="${Number(p.id)}" role="button" tabindex="0">
        <div class="bz-thread-pin-head"><strong>${this._escapeHtml(p.username || '')}</strong>
          <span class="bz-thread-pin-time">${this._escapeHtml(this._fmtDateTime ? this._fmtDateTime(p.created_at) : p.created_at)}</span>
          ${canPin ? `<button type="button" class="bz-thread-unpin" title="${this._escapeHtml(t('msg_toolbar.unpin'))}" aria-label="${this._escapeHtml(t('msg_toolbar.unpin'))}">✕</button>` : ''}</div>
        <div class="thread-msg-content bz-thread-pin-text">${this._formatContent(String(p.content || ''))}</div>
      </div>`;
    }).join('')
    : `<div class="bz-thread-pins-none">${this._escapeHtml(t('bazaar_thread_pins.none'))}</div>`);
  // Pictures load straight away (the list is short), and links get their
  // cards, as in the topic.
  list.querySelectorAll('img[data-lazy-src]').forEach((img) => { img.loading = 'lazy'; img.src = img.dataset.lazySrc; img.removeAttribute('data-lazy-src'); });
  try { this._fetchLinkPreviews(list); } catch { /* the plain link stays */ }
  list.querySelectorAll('.bz-thread-pin').forEach((row) => {
    const id = parseInt(row.dataset.msgId, 10);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.bz-thread-unpin')) { e.stopPropagation(); this.socket.emit('unpin-message', { messageId: id }); return; }
      if (e.target.classList.contains('chat-image') && this._openLightbox) {
        e.stopPropagation();
        this._lightboxContainer = list;
        this._openLightbox(e.target.src, e.target);
        return;
      }
      if (e.target.closest('a, img, video, iframe, .link-preview')) return; // opens the link instead
      this._bazaarJumpToThreadReply(id);
    });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._bazaarJumpToThreadReply(id); });
  });
},

// Jumps to a reply in the open topic. One that is not showing is fetched
// with the replies around it (app-bazaar-thread-pages.js), and the view lands
// on it (_threadJumpToMention).
_bazaarJumpToThreadReply(id) {
  const target = document.querySelector(`#thread-messages [data-msg-id="${id}"]`);
  this._bazaarCloseThreadPins();
  if (target) {
    this._scrollToMessage(target);
    target.classList.remove('highlight-flash');
    void target.offsetWidth;
    target.classList.add('highlight-flash');
    setTimeout(() => target.classList.remove('highlight-flash'), 2000);
    return;
  }
  if (!this._activeThreadParent) return;
  this._threadJumpTarget = id;
  this.socket.emit('get-thread-messages', { parentId: Number(this._activeThreadParent), around: id });
},

_bazaarThreadPinsStyle() {
  if (document.getElementById('bazaar-thread-pins-style')) return;
  const s = document.createElement('style');
  s.id = 'bazaar-thread-pins-style';
  s.textContent = `
    .thread-message.pinned { border-left: 3px solid var(--accent); background: rgba(124, 92, 252, 0.04); }
    #bz-thread-pins-btn.bz-has-pins { color: var(--accent); }
    .bz-thread-pins-count { font-size: 11px; }
    .bz-thread-pins-list { max-height: 45vh; overflow-y: auto; margin: 6px 0; padding: 6px; border: 1px solid var(--border);
      border-radius: 8px; background: var(--bg-tertiary); }
    .bz-thread-pins-title { font-weight: 700; font-size: 12px; color: var(--text-secondary); margin: 0 2px 6px; }
    .bz-thread-pins-none { font-size: 13px; color: var(--text-muted); padding: 4px 2px; }
    .bz-thread-pin { padding: 6px; border-radius: 6px; cursor: pointer; }
    .bz-thread-pin:hover, .bz-thread-pin:focus { background: var(--bg-hover); outline: none; }
    .bz-thread-pin-head { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
    .bz-thread-pin-time { font-size: 11px; color: var(--text-muted); flex: 1; }
    .bz-thread-unpin { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 0 2px; }
    .bz-thread-unpin:hover { color: var(--text-primary); }
    .bz-thread-pin-text { font-size: 13px; color: var(--text-primary); overflow-wrap: anywhere; margin-top: 2px;
      max-height: 220px; overflow: hidden; }
    .bz-thread-pin-text .chat-image { max-width: min(100%, 200px); max-height: 140px; min-height: 0; }
    .bz-thread-pin-text .link-preview { max-width: 100%; transform-origin: top left; }
    .bz-thread-pin-text video, .bz-thread-pin-text iframe { max-width: 100%; max-height: 160px; }
    .bz-thread-pin-nsfw .bz-thread-pin-text img, .bz-thread-pin-nsfw .bz-thread-pin-text .link-preview { filter: blur(14px); }
  `;
  document.head.appendChild(s);
},

};
