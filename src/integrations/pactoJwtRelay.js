/**
 * JWT Relay — Compartilha JWT do PACTO entre instâncias (local → Vercel)
 *
 * Fluxo:
 *  1. App local (com Chrome) obtém JWT via headless
 *  2. Após login, envia JWT para o endpoint /jwt-relay no Vercel
 *  3. Vercel armazena em /tmp/pacto-jwt.json
 *  4. Requests ao sintetico usam o JWT armazenado
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, '../../data');
const JWT_FILE = path.join(DATA_DIR, 'pacto-jwt.json');

/**
 * Salva JWT localmente (tanto no local quanto no Vercel)
 */
function saveJwt(jwt, expiresAt = null) {
  try {
    const dir = path.dirname(JWT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const exp = expiresAt || Date.now() + 90 * 60 * 1000; // 90 min padrão
    fs.writeFileSync(JWT_FILE, JSON.stringify({ jwt, expiresAt: exp, savedAt: Date.now() }));
    console.log('[JWT-RELAY] JWT salvo localmente (expira em', new Date(exp).toLocaleTimeString('pt-BR'), ')');
    return true;
  } catch (e) {
    console.error('[JWT-RELAY] Erro ao salvar JWT:', e.message);
    return false;
  }
}

/**
 * Carrega JWT do arquivo local. Retorna null se inválido ou expirado.
 */
function loadJwt() {
  try {
    if (!fs.existsSync(JWT_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(JWT_FILE, 'utf8'));
    if (!data.jwt || !data.expiresAt) return null;
    if (Date.now() > data.expiresAt) {
      console.log('[JWT-RELAY] JWT expirado, ignorando.');
      return null;
    }
    return data.jwt;
  } catch (_) {
    return null;
  }
}

/**
 * Envia JWT para o endpoint /jwt-relay no Vercel (rodado localmente após login)
 * Usa VERCEL_URL ou VERCEL_SYNC_URL env var para saber o destino.
 */
async function relayToVercel(jwt, expiresAt) {
  const vercelUrl = process.env.VERCEL_SYNC_URL || process.env.VERCEL_URL;
  const syncKey   = process.env.SYNC_KEY || '24hNorte_sync';
  if (!vercelUrl) {
    console.log('[JWT-RELAY] VERCEL_SYNC_URL não configurado — sem relay remoto.');
    return false;
  }
  try {
    const url = vercelUrl.startsWith('http') ? vercelUrl : `https://${vercelUrl}`;
    const resp = await axios.post(`${url}/jwt-relay`, { jwt, expiresAt },
      { headers: { 'x-sync-key': syncKey, 'Content-Type': 'application/json' }, timeout: 10000 });
    if (resp.status === 200) {
      console.log('[JWT-RELAY] JWT enviado para o Vercel com sucesso!');
      return true;
    }
    console.warn('[JWT-RELAY] Vercel respondeu', resp.status);
    return false;
  } catch (e) {
    console.warn('[JWT-RELAY] Erro ao enviar JWT para Vercel:', e.message);
    return false;
  }
}

/**
 * Salva JWT localmente E tenta enviar ao Vercel se configurado.
 */
async function storeAndRelay(jwt, expiresAt = null) {
  const exp = expiresAt || Date.now() + 90 * 60 * 1000;
  saveJwt(jwt, exp);
  if (!process.env.VERCEL) {
    // Só faz relay quando rodando localmente
    await relayToVercel(jwt, exp).catch(() => {});
  }
}

module.exports = { saveJwt, loadJwt, storeAndRelay };
