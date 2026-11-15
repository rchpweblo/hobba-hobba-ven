'use strict';

// Bizarre Bazaar fork: Save a picture or video in another format.
// GET /api/bazaar-convert?src=/uploads/<file>&to=png|webp|mp4|webm
//
// Converted on request and streamed straight from ffmpeg to the person
// saving it: nothing is written to disk and nothing is cached, so stored
// uploads stay exactly as they were sent. Still pictures are normally turned
// into PNG/WebP by the browser (public/js/modules/app-bazaar-save-formats.js);
// this route does what a browser cannot: an animated GIF into an animated
// WebP, any video into MP4 or WebM, and stills where the browser can't write
// WebP. ffmpeg 4.4 cannot read animated WebP, so WebP sources are refused.

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const tools = require('./mediaTools');
const { isContainedRelPath } = require('./storage/paths');

const IMAGE_IN = new Set(['.jpg', '.jpeg', '.png', '.gif']);
const VIDEO_IN = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv']);
const TARGETS = {
  png:  { kind: 'image', type: 'image/png' },
  webp: { kind: 'image', type: 'image/webp' },
  mp4:  { kind: 'video', type: 'video/mp4' },
  webm: { kind: 'video', type: 'video/webm' },
};
const BLOCKED_DIRS = new Set(['deleted-attachments', 'bot-audio']);
const MAX_JOBS = 2;                        // whole server
const IMAGE_TIMEOUT_MS = 60 * 1000;
const VIDEO_TIMEOUT_MS = 20 * 60 * 1000;
const IMAGE_MAX_BYTES = 128 * 1024 * 1024;
const EVEN_SIZE = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';   // H.264/VP9 4:2:0 need even sizes

/** "/uploads/a/b.gif" (or a full URL to it, query ignored) -> "a/b.gif", or null. */
function relFromSrc(src) {
  let p;
  try { p = new URL(String(src || ''), 'http://haven.invalid').pathname; } catch { return null; }
  if (!p.startsWith('/uploads/')) return null;
  try { p = decodeURIComponent(p.slice('/uploads/'.length)); } catch { return null; }
  if (!isContainedRelPath(p)) return null;
  const segs = p.split('/');
  // Same refusals as src/storage/serve.js: dotfiles, 8.3 short names, trailing dot/space.
  if (segs.some(s => s[0] === '.' || s.includes('~') || /[. ]$/.test(s))) return null;
  if (BLOCKED_DIRS.has(segs[0].toLowerCase())) return null;
  return p;
}

/** What the source holds, from ffmpeg's own description of it. */
function describe(stderr) {
  const video = /Stream #\d+:\d+[^\n]*?: Video: ([^\n]*)/.exec(stderr || '');
  const audio = /Stream #\d+:\d+[^\n]*?: Audio: (\w+)/.exec(stderr || '');
  return {
    vcodec: video ? video[1].split(/[\s,(]/)[0] : null,
    yuv420: video ? /\byuv420p\b(?!1)/.test(video[1]) : false,
    acodec: audio ? audio[1] : null,
  };
}

/** ffmpeg output arguments for converting a source with extension `ext` to `to`. */
function outputArgs(ext, to, info = {}) {
  if (to === 'png') return ['-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe'];
  if (to === 'webp') {
    if (ext === '.gif') return ['-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0', '-f', 'webp'];
    if (ext === '.png') return ['-frames:v', '1', '-c:v', 'libwebp', '-lossless', '1', '-f', 'webp'];
    return ['-frames:v', '1', '-c:v', 'libwebp', '-q:v', '90', '-f', 'webp'];
  }
  // Videos: copy a stream when it already suits the new container (a phone's
  // H.264 .mov becomes an .mp4 in a second), otherwise encode it.
  const out = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1'];
  if (to === 'mp4') {
    if (info.vcodec === 'h264' && info.yuv420) out.push('-c:v', 'copy');
    else out.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', EVEN_SIZE);
    if (info.acodec === 'aac' || info.acodec === 'mp3') out.push('-c:a', 'copy');
    else out.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
    // Fragmented, so it can be written as it is made, with no seeking back.
    out.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4');
  } else {
    if (['vp8', 'vp9', 'av1'].includes(info.vcodec)) out.push('-c:v', 'copy');
    else out.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
      '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p', '-vf', EVEN_SIZE);
    if (info.acodec === 'opus' || info.acodec === 'vorbis') out.push('-c:a', 'copy');
    else out.push('-c:a', 'libopus', '-b:a', '128k', '-ac', '2');
    out.push('-f', 'webm');
  }
  return out;
}

