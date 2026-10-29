// Bizarre Bazaar fork: Discord's <@id>, <@&id> and <#id> in history copied
// from Discord, shown as names (src/bazaarDiscordRefs.js). The messages keep
// the codes; _formatContent asks _bazaarDiscordRefHtml for each one. Nothing
// here pings anyone.

export default {

// Loads the names once after login, then draws the open channel again if it
// has codes in it.
_bazaarLoadDiscordRefs() {
  this.socket.emit('bazaar-discord-refs', {}, (refs) => {
    if (!refs || typeof refs !== 'object') return;
    this._bazaarDiscordRefs = { users: refs.users || {}, roles: refs.roles || {}, channels: refs.channels || {} };
    const msgs = this._lastRenderedMessages;
    if (Array.isArray(msgs) && msgs.some(m => m && typeof m.content === 'string' && /<(?:@[!&]?|#)\d/.test(m.content))) {
      try { this._renderMessages(msgs, this._lastRenderedReadId); } catch (err) { console.warn('[discord-refs] re-render failed', err); }
    }
  });
},

// The HTML for one code, or null to leave it as typed (names not loaded yet).
_bazaarDiscordRefHtml(kind, id) {
  const refs = this._bazaarDiscordRefs;
  if (!refs) return null;
  const tip = ` title="${this._escapeHtml(t('bazaar_discord_refs.from_discord'))}"`;
  if (kind === 'user') {
    const u = refs.users[id];
    const nick = u && u.userId && this._nicknames ? this._nicknames[u.userId] : null;
    const name = nick || (u && u.name) || t('bazaar_discord_refs.unknown_user');
    const self = !!(u && u.userId && this.user && u.userId === this.user.id);
    return `<span class="mention${self ? ' mention-self' : ''}"${tip}>@${this._escapeHtml(name)}</span>`;
  }
  if (kind === 'role') {
    const r = refs.roles[id];
    if (!r) return `<span class="mention mention-role"${tip}>@${this._escapeHtml(t('bazaar_discord_refs.deleted_role'))}</span>`;
    const mine = !!r.roleId && ((this.user && this.user.roles) || []).some(x => x && x.id === r.roleId);
    const color = this._safeColor(r.color);
    const style = color ? ` style="--role-color:${color}"` : '';
    return `<span class="mention mention-role${mine ? ' mention-self' : ''}"${style}${tip}>${this._roleNameHtml(r, '@' + r.name)}</span>`;
  }
  const c = refs.channels[id];
  if (c && c.channelId) {
    const ch = (this.channels || []).find(x => x && x.id === c.channelId && !x.is_dm);
    if (ch) return `<span class="channel-link" data-channel-code="${this._escapeHtml(ch.code)}">#${this._escapeHtml(String(ch.name).replace(/\s+/g, '_'))}</span>`;
    return `<span class="muted-text"${tip}>#${this._escapeHtml(t('bazaar_discord_refs.no_access'))}</span>`;
  }
  const name = (c && c.name) || t('bazaar_discord_refs.unknown_channel');
  return `<span class="muted-text"${tip}>#${this._escapeHtml(name)}</span>`;
},

};
