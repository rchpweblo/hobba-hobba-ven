// Bizarre Bazaar fork: scheduled events (src/bazaarEvents.js). The Events
// section sits above Join a Channel; an event opens in its own window with
// Interested, Join, Start, End, Edit, Skip and Cancel; people Interested get a
// pop-up with a Join button when it starts.

const T = (key, params) => t(`bazaar_events.${key}`, params);
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NTH = ['first', 'second', 'third', 'fourth', 'last'];
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);
const fmtWhen = (ms) => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
const fmtTime = (ms) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

export default {

_bazaarSetupEvents() {
  this._bazaarEvents = [];
  this._bazaarEventCreate = { channels: [], elsewhere: false };
  this._bazaarEventsStyle();

  const body = document.getElementById('bazaar-events-body');
  const arrow = document.getElementById('bazaar-events-arrow');
  let collapsed = false;
  try { collapsed = localStorage.getItem('haven_bazaar_events_collapsed') === '1'; } catch { /* storage blocked */ }
  if (collapsed) { body?.classList.add('collapsed'); arrow?.classList.add('collapsed'); }
  document.getElementById('bazaar-events-toggle')?.addEventListener('click', (e) => {
    if (e.target.closest('#bazaar-events-new')) return;
    const now = body.classList.toggle('collapsed');
    arrow?.classList.toggle('collapsed', now);
    try { localStorage.setItem('haven_bazaar_events_collapsed', now ? '1' : '0'); } catch { /* storage blocked */ }
  });
  document.getElementById('bazaar-events-new')?.addEventListener('click', () => this._bazaarEventForm(null));

  let pending = null;
  const refresh = () => { clearTimeout(pending); pending = setTimeout(() => this._bazaarEventsFetch(), 150); };
  this.socket.on('connect', refresh);
  this.socket.on('bazaar-events-changed', refresh);
  this.socket.on('channels-list', refresh); // joining or leaving a channel changes what is visible
  this.socket.on('bazaar-event-started', (ev) => this._bazaarEventLive(ev));
  if (this.socket.connected) refresh();
  // The relative "in 5 min" labels need a tick.
  setInterval(() => this._bazaarEventsRender(), 60000);
},

_bazaarEventsFetch() {
  this.socket.emit('bazaar-events-list', {}, (r) => {
    if (!r || r.error) return;
    this._bazaarEvents = r.events || [];
    this._bazaarEventCreate = r.create || { channels: [], elsewhere: false };
    this._bazaarEventsRender();
    if (this._bazaarOpenEventId) {
      const ev = this._bazaarEvents.find((e) => e.id === this._bazaarOpenEventId);
      if (ev) this._bazaarEventShow(ev.id); else this._bazaarEventClose();
    }
  });
},

_bazaarEventsRender() {
  const list = document.getElementById('bazaar-events-list');
  const count = document.getElementById('bazaar-events-count');
  const add = document.getElementById('bazaar-events-new');
  if (!list) return;
  const evs = this._bazaarEvents || [];
  const canCreate = !!(this._bazaarEventCreate.channels.length || this._bazaarEventCreate.elsewhere);
  if (add) add.style.display = canCreate ? '' : 'none';
  if (count) count.textContent = evs.length ? `(${evs.length})` : '';
  if (!evs.length) {
    list.innerHTML = `<div class="bz-ev-empty">${this._escapeHtml(T('none_yet'))}</div>`;
    return;
  }
  list.innerHTML = evs.map((ev) => `
    <button type="button" class="bz-ev-item${ev.status === 'active' ? ' live' : ''}" data-id="${ev.id}">
      <span class="bz-ev-when">${ev.status === 'active' ? `🔴 ${this._escapeHtml(T('live'))}` : `📅 ${this._escapeHtml(this._bazaarEventWhenShort(ev))}`}</span>
      <span class="bz-ev-name">${this._escapeHtml(ev.name)}</span>
      <span class="bz-ev-meta">${this._escapeHtml(this._bazaarEventPlace(ev))}${ev.interested ? ` · ⭐ ${ev.interested}` : ''}</span>
    </button>`).join('');
  list.querySelectorAll('.bz-ev-item').forEach((b) => b.addEventListener('click', () => this._bazaarEventShow(Number(b.dataset.id))));
},

_bazaarEventWhenShort(ev) {
  const mins = Math.round((ev.startAt - Date.now()) / 60000);
  if (mins <= 0) return T('starting_soon');
  if (mins < 60) return T('in_minutes', { count: mins });
  return fmtWhen(ev.startAt);
},

_bazaarEventPlace(ev) {
  if (ev.channel) return `${ev.channel.voice ? '🗣️' : '#'} ${ev.channel.name}`;
  return `📍 ${ev.location || ''}`;
},

_bazaarRepeatLabel(repeat, ms) {
  const d = new Date(ms);
  const day = T(`day_${DAY_NAMES[d.getDay()]}`);
  switch (repeat) {
    case 'weekly': return T('repeat_weekly', { day });
    case 'biweekly': return T('repeat_biweekly', { day });
    case 'monthly': return T('repeat_monthly', { nth: T(`nth_${NTH[Math.min(Math.ceil(d.getDate() / 7), 5) - 1]}`), day });
    case 'yearly': return T('repeat_yearly', { date: new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(d) });
    case 'weekdays': return T('repeat_weekdays');
    default: return T('repeat_none');
  }
},

// ── Modal plumbing ───────────────────────────────────────────────────────
_bazaarEventModal(id) {
  let overlay = document.getElementById(id);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = id;
    overlay.style.display = 'none';
    overlay.innerHTML = '<div class="modal bz-ev-modal"></div>';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
    document.body.appendChild(overlay);
  }
  return overlay;
},

