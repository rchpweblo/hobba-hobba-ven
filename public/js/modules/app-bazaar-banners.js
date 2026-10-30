// Bizarre Bazaar fork: banner messages. A channel, or a forum post, can have
// one message hanging at the top, above the messages: right-click the
// channel (or the post) → 📜 Set Banner Message. The message list gives up
// the banner's height and scrolls beneath it. Anyone can fold a banner down
// to a slim strip; that sticks on this device until the banner is changed.
// A long banner stops at about 40% of the screen and scrolls inside itself.
// Server side: src/bazaarBanners.js and src/socketHandlers/bazaarBanners.js.

const FOLD_KEY = 'haven_bz_banner_folded';

export default {

_bazaarSetupBanners() {
  this._bazaarBannerState = { channel: null, topic: null };
  this.socket.on('bazaar:banner', (data) => {
    if (!data || data.code !== this.currentChannel) return;
    if (data.topicId == null) {
      const prev = this._bazaarBannerState.channel;
      const canSet = data.canSet !== undefined ? !!data.canSet : !!(prev && prev.code === data.code && prev.canSet);
      this._bazaarBannerState.channel = { code: data.code, banner: data.banner || null, canSet };
      this._bazaarPaintBanner('channel');
    } else if (Number(data.topicId) === Number(this._activeThreadParent)) {
      const prev = this._bazaarBannerState.topic;
      const canSet = data.canSet !== undefined ? !!data.canSet : !!(prev && prev.topicId === Number(data.topicId) && prev.canSet);
      this._bazaarBannerState.topic = { code: data.code, topicId: Number(data.topicId), banner: data.banner || null, canSet };
      this._bazaarPaintBanner('topic');
    }
  });
  // The channel menu's item (app.html), shown by _bazaarBannerMenuItem.
  document.querySelector('#channel-ctx-menu [data-action="bz-banner"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    this._closeChannelCtxMenu?.();
    if (code) this._bazaarOpenBannerForm(code, null);
  });
  this._bazaarBannerStyle();
  if (this.currentChannel) this._bazaarBannerChannelSwitch(this.currentChannel);
},

// Entering a channel: the last one's banner goes at once, and this one's is asked for.
_bazaarBannerChannelSwitch(code) {
  if (!this._bazaarBannerState) return; // before setup: the first channel asks once it is ready
  this._bazaarBannerState.channel = null;
  this._bazaarPaintBanner('channel');
  const ch = this.channels?.find(c => c.code === code);
  if (ch && !ch.is_dm) this.socket.emit('bazaar:get-banner', { code });
},

// A thread finished loading: a forum post's banner is asked for (a chat
// thread never has one, and the server does not answer for it). Pages of
// the same post keep the banner that is showing.
_bazaarBannerThreadLoaded(data) {
  if (!this._bazaarBannerState) return;
  const id = Number(data && data.parentId);
  const cur = this._bazaarBannerState.topic;
  if (cur && cur.topicId === id) return;
  this._bazaarBannerState.topic = null;
  this._bazaarPaintBanner('topic');
  if (id && this._forumActive) this.socket.emit('bazaar:get-banner', { code: this.currentChannel, topicId: id });
},

// Channel menu: for whoever manages the channel's settings.
_bazaarBannerMenuItem(menu, ch) {
  const btn = menu.querySelector('[data-action="bz-banner"]');
  if (!btn) return;
  btn.style.display = ch && !ch.is_dm && (this.user?.isAdmin || ch.canManageSettings) ? '' : 'none';
},

// Forum post menu: also for the person who started the post.
_bazaarCanSetTopicBanner(msg) {
  const ch = this.channels?.find(c => c.code === this.currentChannel);
  return !!(this.user && (this.user.isAdmin || (ch && ch.canManageSettings) || msg.user_id === this.user.id));
},

_bazaarFetchBanner(code, topicId) {
  return new Promise((resolve) => {
    const done = (data) => {
      if (!data || data.code !== code || (data.topicId == null ? null : Number(data.topicId)) !== (topicId == null ? null : Number(topicId))) return;
      clearTimeout(timer);
      this.socket.off('bazaar:banner', done);
      resolve(data.banner || null);
    };
    const timer = setTimeout(() => { this.socket.off('bazaar:banner', done); resolve(null); }, 5000);
    this.socket.on('bazaar:banner', done);
    this.socket.emit('bazaar:get-banner', topicId == null ? { code } : { code, topicId });
  });
},

