// Bizarre Bazaar fork: a reply in a thread or forum topic gets the same
// right-click menu as a message in the channel (_showMessageContextMenu in
// app-message-tools.js), with the actions that make sense for a reply:
// edit, reply, quote, pin, react, copy the link to it, protect, edit tags,
// mark NSFW, mark as official, delete. Right-clicking the author's name or
// picture opens the user menu, as in the channel. Not here: Thread (a reply
// has none) and Select messages to move. Edit role menu cannot come up: the
// server never lets a role menu into a thread.
//
// Also here, so replies match channel messages:
// - a protected reply shows the shield and loses Delete, at load and live;
// - an official reply shows its role's colour and badge, at load and live;
// - a link to a reply (?channel=…&message=…) opens its thread at the reply.
//   Server side: bazaar:locate-message in src/socketHandlers/messages.js.

export default {

_bazaarSetupThreadMenu() {
  const box = document.getElementById('thread-messages');
  if (box) box.addEventListener('contextmenu', (e) => {
    // Pictures have their own menu (app-message-actions.js); videos, audio
    // and the edit box keep the browser's.
    if (e.target.closest('.chat-image, video, audio, .edit-textarea')) return;
    if (this._moveSelectionActive) return;
    const msgEl = e.target.closest('.thread-message');
    if (!msgEl || !msgEl.dataset.msgId) return;
    // The author's name or picture: the user menu. A grouped row's time sits
    // in a spacer that shares the picture's class, and is not the author.
    const author = e.target.closest('.thread-msg-author, .thread-msg-avatar');
    if (author && !author.classList.contains('thread-msg-compact-spacer') && !e.target.closest('.thread-msg-toolbar')) {
      const userId = parseInt(msgEl.dataset.userId, 10);
      if (!isNaN(userId) && (userId !== this.user.id || this.user.isAdmin)) {
        e.preventDefault();
        this._showUserContextMenu(e, userId, msgEl.dataset.username);
        return;
      }
    }
    // Selected text keeps the browser's menu, for copying.
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && msgEl.contains(sel.anchorNode)) return;
    e.preventDefault();
    this._bazaarShowThreadMenu(e, msgEl);
  });

  const copies = (id) => document.querySelectorAll(`#thread-messages .thread-message[data-msg-id="${Number(id)}"]`);
  this.socket.on('message-archived', (d) => { if (d) copies(d.messageId).forEach(el => this._bazaarMarkThreadProtect(el, true)); });
  this.socket.on('message-unarchived', (d) => { if (d) copies(d.messageId).forEach(el => this._bazaarMarkThreadProtect(el, false)); });
  this.socket.on('message-highlight', (d) => { if (d) copies(d.messageId).forEach(el => this._bazaarMarkThreadOfficial(el, d.highlight || null)); });
  this._bazaarThreadMenuStyle();
},

// Called by _appendThreadMessage before the reply goes in, so grouping with
// the next reply sees an official mark.
_bazaarDressThreadReply(el, msg) {
  if (msg.is_webhook) el.dataset.bzWebhook = '1';
  if (msg.is_archived) this._bazaarMarkThreadProtect(el, true);
  if (msg.highlight) this._bazaarMarkThreadOfficial(el, msg.highlight);
},

// The shield after the time (in the text on a grouped row), and no Delete:
// nobody can delete a protected message until it is unprotected.
_bazaarMarkThreadProtect(el, on) {
  el.classList.toggle('archived', on);
  if (on) el.dataset.archived = '1'; else delete el.dataset.archived;
  el.querySelectorAll('.archived-tag').forEach(tag => tag.remove());
  if (on) {
    const tag = `<span class="archived-tag" title="${this._escapeHtml(t('app.messages.protected'))}">🛡️</span>`;
    const time = el.querySelector('.thread-msg-header .thread-msg-time');
    if (time) time.insertAdjacentHTML('afterend', tag);
    else el.querySelector('.thread-msg-content')?.insertAdjacentHTML('afterbegin', tag + ' ');
  }
  el.querySelectorAll('[data-thread-action="delete"]').forEach(btn => { btn.style.display = on ? 'none' : ''; });
},

