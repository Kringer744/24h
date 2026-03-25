const fs = require('fs');
const path = require('path');

const FILE = require('../config/paths').CACHE_FILE;

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function save(data) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

const mem = load();

module.exports = {
  get: (key) => mem[key],
  set: (key, val) => { mem[key] = { ...val, _syncedAt: new Date().toISOString() }; save(mem); },
  all: () => mem,
};
