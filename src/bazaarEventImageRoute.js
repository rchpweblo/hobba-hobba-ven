'use strict';

// Bizarre Bazaar fork: cover images for scheduled events (src/bazaarEvents.js).
// Built like upstream's server banner upload, open to anyone who may create
// an event somewhere. The event keeps only the /uploads/ path it returns.

const fs = require('fs');

function registerBazaarEventImageRoute(app, { upload, uploadLimiter, uploadDiskGuard, storage, verifyToken, getDb }) {
  app.post('/api/bazaar-event-image', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!require('./bazaarEvents').canCreateAnywhere(getDb(), user.id)) return res.status(403).json({ error: 'You cannot create events' });

    upload.single('image')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message, code: err.code });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const drop = () => { try { fs.unlinkSync(req.file.path); } catch { /* already gone */ } };
      if (req.file.size > 4 * 1024 * 1024) { drop(); return res.status(400).json({ error: 'A cover image must be under 4 MB' }); }
      try {
        const fd = fs.openSync(req.file.path, 'r');
        const hdr = Buffer.alloc(12);
        fs.readSync(fd, hdr, 0, 12, 0);
        fs.closeSync(fd);
        const isJpeg = hdr[0] === 0xFF && hdr[1] === 0xD8 && hdr[2] === 0xFF;
        const isPng = hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4E && hdr[3] === 0x47;
        const isGif = hdr.slice(0, 6).toString().startsWith('GIF8');
        const isWebp = hdr.slice(0, 4).toString() === 'RIFF' && hdr.slice(8, 12).toString() === 'WEBP';
        if (!isJpeg && !isPng && !isGif && !isWebp) { drop(); return res.status(400).json({ error: 'Only JPG, PNG, GIF or WebP images' }); }
      } catch { drop(); return res.status(400).json({ error: 'Failed to validate' }); }

      try { await storage.admitUpload(req.file); } catch { return res.status(500).json({ error: 'Failed to store the upload' }); }
      res.json({ url: `/uploads/${req.file.filename}` });
    });
  });
}

module.exports = { registerBazaarEventImageRoute };