// The channel's mark (app-message-highlights.js), with the badge where a
// reply has its time, or at the start of the text on a grouped row.
_bazaarMarkThreadOfficial(el, h) {
  this._applyMessageHighlight(el, h);
  if (!h || el.querySelector('.msg-highlight-badge')) return;
  const badge = this._highlightBadgeHtml(h);
  const time = el.querySelector('.thread-msg-header .thread-msg-time');
  if (time) time.insertAdjacentHTML('beforebegin', badge);
  else el.querySelector('.thread-msg-content')?.insertAdjacentHTML('afterbegin', badge + ' ');
},

_bazaarShowThreadMenu(e, msgEl) {
  this._hideMessageContextMenu();
  const msgId = parseInt(msgEl.dataset.msgId, 10);
  if (!msgId) return;
  // A thread is always in the open channel: switching channels closes it.
  const code = this.currentChannel;
  const admin = !!this.user?.isAdmin;
  const isOwn = String(msgEl.dataset.userId) === String(this.user?.id);
  const isPinned = msgEl.dataset.pinned === '1';
  const isArchived = msgEl.dataset.archived === '1';
  const isHighlighted = msgEl.dataset.highlighted === '1';
  const postBlocked = !!this._channelBlocksPosting?.(code);
  const canArchive = admin || this._hasPerm('archive_messages');
  const canDelete = isOwn || admin || this._canModerate() || this._hasPerm('delete_message');
  const hasAttachment = (this._getMessageAttachments?.(msgId) || []).length > 0;
  const canEditTags = hasAttachment && (isOwn || admin || this._hasPerm('manage_tags'));
  const isPlainOwn = isOwn && !msgEl.dataset.personaId && !msgEl.dataset.bzWebhook;

  const item = (action, icon, label, danger) =>
    `<button class="channel-ctx-item${danger ? ' danger' : ''}" data-action="${action}">${icon} <span>${label}</span></button>`;
  const sep = '<hr class="channel-ctx-sep">';
  const items = [];
  const link = e.target?.closest?.('a[href]');
  const linkHref = link && /^https?:/i.test(link.href) ? link.href : null;
  if (linkHref) items.push(item('copy-href', '🔗', t('msg_toolbar.copy_link_address')), sep);
  if (isOwn && !isArchived) items.push(item('edit', '✏️', t('msg_toolbar.edit')));
  if (!postBlocked) items.push(item('reply', '↩️', t('msg_toolbar.reply')), item('quote', '💬', t('msg_toolbar.quote')));
  if (this._bazaarCanPinThread?.()) items.push(isPinned ? item('unpin', '📌', t('msg_toolbar.unpin')) : item('pin', '📌', t('msg_toolbar.pin')));
  items.push(sep, item('react', '😀', t('msg_toolbar.react')));
  if (this._canShareChannelLink?.(code)) items.push(item('copy-link', '🔗', t('msg_toolbar.copy_link')));
  if (canArchive) items.push(isArchived ? item('unarchive', '🛡️', t('app.messages.unprotect_btn')) : item('archive', '🛡️', t('app.messages.protect_btn')));
  if (canEditTags) items.push(item('edit-tags', '🏷️', t('tags.edit')));
  if (this._canSetMessageNsfw?.(msgEl, false)) items.push(this._messageNsfwMenuHtml(msgEl.dataset.nsfw === '1'));
  if (!isHighlighted && isPlainOwn && this._canHighlightMessages?.()) items.push(item('highlight-on', '📣', t('msg_toolbar.highlight_on')));
  else if (isHighlighted && (isOwn || canDelete)) items.push(item('highlight-off', '📣', t('msg_toolbar.highlight_off')));
  if (canDelete && !isArchived) items.push(sep, item('delete', '🗑️', t('msg_toolbar.delete'), true));

  const menu = document.createElement('div');
  menu.id = 'message-context-menu';
  menu.className = 'channel-ctx-menu';
  menu.innerHTML = items.join('');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    this._hideMessageContextMenu();
    if (action === 'edit') this._startEditMessage(msgEl, msgId);
    else if (action === 'reply') this._setThreadReply(msgEl, msgId);
    else if (action === 'quote') this._quoteThreadMessage(msgEl);
    else if (action === 'pin' || action === 'unpin') this._bazaarThreadPinAction(msgId, action);
    else if (action === 'react') this._showReactionPicker(msgEl, msgId);
    else if (action === 'copy-href') {
      const onCopied = () => this._showToast(t('toasts.link_address_copied'), 'success');
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(linkHref).then(onCopied).catch(() => this._copyTextFallback(linkHref, onCopied));
      else this._copyTextFallback(linkHref, onCopied);
    } else if (action === 'copy-link') this._copyChannelLink(code, msgId);
    else if (action === 'archive') this.socket.emit('archive-message', { messageId: msgId });
    else if (action === 'unarchive') this.socket.emit('unarchive-message', { messageId: msgId });
    else if (action === 'edit-tags') this._openMessageTagEditor(msgId, msgEl);
    else if (action === 'nsfw' || action === 'unnsfw') this._setMessageNsfw(msgId, action === 'nsfw');
    else if (action === 'highlight-on' || action === 'highlight-off') this.socket.emit('set-message-highlight', { messageId: msgId, on: action === 'highlight-on' });
    else if (action === 'delete') {
      if (await this._showConfirmModal(t('confirm.delete_message'), '', { danger: true, confirmLabel: t('msg_toolbar.delete') })) {
        this.socket.emit('delete-message', { messageId: msgId, attachments: this._getMessageAttachments?.(msgId) });
      }
    }
  });

  // Closes as the channel's menu does, and when the thread scrolls.
  const closer = (ev) => {
    if (ev && ev.type !== 'scroll' && menu.contains(ev.target)) return;
    this._hideMessageContextMenu();
  };
  this._msgCtxCloser = closer;
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('contextmenu', closer, true);
    document.getElementById('thread-messages')?.addEventListener('scroll', () => {
      if (document.getElementById('message-context-menu') === menu) this._hideMessageContextMenu();
    }, { capture: true, once: true });
  }, 0);
},