// The Set Banner Message window: like Edit post (app-forum.js), with a title
// that may be left empty, the message, its pictures and files, and the blur.
async _bazaarOpenBannerForm(code, topicId) {
  if (document.getElementById('bz-banner-modal')) return;
  const existing = await this._bazaarFetchBanner(code, topicId);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'bz-banner-modal';
  overlay.innerHTML = `
    <div class="modal forum-post-modal">
      <div class="modal-header forum-modal-header"><h3>📜 ${t('bazaar_banner.set')}</h3><button class="modal-close" type="button">&times;</button></div>
      <div class="modal-body">
        <small class="settings-hint">${t(topicId == null ? 'bazaar_banner.hint_channel' : 'bazaar_banner.hint_topic')}</small>
        <label class="forum-field"><span>${t('bazaar_banner.title')}</span><input type="text" id="bz-banner-title" maxlength="120" placeholder="${t('bazaar_banner.title_placeholder')}" value="${this._escapeHtml(existing ? existing.title : '')}"></label>
        <label class="forum-field"><span>${t('bazaar_banner.body')}</span><textarea id="bz-banner-body" rows="7" maxlength="4000">${this._escapeHtml(existing ? existing.body : '')}</textarea></label>
        <div class="forum-attach-row"><button type="button" class="btn-sm forum-attach-btn" id="bz-banner-attach">📎 ${t('forum.attach_file')}</button><input type="file" id="bz-banner-file" multiple hidden><small class="settings-hint">${t('forum.attach_hint_inline')}</small></div>
        <div class="forum-thumb-preview" id="bz-banner-thumbs"></div>
        <label class="forum-field forum-field-closed forum-field-nsfw"><span><input type="checkbox" id="bz-banner-nsfw"${existing && existing.nsfw ? ' checked' : ''}> 🔞 ${t('bazaar_banner.nsfw')}</span></label>
      </div>
      <div class="modal-footer">${existing ? `<button type="button" class="btn-sm btn-danger forum-post-delete" id="bz-banner-remove">🗑️ ${t('bazaar_banner.remove')}</button>` : ''}<button type="button" class="btn-sm" id="bz-banner-cancel">${t('modals.common.cancel')}</button><button type="button" class="btn-sm btn-accent" id="bz-banner-save">${t('modals.common.save')}</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('#bz-banner-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const where = topicId == null ? { code } : { code, topicId };
  const titleEl = overlay.querySelector('#bz-banner-title');
  const bodyEl = overlay.querySelector('#bz-banner-body');
  const fileInput = overlay.querySelector('#bz-banner-file');
  const thumbs = overlay.querySelector('#bz-banner-thumbs');
  const paintThumbs = () => this._forumComposerThumbs?.(bodyEl.value, thumbs);
  bodyEl.addEventListener('input', paintThumbs);
  paintThumbs();
  overlay.querySelector('#bz-banner-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { this._forumUploadIntoBody(fileInput.files, bodyEl, code); fileInput.value = ''; });
  bodyEl.addEventListener('paste', (e) => {
    if (this._pasteIsLinkWithPreview?.(e)) return;
    const files = Array.from(e.clipboardData?.items || []).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    this._forumUploadIntoBody(files, bodyEl, code);
  });
  const modalEl = overlay.querySelector('.forum-post-modal');
  modalEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); modalEl.classList.add('drag-over'); } });
  modalEl.addEventListener('dragleave', (e) => { if (!modalEl.contains(e.relatedTarget)) modalEl.classList.remove('drag-over'); });
  modalEl.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    modalEl.classList.remove('drag-over');
    this._forumUploadIntoBody(e.dataTransfer.files, bodyEl, code);
  });
  const after = (res) => {
    if (res && res.error) { this._showToast(res.error, 'error'); return; }
    close();
  };
  overlay.querySelector('#bz-banner-remove')?.addEventListener('click', async () => {
    if (!await this._showConfirmModal(t('bazaar_banner.remove_confirm'), '', { danger: true, confirmLabel: t('bazaar_banner.remove') })) return;
    this.socket.emit('bazaar:clear-banner', where, after);
  });
  overlay.querySelector('#bz-banner-save').addEventListener('click', () => {
    if (Number(bodyEl.dataset.uploading) > 0) { this._showToast(t('forum.wait_upload'), 'info'); return; }
    const body = bodyEl.value.trim();
    if (!body) { this._showToast(t('bazaar_banner.need_body'), 'error'); bodyEl.focus(); return; }
    this.socket.emit('bazaar:set-banner', { ...where, title: titleEl.value.trim(), body, nsfw: overlay.querySelector('#bz-banner-nsfw').checked }, after);
  });
  (existing ? bodyEl : titleEl).focus();
},

// ── Showing it ─────────────────────────────────────────────

_bazaarFolded() {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch { return {}; }
},

// Folded stays folded until the banner changes.
_bazaarIsFolded(key, banner) {
  return this._bazaarFolded()[key] === banner.updatedAt;
},

_bazaarSetFolded(key, banner, folded) {
  const all = this._bazaarFolded();
  if (folded) all[key] = banner.updatedAt; else delete all[key];
  const keys = Object.keys(all);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete all[k];
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(all)); } catch { /* private window: folds for this visit only */ }
},

_bazaarPaintBanner(kind) {
  const id = kind === 'channel' ? 'bz-banner-channel' : 'bz-banner-topic';
  const state = this._bazaarBannerState[kind];
  let el = document.getElementById(id);
  if (!state || !state.banner) { el?.remove(); return; }
  const anchor = document.getElementById(kind === 'channel' ? 'messages' : 'thread-messages');
  if (!anchor) return;
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'bz-banner';
  }
  if (el.nextElementSibling !== anchor) anchor.parentNode.insertBefore(el, anchor);
  const b = state.banner;
  const key = kind === 'channel' ? `c:${state.code}` : `t:${state.topicId}`;
  const folded = this._bazaarIsFolded(key, b);
  const heading = b.title || (folded ? String(b.body).split('\n').find(l => l.trim() && !/^\/uploads\//.test(l.trim())) || '' : '');
  el.classList.toggle('bz-banner-folded', folded);
  el.classList.toggle('bz-banner-nsfw', !!b.nsfw);
  el.innerHTML = `
    <div class="bz-banner-head">
      <span class="bz-banner-icon" aria-hidden="true">📜</span>
      <span class="bz-banner-title">${this._escapeHtml(heading || t('bazaar_banner.label'))}</span>
      ${state.canSet ? `<button type="button" class="bz-banner-btn bz-banner-edit" title="${this._escapeHtml(t('bazaar_banner.edit'))}" aria-label="${this._escapeHtml(t('bazaar_banner.edit'))}">✏️</button>` : ''}
      <button type="button" class="bz-banner-btn bz-banner-fold" aria-expanded="${!folded}" title="${this._escapeHtml(t(folded ? 'bazaar_banner.unfold' : 'bazaar_banner.fold'))}" aria-label="${this._escapeHtml(t(folded ? 'bazaar_banner.unfold' : 'bazaar_banner.fold'))}">${folded ? '▸' : '▾'}</button>
    </div>
    ${folded ? '' : `<div class="bz-banner-body thread-msg-content">${this._formatContent(String(b.body || ''))}</div>
      ${b.nsfw ? `<button type="button" class="bz-banner-reveal">🔞 ${this._escapeHtml(t('bazaar_banner.reveal'))}</button>` : ''}`}`;
  el.querySelector('.bz-banner-fold').addEventListener('click', () => { this._bazaarSetFolded(key, b, !folded); this._bazaarPaintBanner(kind); });
  el.querySelector('.bz-banner-head').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) { this._bazaarSetFolded(key, b, !folded); this._bazaarPaintBanner(kind); } });
  el.querySelector('.bz-banner-edit')?.addEventListener('click', () => this._bazaarOpenBannerForm(state.code, kind === 'channel' ? null : state.topicId));
  el.querySelector('.bz-banner-reveal')?.addEventListener('click', (e) => { el.classList.remove('bz-banner-nsfw'); e.currentTarget.remove(); });
  const body = el.querySelector('.bz-banner-body');
  if (!body) return;
  body.querySelectorAll('img[data-lazy-src]').forEach((img) => { img.src = img.dataset.lazySrc; img.removeAttribute('data-lazy-src'); });
  try { this._fetchLinkPreviews(body); } catch { /* the plain link stays */ }
  body.addEventListener('click', (e) => {
    if (el.classList.contains('bz-banner-nsfw')) { e.preventDefault(); return; }
    if (e.target.classList.contains('chat-image') && this._openLightbox) {
      e.stopPropagation();
      this._lightboxContainer = body;
      this._openLightbox(e.target.src, e.target);
    }
  });
},

_bazaarBannerStyle() {
  if (document.getElementById('bazaar-banner-style')) return;
  const s = document.createElement('style');
  s.id = 'bazaar-banner-style';
  s.textContent = `
    .bz-banner { flex-shrink: 0; position: relative; z-index: 2; display: flex; flex-direction: column; max-height: 40vh;
      margin: 0; padding: 8px 14px 10px; background: var(--bg-secondary); border-bottom: 1px solid var(--border);
      border-left: 3px solid var(--accent); box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18); }
    .bz-banner-folded { padding-top: 4px; padding-bottom: 4px; }
    .bz-banner-head { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; }
    .bz-banner-title { flex: 1; min-width: 0; font-weight: 700; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bz-banner-folded .bz-banner-title { font-weight: 600; color: var(--text-secondary); }
    .bz-banner-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 4px; line-height: 1; }
    .bz-banner-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
    .bz-banner-body { margin-top: 6px; overflow-y: auto; min-height: 0; font-size: 14px; color: var(--text-primary); overflow-wrap: anywhere; }
    .bz-banner-body .chat-image { max-width: min(100%, 34.375rem); max-height: 18rem; }
    .bz-banner-nsfw .bz-banner-body img, .bz-banner-nsfw .bz-banner-body video, .bz-banner-nsfw .bz-banner-body .link-preview { filter: blur(18px); }
    .bz-banner-reveal { align-self: flex-start; margin-top: 6px; font-size: 12px; background: var(--bg-tertiary); border: 1px solid var(--border);
      color: var(--text-secondary); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    .thread-panel .bz-banner { padding: 6px 10px 8px; max-height: 35vh; }
  `;
  document.head.appendChild(s);
},

};
