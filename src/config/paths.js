/**
 * Caminhos de dados — resolve para /tmp no Vercel (serverless) ou data/ localmente.
 * No Vercel os arquivos em /tmp são efêmeros (reset a cada cold start).
 */
const path = require('path');

const isVercel  = !!process.env.VERCEL;
const DATA_DIR  = isVercel ? '/tmp' : path.join(__dirname, '../../data');

// Garante que o diretório existe
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

module.exports = {
  DATA_DIR,
  OPS_FILE:      path.join(DATA_DIR, 'oportunidades.json'),
  CACHE_FILE:    path.join(DATA_DIR, 'cache.json'),
  CADENCIAS_FILE: path.join(DATA_DIR, 'cadencias.json'),
  CONFIG_FILE:   path.join(DATA_DIR, 'config.json'),
};