// From _jumpToMessage, for a message not showing in the channel. A reply
// opens its thread at the reply: the thread starts on the replies around it
// (_openThread with _threadJumpTarget). Anything else goes back to the
// channel's own jump.
_bazaarJumpToReply(msgId) {
  const id = Number(msgId);
  if (document.querySelector(`#thread-messages .thread-message[data-msg-id="${id}"]`)) return this._bazaarJumpToThreadReply(id);
  this.socket.timeout(5000).emit('bazaar:locate-message', { messageId: id }, (err, res) => {
    const parentId = !err && res && res.code === this.currentChannel ? Number(res.parentId) : 0;
    if (!parentId) return this._jumpToMessage(id, true);
    const panel = document.getElementById('thread-panel');
    if (panel && panel.style.display !== 'none' && Number(this._activeThreadParent) === parentId) return this._bazaarJumpToThreadReply(id);
    // The thread's header is read from its first message, so that goes on
    // screen first (as the Threads list does).
    this._jumpToMessage(parentId, true);
    setTimeout(() => {
      this._threadJumpTarget = id;
      this._openThread(parentId);
    }, 150);
  });
},

_bazaarThreadMenuStyle() {
  if (document.getElementById('bazaar-thread-menu-style')) return;
  const s = document.createElement('style');
  s.id = 'bazaar-thread-menu-style';
  s.textContent = `
    .thread-message.archived { border-left: 3px solid #27ae60; background: rgba(39, 174, 96, 0.04); }
    .thread-message.message-highlighted {
      box-shadow: inset 3px 0 0 var(--hl-color, var(--accent));
      background: color-mix(in srgb, var(--hl-color, var(--accent)) 9%, transparent);
    }
    :root[data-official-style="off"] .thread-message.message-highlighted { box-shadow: none; background: none; }
    :root[data-official-style="text"] .thread-message.message-highlighted {
      box-shadow: inset 2px 0 0 color-mix(in srgb, var(--hl-color, var(--accent)) 75%, transparent);
      background: color-mix(in srgb, var(--hl-color, var(--accent)) 7%, transparent);
    }
    :root[data-official-style="text"] .thread-message.message-highlighted .thread-msg-content {
      color: color-mix(in srgb, var(--hl-color, var(--accent)) var(--hl-text-mix, 60%), var(--text-primary)) !important;
    }
  `;
  document.head.appendChild(s);
},

};
