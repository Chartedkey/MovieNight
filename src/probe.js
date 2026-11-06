'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseIfoSubtitles, subtitleSummary } = require('./scanner');

function runProbe(bin, file) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type:stream_tags=language', '-of', 'json', file], { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

// Читает только служебные данные файла, а не весь фильм.
async function probeEntry(entry, bin) {
  const out = { duration: null, subs: null, probeError: false };
  let embedded = [];
  if (entry.kind === 'dvd' && entry.mainSet) {
    try {
      const wanted = `VTS_${entry.mainSet}_0.IFO`.toLowerCase();
      const name = (await fs.promises.readdir(entry.video)).find(n=>n.toLowerCase()===wanted);
      if (!name) throw new Error('DVD IFO not found');
      const fh = await fs.promises.open(path.join(entry.video,name),'r');
      const buf = Buffer.alloc(4096);
      try { await fh.read(buf,0,4096,0); } finally { await fh.close(); }
      embedded = parseIfoSubtitles(buf) || [];
    } catch (e) {
      out.probeError = true;
    }
  } else if (entry.kind !== 'bluray' && entry.video && bin) {
    try {
      const j = await runProbe(bin, entry.video);
      out.duration = j.format && j.format.duration ? Math.round(Number(j.format.duration) / 60) : null;
      embedded = (j.streams || []).filter((s) => s.codec_type === 'subtitle').map((s) => (s.tags && s.tags.language) || 'und');
    } catch (e) {
      out.probeError = true;
    }
  }
  out.subs = subtitleSummary(embedded, entry.sidecars);
  return out;
}

module.exports = { probeEntry, runProbe };
