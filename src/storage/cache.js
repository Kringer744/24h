/**
 * Cache Store
 * - Em memória (primário, sempre disponível dentro da mesma invocação)
 * - Arquivo /tmp ou data/ (secundário, persiste entre warm starts no Vercel)
 *
 * No Vercel serverless cada cold start reseta a memória.
 * Uma instância "quente" (warm) reaproveita os dados em memória.
 * O arquivo serve de seed para warm starts e para resiliência local.
 */

const fs = require('fs');
const path = require('path');

const FILE = require('../config/paths').CACHE_FILE;

// TTL máximo do cache em memória (20 minutos — força re-sync após cold start)
const MEM_TTL_MS = 20 * 60 * 1000;
let _memLoadedAt = Date.now();

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      // No Vercel, só usa o arquivo se foi salvo nas últimas 6 horas
      const isVercel = !!process.env.VERCEL;
      if (isVercel && data._savedAt) {
        const age = Date.now() - new Date(data._savedAt).getTime();
        if (age > 6 * 60 * 60 * 1000) {
          console.log('[CACHE] Arquivo de cache expirado no Vercel, ignorando.');
          return {};
        }
      }
      return data;
    }
  } catch (_) {}
  return {};
}

function save(data) {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ ...data, _savedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    // No Vercel /tmp pode falhar em alguns casos - log apenas
    console.warn('[CACHE] Erro ao salvar cache em disco:', e.message);
  }
}

const mem = load();
_memLoadedAt = Date.now();

/**
 * Verifica se o cache em memória está "fresco" (dentro do TTL)
 */
function isMemFresh() {
  return Date.now() - _memLoadedAt < MEM_TTL_MS;
}

module.exports = {
  get: (key) => mem[key],
  set: (key, val) => {
    mem[key] = { ...val, _syncedAt: new Date().toISOString() };
    save(mem);
  },
  all: () => mem,
  isMemFresh,
  clear: () => {
    Object.keys(mem).forEach(k => delete mem[k]);
    _memLoadedAt = 0; // força como expirado
  },
};