_bazaarEventClose() {
  this._bazaarOpenEventId = null;
  const o = document.getElementById('bazaar-event-modal');
  if (o) o.style.display = 'none';
},

// ── One event ────────────────────────────────────────────────────────────
_bazaarEventShow(id) {
  const ev = (this._bazaarEvents || []).find((e) => e.id === id);
  if (!ev) return;
  this._bazaarOpenEventId = id;
  const overlay = this._bazaarEventModal('bazaar-event-modal');
  const box = overlay.querySelector('.modal');
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const live = ev.status === 'active';
  const when = live
    ? `🔴 ${esc(T('live_since', { time: fmtTime(ev.startedAt || ev.startAt) }))}`
    : `📅 ${esc(fmtWhen(ev.startAt))}${ev.endAt ? ` – ${esc(fmtTime(ev.endAt))}` : ''}`;
  const isMember = !!(ev.channel && (this.channels || []).some((c) => c.code === ev.channel.code));
  const b = (act, label, cls = '') => `<button type="button" class="btn-sm ${cls}" data-act="${act}">${esc(label)}</button>`;
  box.innerHTML = `
    ${ev.image ? `<img class="bz-ev-cover" src="${esc(ev.image)}" alt="">` : ''}
    <div class="bz-ev-status${live ? ' live' : ''}">${when}${ev.repeat !== 'none' ? ` · 🔁 ${esc(this._bazaarRepeatLabel(ev.repeat, ev.startAt))}` : ''}</div>
    <h3 class="bz-ev-title">${esc(ev.name)}</h3>
    <div class="bz-ev-place">${esc(this._bazaarEventPlace(ev))}</div>
    ${ev.description ? `<div class="bz-ev-desc">${esc(ev.description)}</div>` : ''}
    <div class="bz-ev-by">${ev.createdBy ? esc(T('created_by', { name: ev.createdBy.name })) : ''}
      <button type="button" class="bz-ev-who" data-act="who">⭐ ${esc(T('interested_count', { count: ev.interested }))}</button></div>
    <div class="bz-ev-people" style="display:none"></div>
    <div class="modal-actions bz-ev-actions">
      ${b('interest', ev.me ? `✓ ${T('interested')}` : `⭐ ${T('interested')}`, ev.me ? 'btn-accent' : '')}
      ${live && ev.channel && isMember ? b('join', `▶ ${T('join')}`, 'btn-accent') : ''}
      ${ev.canManage && !live && ev.channel ? b('start', T('start'), 'btn-accent') : ''}
      ${ev.canManage && live ? b('end', T('end')) : ''}
      ${ev.canManage ? b('edit', T('edit')) : ''}
      ${ev.canManage && !live && ev.repeat !== 'none' ? b('skip', T('skip')) : ''}
      ${ev.canManage ? b('cancel', T('cancel_event'), 'btn-danger') : ''}
      ${b('close', T('close'))}
    </div>`;
  box.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => this._bazaarEventDo(ev, el.dataset.act, box)));
  overlay.style.display = 'flex';
},