/** May `ext` be turned into `to`? */
function allowed(ext, to) {
  const target = TARGETS[to];
  if (!target) return false;
  if (target.kind === 'image') return IMAGE_IN.has(ext) && !(to === 'png' && ext === '.png');
  return VIDEO_IN.has(ext) && ext !== '.' + to;
}

let lastLocate = 0;
function ffmpegPath() {
  let p = tools.toolPath('ffmpeg');
  // Found at startup by the privacy pass; look again (at most once a minute)
  // in case that is switched off or ffmpeg was installed since.
  if (!p && Date.now() - lastLocate > 60000) { lastLocate = Date.now(); tools.locateTools(); p = tools.toolPath('ffmpeg'); }
  return p;
}

function registerBazaarMediaConvertRoute(app, { storage, verifyToken }) {
  const busyUsers = new Set();
  let jobs = 0;

  app.get('/api/bazaar-convert', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = req.postgresUser || (token ? verifyToken(token) : null);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const to = String(req.query.to || '').toLowerCase();
    const rel = relFromSrc(req.query.src);
    if (!rel) return res.status(400).json({ error: 'Only files uploaded here can be converted' });
    const ext = path.extname(rel).toLowerCase();
    if (!allowed(ext, to)) return res.status(400).json({ error: 'That conversion is not available' });
    const ffmpeg = ffmpegPath();
    if (!ffmpeg) return res.status(503).json({ error: 'This server has no ffmpeg to convert with' });

    let meta;
    try { meta = await storage.head(rel); } catch { meta = null; }
    if (!meta) return res.status(404).json({ error: 'File not found' });

    if (busyUsers.has(user.id)) return res.status(429).json({ error: 'Your last conversion is still running' });
    if (jobs >= MAX_JOBS) return res.status(429).json({ error: 'The server is converting other files, try again in a moment' });
    busyUsers.add(user.id);
    jobs++;
    let released = false;
    const release = () => { if (released) return; released = true; busyUsers.delete(user.id); jobs--; };

    try {
      const target = TARGETS[to];
      const local = storage.kind === 'local' && storage.root ? path.join(storage.root, rel) : null;
      let info = {};
      if (local && target.kind === 'video') {
        const probe = await tools.run('ffmpeg', ['-hide_banner', '-i', local], { timeoutMs: 15000 });
        info = describe(probe.stderr);
        if (!info.vcodec) { release(); return res.status(422).json({ error: 'No video found in that file' }); }
      }
      const args = ['-hide_banner', '-v', 'error', '-nostdin', '-i', local || 'pipe:0', ...outputArgs(ext, to, info), 'pipe:1'];
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: [local ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* normal priority, then */ }
      const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
      const timer = setTimeout(kill, target.kind === 'video' ? VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
      let stderr = '';
      child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
      child.on('error', () => kill());
      if (!local) {
        const body = await storage.getStream(rel);
        if (!body) { kill(); clearTimeout(timer); release(); return res.status(404).json({ error: 'File not found' }); }
        body.stream.on('error', kill);
        child.stdin.on('error', () => { /* ffmpeg stopped reading: its exit code tells */ });
        body.stream.pipe(child.stdin);
      }
      res.on('close', () => { if (!res.writableFinished) kill(); });

      const fail = (code) => {
        console.warn(`[bazaar-convert] ${rel} -> ${to} failed (exit ${code}): ${stderr.trim().split('\n').pop() || ''}`);
        if (!res.headersSent) res.status(422).json({ error: 'That file could not be converted' });
        else res.destroy();
      };
      const headers = () => {
        res.setHeader('Content-Type', target.type);
        res.setHeader('Content-Disposition', `attachment; filename="converted.${to}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      };

      if (target.kind === 'image') {
        // Small: kept whole so a failure is still a proper error reply.
        const parts = [];
        let size = 0;
        child.stdout.on('data', (d) => { size += d.length; if (size > IMAGE_MAX_BYTES) kill(); else parts.push(d); });
        child.on('close', (code) => {
          clearTimeout(timer);
          release();
          if (code !== 0 || !size || size > IMAGE_MAX_BYTES) return fail(code);
          headers();
          res.setHeader('Content-Length', size);
          res.end(Buffer.concat(parts));
        });
        return;
      }

      // Video: headers go out with the first bytes, so a file ffmpeg cannot
      // read at all still gets an error reply; after that it streams.
      child.stdout.once('data', (first) => {
        if (res.destroyed) return kill();
        headers();
        res.write(first);
        child.stdout.pipe(res, { end: false });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        release();
        if (code !== 0 || !res.headersSent) return fail(code);
        res.end();
      });
    } catch (err) {
      release();
      console.warn('[bazaar-convert]', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
    }
  });
}

module.exports = { registerBazaarMediaConvertRoute, relFromSrc, outputArgs, allowed, describe };
