// Bizarre Bazaar fork: the Role Bot (src/bazaarRoleBot.js). A first-login
// pop-up and a Settings → Connections row both start the Discord link; the
// link itself runs in a window, like Steam and Spotify links do.

export default {

// Loads whether linking is set up and done, then calls back. The pop-up queue
// waits for this; with no answer in 3 s it treats linking as not set up.
_bazaarSetupRoleBot(done) {
  this._bazaarLoadDiscordRefs(); // names for Discord codes in copied history
  if (!this._bazaarRoleBotWired) {
    this._bazaarRoleBotWired = true;
    this.socket.on('bazaar-role-bot-result', (r) => {
      this._bazaarLink = { ...(this._bazaarLink || {}), configured: true, linked: r.source !== 'none', discordUsername: r.discordUsername, given: r.given || [] };
      this._bazaarRenderLinkRow();
      const n = (r.given || []).length;
      this._showToast(n ? t('bazaar_role_bot.result_toast', { count: n }) : t('bazaar_role_bot.result_none'), n ? 'success' : 'info');
    });
    const modal = document.getElementById('bazaar-discord-modal');
    document.getElementById('bazaar-discord-link-now')?.addEventListener('click', () => {
      this._bazaarStartLink();
      if (modal) modal.style.display = 'none';
    });
    document.getElementById('bazaar-discord-later')?.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });
  }
  let finished = false;
  const finish = (state) => {
    if (finished) return;
    finished = true;
    this._bazaarLink = state && typeof state === 'object' ? state : { configured: false, linked: false };
    this._bazaarRenderLinkRow();
    if (typeof done === 'function') done();
  };
  const timer = setTimeout(() => finish(null), 3000);
  this.socket.emit('bazaar-discord-link-state', {}, (state) => { clearTimeout(timer); finish(state); });
},

_bazaarShouldShowPopup() {
  return !!(this._bazaarLink && this._bazaarLink.configured && !this._bazaarLink.linked && !this.user?.isGuest);
},

_bazaarStartLink() {
  // Open the window inside the click, so a popup blocker lets it through;
  // the connect-token handler then loads the link into this same window.
  try { window.open('', 'haven-connect', 'width=820,height=760,menubar=no,toolbar=no'); } catch { /* blocked: the handler's own toast explains */ }
  this.socket.emit('bazaar-discord-link-start');
},

_bazaarRenderLinkRow() {
  const box = document.getElementById('bazaar-discord-connection');
  if (!box) return;
  const s = this._bazaarLink || {};
  box.style.display = s.configured && !this.user?.isGuest ? '' : 'none';
  if (!s.configured) return;
  if (s.linked) {
    box.innerHTML = `<div class="toggle-row"><span>🤖 <b>Discord</b> · ${this._escapeHtml(t('bazaar_role_bot.linked_as', { name: s.discordUsername || '' }))}</span></div>`;
    return;
  }
  box.innerHTML = `<div class="toggle-row"><span>🤖 <b>Discord</b> · ${this._escapeHtml(t('bazaar_role_bot.row_hint'))}</span>
    <button type="button" class="btn-sm btn-accent" id="bazaar-discord-row-link">${this._escapeHtml(t('bazaar_role_bot.link_now'))}</button></div>`;
  box.querySelector('#bazaar-discord-row-link')?.addEventListener('click', () => this._bazaarStartLink());
},

};