_bazaarEventDo(ev, act, box) {
  const done = (r) => { if (r && r.error) this._showToast(r.error, 'error'); };
  if (act === 'close') return this._bazaarEventClose();
  if (act === 'interest') return this.socket.emit('bazaar-event-interest', { id: ev.id, on: !ev.me }, done);
  if (act === 'join') { this._bazaarEventClose(); return this._bazaarEventJoin(ev.channel); }
  if (act === 'edit') { this._bazaarEventClose(); return this._bazaarEventForm(ev); }
  if (act === 'who') {
    const out = box.querySelector('.bz-ev-people');
    if (out.style.display !== 'none') { out.style.display = 'none'; return; }
    return this.socket.emit('bazaar-event-interested', { id: ev.id }, (r) => {
      if (!r || r.error) return done(r);
      out.textContent = r.people.length ? r.people.map((p) => p.name).join(', ') : T('nobody_yet');
      out.style.display = '';
    });
  }
  if (act === 'cancel' && !confirm(T('cancel_confirm', { name: ev.name }))) return;
  if (act === 'skip' && !confirm(T('skip_confirm'))) return;
  if (act === 'end' && !confirm(T('end_confirm'))) return;
  this.socket.emit('bazaar-event-action', { id: ev.id, action: act }, done);
},

_bazaarEventJoin(channel) {
  if (!channel) return;
  if (!(this.channels || []).some((c) => c.code === channel.code)) return this._showToast(T('not_in_channel'), 'error');
  this.switchChannel(channel.code);
  const ch = this.channels.find((c) => c.code === channel.code);
  if (!ch || ch.voice_enabled === 0) return;
  if (!this.user?.isAdmin && !this._hasPerm('use_voice')) return;
  setTimeout(() => this._joinVoice(), 300);
},

// ── Starting now ─────────────────────────────────────────────────────────
_bazaarEventLive(ev) {
  if (!ev || !ev.name) return;
  if (this._bazaarOpenEventId === ev.id) this._bazaarEventClose(); // this pop-up takes its place
  const overlay = this._bazaarEventModal('bazaar-event-live-modal');
  const box = overlay.querySelector('.modal');
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const place = ev.channel ? `${ev.channel.voice ? '🗣️' : '#'} ${ev.channel.name}` : `📍 ${ev.location || ''}`;
  box.innerHTML = `
    <div class="bz-ev-status live">🔴 ${esc(T('starting_now'))}</div>
    <h3 class="bz-ev-title">${esc(ev.name)}</h3>
    <div class="bz-ev-place">${esc(place)}</div>
    <div class="modal-actions">
      ${ev.channel ? `<button type="button" class="btn-sm btn-accent" data-act="join">▶ ${esc(T('join'))}</button>` : ''}
      <button type="button" class="btn-sm" data-act="later">${esc(T('not_now'))}</button>
    </div>`;
  box.querySelector('[data-act="join"]')?.addEventListener('click', () => { overlay.style.display = 'none'; this._bazaarEventJoin(ev.channel); });
  box.querySelector('[data-act="later"]').addEventListener('click', () => { overlay.style.display = 'none'; });
  overlay.style.display = 'flex';
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(`📅 ${ev.name}`, { body: `${T('starting_now')} · ${place}`, tag: `haven-event-${ev.id}` }); } catch { /* some browsers only notify from the service worker */ }
  }
},

