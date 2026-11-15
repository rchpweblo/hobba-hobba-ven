// Bizarre Bazaar fork: Save a picture or video in another format.
// Save on the picture menu (and the save button on a video) opens a small
// menu beside it: Original (JPG), PNG, WebP for pictures (WebP stays animated
// for a GIF), Original (MOV), MP4, WebM for videos. Still pictures are
// converted here in the browser, which also works for encrypted DM pictures;
// GIFs and videos go through the server (src/bazaarMediaConvert.js), which
// converts on request and keeps nothing.

const T = (key, params) => t(`bazaar_save.${key}`, params);
const DOWNLOAD_ICON = 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z';
const FMT_LABEL = { png: 'PNG', webp: 'WebP', mp4: 'MP4', webm: 'WebM' };
const VIDEO_TYPES = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg', mkv: 'video/x-matroska' };

export default {

// "jpg", "gif", "mov"... from a file address, or '' when it has none.
_bazaarExtOf(src) {
  let p = '';
  try { p = new URL(String(src || ''), window.location.origin).pathname; } catch { return ''; }
  const m = /\.([a-z0-9]{2,5})$/i.exec(p);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : '';
},

// The /uploads/ path the server can convert, or null for anything else
// (encrypted DM files, link previews, other sites).
_bazaarServerSrc(src, sourceImg) {
  if (sourceImg?.dataset?.e2eSrc) return null;
  const real = (sourceImg && this._lazyRealSrc ? this._lazyRealSrc(sourceImg) : '') || src;
  try {
    const u = new URL(String(real || ''), window.location.origin);
    if (u.origin !== window.location.origin || !u.pathname.startsWith('/uploads/')) return null;
    return u.pathname;
  } catch { return null; }
},

_bazaarOriginalLabel(ext) {
  return ext ? T('original_ext', { ext: ext.toUpperCase() }) : T('original');
},

// The formats offered for a picture; the first is always the original.
_bazaarImageSaveChoices(src, sourceImg) {
  const ext = this._bazaarExtOf((sourceImg && this._lazyRealSrc ? this._lazyRealSrc(sourceImg) : '') || src);
  const server = this._bazaarServerSrc(src, sourceImg);
  const list = [{ fmt: null, label: this._bazaarOriginalLabel(ext) }];
  if (ext !== 'png') list.push({ fmt: 'png', label: (ext === 'gif' || ext === 'webp') ? T('png_still') : 'PNG' });
  // An animated GIF stays animated only through the server; WebP originals
  // need no WebP entry.
  if (ext === 'gif') { if (server) list.push({ fmt: 'webp', label: T('webp_animated') }); }
  else if (ext !== 'webp') list.push({ fmt: 'webp', label: 'WebP' });
  return list;
},

_bazaarVideoSaveChoices(fileUrl) {
  const ext = this._bazaarExtOf(fileUrl);
  const list = [{ fmt: null, label: this._bazaarOriginalLabel(ext) }];
  if (!this._bazaarServerSrc(fileUrl)) return list;
  if (ext !== 'mp4') list.push({ fmt: 'mp4', label: 'MP4' });
  if (ext !== 'webm') list.push({ fmt: 'webm', label: 'WebM' });
  return list;
},

// Converted by the server; resolves the new file's bytes.
async _bazaarServerConvert(uploadPath, fmt) {
  const resp = await fetch(`/api/bazaar-convert?src=${encodeURIComponent(uploadPath)}&to=${fmt}`, {
    headers: { Authorization: `Bearer ${this.token}` },
  });
  if (!resp.ok) {
    let msg = '';
    try { msg = (await resp.json()).error; } catch { /* not JSON */ }
    throw new Error(msg || `HTTP ${resp.status}`);
  }
  return resp;
},

// A still picture redrawn as PNG or WebP. Null when this browser cannot
// write that format (Safari quietly writes PNG when asked for WebP).
async _bazaarCanvasConvert(blob, fmt) {
  const want = 'image/' + fmt;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const out = await new Promise(res => canvas.toBlob(res, want, fmt === 'webp' ? 0.92 : undefined));
  return out && out.type === want ? out : null;
},

// The picture's bytes in `fmt` (png or webp), for _saveContextImage.
async _bazaarConvertImage(src, sourceImg, fmt) {
  const ext = this._bazaarExtOf((sourceImg && this._lazyRealSrc ? this._lazyRealSrc(sourceImg) : '') || src);
  const server = this._bazaarServerSrc(src, sourceImg);
  // GIF to WebP keeps its animation, PNG to WebP stays lossless: both the
  // server's job. Everything else is drawn here, as the picture shows.
  const serverFirst = server && fmt === 'webp' && (ext === 'gif' || ext === 'png');
  if (!serverFirst) {
    try {
      const out = await this._bazaarCanvasConvert(await this._blobForContextImage(src, sourceImg), fmt);
      if (out) return out;
    } catch { /* the server may still manage it */ }
  }
  if (!server) throw new Error(T('cannot_convert'));
  this._showToast(T('converting', { fmt: FMT_LABEL[fmt] }), 'info');
  const resp = await this._bazaarServerConvert(server, fmt);
  return new Blob([await resp.blob()], { type: 'image/' + fmt });
},

_bazaarSaveName(name, fmt) {
  const clean = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'haven-video';
  return /\.[a-z0-9]{2,5}$/i.test(clean) ? clean.replace(/\.[a-z0-9]{2,5}$/i, '.' + fmt) : `${clean}.${fmt}`;
},

_bazaarSaveFormatStyle() {
  if (document.getElementById('bz-save-format-style')) return;
  const st = document.createElement('style');
  st.id = 'bz-save-format-style';
  st.textContent = `
.bz-save-formats { min-width: 9rem; }
.image-context-menu .bz-save-formats { position: absolute; left: 100%; margin-left: 2px; }
.image-context-menu .bz-save-formats.bz-flip { left: auto; right: 100%; margin-left: 0; margin-right: 2px; }
.bz-save-formats .bz-save-title { padding: 0.35rem 0.875rem 0.2rem; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted, #9a9cb0); }
.bz-save-formats button[data-bz-fmt=""] { font-weight: 600; }`;
  document.head.appendChild(st);
},

// The format menu beside `anchor`. Inside the picture menu it opens next to
// the Save entry; anywhere else it opens under the button on its own.
_bazaarSaveFormatMenu(anchor, choices, onPick) {
  this._bazaarSaveFormatStyle();
  const open = document.querySelector('.bz-save-formats');
  if (open) { const same = open._bzAnchor === anchor; open._bzClose(); if (same) return; }
  const parentMenu = anchor.closest('.image-context-menu');
  const menu = document.createElement('div');
  menu.className = 'image-context-menu bz-save-formats';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="bz-save-title">${this._escapeHtml(T('title'))}</div>`
    + choices.map(c => `<button type="button" role="menuitem" data-bz-fmt="${c.fmt || ''}">${this._escapeHtml(c.label)}</button>`).join('');
  menu._bzAnchor = anchor;

  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus?.(); } };
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', close, true);
  };
  menu._bzClose = close;
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.target.closest('button[data-bz-fmt]');
    if (!btn) return;
    close();
    onPick(btn.dataset.bzFmt || null);
  });

  if (parentMenu) {
    menu.style.top = Math.max(0, anchor.offsetTop - 4) + 'px';
    parentMenu.appendChild(menu);
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) menu.classList.add('bz-flip');
    if (r.bottom > window.innerHeight - 4) menu.style.top = Math.max(-parentMenu.getBoundingClientRect().top + 4, anchor.offsetTop - 4 - (r.bottom - window.innerHeight + 8)) + 'px';
  } else {
    document.body.appendChild(menu);
    const a = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8)) + 'px';
    menu.style.top = (a.bottom + 4 + h > window.innerHeight ? Math.max(8, a.top - 4 - h) : a.bottom + 4) + 'px';
    document.addEventListener('scroll', close, true);
  }
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  menu.querySelector('button')?.focus();
},

// ── Videos ────────────────────────────────────────────────

// The save button in a video's control row (next to loop and theater).
_bazaarVideoSaveHtml() {
  this._bazaarWireVideoSave();
  const label = this._escapeHtml(T('save_video'));
  return `<button type="button" class="media-btn bz-video-save" title="${label}" aria-label="${label}"><svg class="media-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${DOWNLOAD_ICON}"/></svg></button>`;
},

_bazaarWireVideoSave() {
  if (this._bzVideoSaveWired) return;
  this._bzVideoSaveWired = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.bz-video-save');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const box = btn.closest('.file-attachment');
    const fileUrl = box?.querySelector('video')?.getAttribute('src') || '';
    if (!fileUrl) return;
    const fileName = box.querySelector('.file-name')?.textContent || '';
    this._bazaarSaveFormatMenu(btn, this._bazaarVideoSaveChoices(fileUrl), (fmt) => this._bazaarSaveVideo(fileUrl, fileName, fmt));
  });
},

async _bazaarSaveVideo(fileUrl, fileName, fmt) {
  const ext = fmt || this._bazaarExtOf(fileUrl) || 'mp4';
  const name = this._bazaarSaveName(fileName || fileUrl.split('/').pop(), ext);
  try {
    // A browser that can ask where to save asks first, then the file is
    // written there as it arrives. The desktop app and other browsers get
    // their own save dialog once the file is ready.
    let handle = null;
    if (!window.havenDesktop && typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: T('video'), accept: { [VIDEO_TYPES[ext] || 'video/mp4']: ['.' + ext] } }],
        });
      } catch (err) {
        if (err?.name === 'AbortError') return this._showToast(T('cancelled'), 'info');
      }
    }
    if (fmt) this._showToast(T('converting_video', { fmt: FMT_LABEL[fmt] }), 'info');
    const resp = fmt ? await this._bazaarServerConvert(this._bazaarServerSrc(fileUrl), fmt)
      : await fetch(fileUrl, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (handle) {
      await resp.body.pipeTo(await handle.createWritable());
      this._showToast(T('saved'), 'success');
      return;
    }
    const url = URL.createObjectURL(await resp.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    this._showToast(T('save_failed', { error: err.message || String(err) }), 'error');
  }
},

};
