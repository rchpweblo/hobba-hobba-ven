// Bizarre Bazaar fork: who is in voice, even when their channel is out of
// sight. While a voice channel with people in it is scrolled out of the
// channel list (or tucked in a collapsed category), a small bubble pinned to
// the top or bottom edge of the list shows their avatars; clicking it opens
// the channel. The server icon carries a speaker badge while anyone is in a
// voice channel.

const MAX_AVATARS = 5;

export default {

_bazaarSetupVoiceBubble() {
  this._bazaarVoiceBubbleStyle();
  const make = (edge) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `bz-vb bz-vb-${edge}`;
    el.style.display = 'none';
    el.addEventListener('click', () => {
      const code = el.dataset.code;
      if (!code) return;
      this.switchChannel(code);
      const item = document.querySelector(`#channel-list .channel-item[data-code="${CSS.escape(code)}"]`);
      if (item && item.offsetParent) item.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    document.body.appendChild(el);
    return el;
  };
  this._bazaarVoiceBubbles = { above: make('above'), below: make('below') };
  const later = () => this._bazaarUpdateVoiceBubble();
  // Capture catches the scroll of whichever pane scrolls the channel list.
  document.addEventListener('scroll', later, true);
  window.addEventListener('resize', later);
  later();
},

_bazaarUpdateVoiceBubble() {
  if (!this._bazaarVoiceBubbles || this._bazaarVoiceBubbleFrame) return;
  this._bazaarVoiceBubbleFrame = requestAnimationFrame(() => {
    this._bazaarVoiceBubbleFrame = null;
    try { this._bazaarDrawVoiceBubble(); } catch (err) { console.warn('[voice bubble]', err); }
  });
},

_bazaarDrawVoiceBubble() {
  const { above, below } = this._bazaarVoiceBubbles;
  const counts = this.voiceCounts || {};
  const byCode = new Map((this.channels || []).map(c => [c.code, c]));
  const live = Object.keys(counts).filter(code => counts[code] > 0 && byCode.get(code) && !byCode.get(code).is_dm);
  document.getElementById('home-server')?.classList.toggle('bz-voice-live', live.length > 0);

  const list = document.getElementById('channel-list');
  const hideAll = () => { above.style.display = 'none'; below.style.display = 'none'; };
  if (!list || !live.length) return hideAll();
  // The part of the list on screen: the list clipped by each pane that scrolls it.
  let box = list.getBoundingClientRect();
  if (!box.width || !box.height || box.right <= 0 || box.left >= window.innerWidth) return hideAll();
  let top = box.top, bottom = box.bottom;
  for (const sel of ['#channels-pane', '.sidebar-split', '.sidebar-mod-container']) {
    const r = list.closest(sel)?.getBoundingClientRect();
    if (r) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
  }
  top = Math.max(top, 0); bottom = Math.min(bottom, window.innerHeight);
  if (bottom - top < 40) return hideAll();

  const groups = { above: [], below: [] };
  for (const code of live) {
    const item = list.querySelector(`.channel-item[data-code="${CSS.escape(code)}"]`);
    if (!item) continue;
    if (!item.offsetParent) { groups.below.push(code); continue; } // in a collapsed category
    const r = item.getBoundingClientRect();
    if (r.bottom <= top + 4) groups.above.push(code);
    else if (r.top >= bottom - 4) groups.below.push(code);
  }
  const mid = box.left + box.width / 2;
  this._bazaarFillVoiceBubble(above, groups.above, byCode, { left: mid, top: top + 6 });
  this._bazaarFillVoiceBubble(below, groups.below, byCode, { left: mid, bottom: window.innerHeight - bottom + 6 });
},

_bazaarFillVoiceBubble(el, codes, byCode, pos) {
  if (!codes.length) { el.style.display = 'none'; el.dataset.code = ''; return; }
  const seen = new Set();
  const people = [];
  const lines = [];
  for (const code of codes) {
    const users = (this.voiceChannelUsers && this.voiceChannelUsers[code]) || [];
    lines.push(`#${byCode.get(code).name}: ${users.map(u => u.username).join(', ')}`);
    for (const u of users) if (!seen.has(u.id)) { seen.add(u.id); people.push(u); }
  }
  const online = new Map((this._lastOnlineUsers || []).map(u => [u.id, u]));
  const faces = people.slice(0, MAX_AVATARS).map(u => {
    const info = online.get(u.id) || {};
    const name = info.username || u.username || '?';
    const initial = this._escapeHtml(name.charAt(0).toUpperCase());
    return info.avatar
      ? `<img class="bz-vb-av" src="${this._escapeHtml(info.avatar)}" alt="${initial}">`
      : `<span class="bz-vb-av" style="background-color:${this._getUserColor(name)}">${initial}</span>`;
  }).join('');
  const more = people.length > MAX_AVATARS ? `<span class="bz-vb-more">+${people.length - MAX_AVATARS}</span>` : '';
  const label = codes.length === 1
    ? `#${this._escapeHtml(byCode.get(codes[0]).name)}`
    : this._escapeHtml(t('bazaar_voice_bubble.channels', { count: codes.length }));
  el.innerHTML = `<span class="bz-vb-arrow">${el.classList.contains('bz-vb-above') ? '▲' : '▼'}</span><span class="bz-vb-icon">🔊</span><span class="bz-vb-faces">${faces}${more}</span><span class="bz-vb-label">${label}</span>`;
  el.title = lines.join('\n');
  el.setAttribute('aria-label', `${t('bazaar_voice_bubble.title')}: ${lines.join('; ')}`);
  el.dataset.code = codes[0];
  el.style.left = `${pos.left}px`;
  el.style.top = pos.top != null ? `${pos.top}px` : '';
  el.style.bottom = pos.bottom != null ? `${pos.bottom}px` : '';
  el.style.display = '';
  // Kept inside the list's width.
  const width = document.getElementById('channel-list').getBoundingClientRect().width - 12;
  el.style.maxWidth = `${Math.max(width, 80)}px`;
},

_bazaarVoiceBubbleStyle() {
  if (document.getElementById('bazaar-voice-bubble-style')) return;
  const s = document.createElement('style');
  s.id = 'bazaar-voice-bubble-style';
  s.textContent = `
    .bz-vb { position:fixed; z-index:60; transform:translateX(-50%); display:flex; align-items:center; gap:6px;
      padding:3px 10px 3px 6px; border-radius:999px; border:1px solid var(--border); background:var(--bg-tertiary);
      color:var(--text-primary); font:inherit; font-size:12px; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.35);
      white-space:nowrap; overflow:hidden; }
    .bz-vb:hover { background:var(--bg-hover); border-color:var(--accent); }
    .bz-vb-arrow { font-size:9px; color:var(--text-muted); }
    .bz-vb-icon { font-size:12px; }
    .bz-vb-faces { display:flex; align-items:center; }
    .bz-vb-av { width:20px; height:20px; border-radius:50%; object-fit:cover; margin-left:-5px; border:2px solid var(--bg-tertiary);
      display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:#fff; flex-shrink:0; }
    .bz-vb-av:first-child { margin-left:0; }
    .bz-vb-more { margin-left:3px; font-size:11px; color:var(--text-secondary); }
    .bz-vb-label { overflow:hidden; text-overflow:ellipsis; color:var(--text-secondary); }
    #home-server.bz-voice-live::after { content:'🔊'; position:absolute; right:-4px; bottom:-4px; font-size:11px; line-height:1;
      padding:2px; border-radius:50%; background:var(--bg-primary); box-shadow:0 0 0 2px var(--bg-primary); pointer-events:none; }
  `;
  document.head.appendChild(s);
},

};