// ── Create and edit ──────────────────────────────────────────────────────
_bazaarEventForm(ev) {
  const opts = this._bazaarEventCreate || { channels: [], elsewhere: false };
  const overlay = this._bazaarEventModal('bazaar-event-form-modal');
  const box = overlay.querySelector('.modal');
  const esc = (s) => this._escapeHtml(String(s ?? ''));
  const channels = [...opts.channels];
  if (ev && ev.channel && !channels.some((c) => c.id === ev.channel.id)) channels.unshift(ev.channel);
  channels.sort((a, b) => (b.voice - a.voice) || a.name.localeCompare(b.name));
  const start = ev ? ev.startAt : (Math.ceil(Date.now() / 3600000) + 1) * 3600000;
  const where = ev ? (ev.channel ? String(ev.channel.id) : 'elsewhere') : (channels[0] ? String(channels[0].id) : 'elsewhere');
  box.innerHTML = `
    <h3>${esc(ev ? T('edit_title') : T('new_title'))}</h3>
    <label class="bz-ev-field"><span>${esc(T('f_where'))}</span>
      <select id="bz-ev-where">
        ${channels.map((c) => `<option value="${c.id}">${c.voice ? '🗣️' : '#'} ${esc(c.name)}</option>`).join('')}
        ${opts.elsewhere || (ev && !ev.channel) ? `<option value="elsewhere">📍 ${esc(T('somewhere_else'))}</option>` : ''}
      </select></label>
    <label class="bz-ev-field" id="bz-ev-loc-row"><span>${esc(T('f_location'))}</span>
      <input type="text" id="bz-ev-loc" maxlength="100" value="${esc(ev?.location || '')}" placeholder="${esc(T('f_location_hint'))}"></label>
    <label class="bz-ev-field"><span>${esc(T('f_name'))}</span><input type="text" id="bz-ev-name" maxlength="100" value="${esc(ev?.name || '')}"></label>
    <div class="bz-ev-row">
      <label class="bz-ev-field"><span>${esc(T('f_start'))}</span><input type="datetime-local" id="bz-ev-start" value="${toLocalInput(start)}"></label>
      <label class="bz-ev-field"><span>${esc(T('f_end'))}</span><input type="datetime-local" id="bz-ev-end" value="${ev?.endAt ? toLocalInput(ev.endAt) : ''}"></label>
    </div>
    <label class="bz-ev-field"><span>${esc(T('f_repeat'))}</span><select id="bz-ev-repeat"></select></label>
    <label class="bz-ev-field"><span>${esc(T('f_description'))}</span><textarea id="bz-ev-desc" maxlength="1000" rows="4">${esc(ev?.description || '')}</textarea></label>
    <div class="bz-ev-field"><span>${esc(T('f_cover'))}</span>
      <div class="bz-ev-cover-row"><img id="bz-ev-cover-preview" class="bz-ev-cover-small" alt="" style="display:none">
        <input type="file" id="bz-ev-cover" accept="image/png,image/jpeg,image/gif,image/webp">
        <button type="button" class="btn-sm" id="bz-ev-cover-clear">${esc(T('f_cover_remove'))}</button></div></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm btn-accent" id="bz-ev-save">${esc(ev ? T('save') : T('create'))}</button>
      <button type="button" class="btn-sm" id="bz-ev-cancel">${esc(T('close'))}</button>
    </div>`;
  const $ = (id) => box.querySelector(`#${id}`);
  let image = ev?.image || null;
  const showCover = () => { const p = $('bz-ev-cover-preview'); p.style.display = image ? '' : 'none'; if (image) p.src = image; $('bz-ev-cover-clear').style.display = image ? '' : 'none'; };
  const syncWhere = () => { $('bz-ev-loc-row').style.display = $('bz-ev-where').value === 'elsewhere' ? '' : 'none'; };
  const repeatChoices = () => {
    const ms = fromLocalInput($('bz-ev-start').value) || start;
    const cur = $('bz-ev-repeat').value || ev?.repeat || 'none';
    $('bz-ev-repeat').innerHTML = ['none', 'weekly', 'biweekly', 'monthly', 'yearly', 'weekdays']
      .map((r) => `<option value="${r}"${r === cur ? ' selected' : ''}>${esc(this._bazaarRepeatLabel(r, ms))}</option>`).join('');
  };
  $('bz-ev-where').value = where;
  syncWhere(); repeatChoices(); showCover();
  $('bz-ev-where').addEventListener('change', syncWhere);
  $('bz-ev-start').addEventListener('change', repeatChoices);
  $('bz-ev-cover-clear').addEventListener('click', () => { image = null; $('bz-ev-cover').value = ''; showCover(); });
  $('bz-ev-cover').addEventListener('change', async () => {
    const file = $('bz-ev-cover').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    try {
      const res = await fetch('/api/bazaar-event-image', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('haven_token')}` }, body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      image = j.url; showCover();
    } catch (err) {
      this._showToast(err.message, 'error');
      $('bz-ev-cover').value = '';
    }
  });
  $('bz-ev-cancel').addEventListener('click', () => { overlay.style.display = 'none'; });
  $('bz-ev-save').addEventListener('click', () => {
    const w = $('bz-ev-where').value;
    const data = {
      id: ev ? ev.id : undefined,
      name: $('bz-ev-name').value, description: $('bz-ev-desc').value,
      channelId: w === 'elsewhere' ? null : Number(w), location: w === 'elsewhere' ? $('bz-ev-loc').value : null,
      startAt: fromLocalInput($('bz-ev-start').value), endAt: fromLocalInput($('bz-ev-end').value),
      repeat: $('bz-ev-repeat').value, image,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    this.socket.emit('bazaar-event-save', data, (r) => {
      if (!r || r.error) return this._showToast(r ? r.error : T('save_failed'), 'error');
      overlay.style.display = 'none';
      this._showToast(ev ? T('saved') : T('created'), 'success');
    });
  });
  overlay.style.display = 'flex';
  $('bz-ev-name').focus();
},

_bazaarEventsStyle() {
  if (document.getElementById('bazaar-events-style')) return;
  const s = document.createElement('style');
  s.id = 'bazaar-events-style';
  s.textContent = `
    #bazaar-events-new { margin-left:auto; padding:0 6px; line-height:18px; }
    .bz-ev-empty { font-size:12px; color:var(--text-muted); padding:2px 8px 6px; }
    .bz-ev-item { display:flex; flex-direction:column; gap:1px; width:100%; text-align:left; background:none; border:0; border-radius:var(--radius-sm);
      padding:5px 8px; cursor:pointer; color:var(--text-primary); font:inherit; }
    .bz-ev-item:hover { background:var(--bg-hover); }
    .bz-ev-item.live { box-shadow:inset 3px 0 0 var(--danger); }
    .bz-ev-when { font-size:11px; color:var(--accent); }
    .bz-ev-item.live .bz-ev-when { color:var(--danger); font-weight:600; }
    .bz-ev-name { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .bz-ev-meta { font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .bz-ev-modal { max-width:480px; width:calc(100vw - 32px); max-height:calc(100vh - 32px); overflow:auto; }
    .bz-ev-cover { width:100%; max-height:200px; object-fit:cover; border-radius:var(--radius); margin-bottom:10px; }
    .bz-ev-status { font-size:12px; color:var(--accent); margin-bottom:4px; }
    .bz-ev-status.live { color:var(--danger); font-weight:600; }
    .bz-ev-title { margin:0 0 4px; overflow-wrap:anywhere; }
    .bz-ev-place { font-size:13px; color:var(--text-secondary); margin-bottom:8px; overflow-wrap:anywhere; }
    .bz-ev-desc { white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; margin-bottom:10px; color:var(--text-primary); }
    .bz-ev-by { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--text-muted); }
    .bz-ev-who { background:none; border:0; color:var(--accent); cursor:pointer; font:inherit; padding:0; }
    .bz-ev-people { font-size:12px; color:var(--text-secondary); margin-top:6px; overflow-wrap:anywhere; }
    .bz-ev-actions { flex-wrap:wrap; gap:6px; }
    .bz-ev-field { display:flex; flex-direction:column; gap:3px; font-size:12px; color:var(--text-muted); margin-bottom:8px; flex:1; min-width:0; }
    .bz-ev-field input, .bz-ev-field select, .bz-ev-field textarea { font:inherit; font-size:13px; color:var(--text-primary); background:var(--bg-tertiary);
      border:1px solid var(--border); border-radius:var(--radius-sm); padding:6px 8px; min-width:0; }
    .bz-ev-row { display:flex; gap:8px; flex-wrap:wrap; }
    .bz-ev-cover-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .bz-ev-cover-small { width:64px; height:36px; object-fit:cover; border-radius:var(--radius-sm); }
  `;
  document.head.appendChild(s);
},

};
