/**
 * UAZAPI — WhatsApp Integration
 * Server: https://fluxodigitaltech.uazapi.com
 *
 * Dois tokens:
 *  - adminToken    → gerenciamento de instâncias (create, connect, disconnect)
 *  - instanceToken → envio de mensagens, contatos, status da instância
 *
 * Número conectado: 5511939483653 (Academia 24 Health Club)
 */

const axios = require('axios');
const config = require('../config/apis');

const BASE = config.uazapi.baseUrl;

// Cliente para ENVIOS (instance token)
const send = axios.create({
  baseURL: BASE,
  headers: {
    'token': config.uazapi.instanceToken,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

// Cliente para ADMIN (admin token)
const admin = axios.create({
  baseURL: BASE,
  headers: {
    'token': config.uazapi.adminToken,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

// ─── INSTANCE STATUS ─────────────────────────────────────────────────────────

async function getInstanceStatus() {
  try {
    const res = await send.get('/instance/status');
    const d = res.data?.instance || res.data || {};
    return {
      connected:    d.status === 'connected',
      status:       d.status,
      name:         d.name || d.profileName,
      number:       d.owner || config.uazapi.instanceName,
      profileName:  d.profileName,
    };
  } catch (err) {
    // Fallback: public health check (sem auth)
    try {
      const health = await axios.get(`${BASE}/status`, { timeout: 5000 });
      return {
        connected:   false,
        status:      'unknown',
        serverUp:    !!health.data,
        _error:      err.message,
      };
    } catch {
      return { connected: false, status: 'offline', _error: err.message };
    }
  }
}

// ─── SEND MESSAGES ───────────────────────────────────────────────────────────

/**
 * Envia texto. Suporta formatação WhatsApp: *bold*, _italic_, ~strike~, ```code```
 * @param {string} number  - Com ou sem 55; ex: 11999999999 ou 5511999999999
 * @param {string} text    - Corpo da mensagem
 * @param {number} [delay] - Delay em ms antes de enviar (simula digitação)
 */
async function sendText(number, text, delay = 0) {
  const num = formatPhone(number);
  if (!num) throw new Error(`Número inválido: ${number}`);
  const res = await send.post('/send/text', { number: num, text, delay });
  return res.data;
}

/**
 * Envia imagem via /send/media.
 * Formato confirmado: { number, type:'image', file: base64DataURI|URL, caption }
 *
 * @param {string} number       - Número do destinatário
 * @param {string} imageSource  - URL pública, base64 (data:image/...) ou path relativo (/uploads/...)
 * @param {string} [caption]    - Legenda opcional
 */
async function sendImage(number, imageSource, caption = '') {
  const fs   = require('fs');
  const path = require('path');

  let fileValue = imageSource;

  // Path relativo ou absoluto → lê do disco e converte para base64 data URI
  if (imageSource && !imageSource.startsWith('http') && !imageSource.startsWith('data:')) {
    let absPath;
    if (path.isAbsolute(imageSource)) {
      absPath = imageSource; // já é absoluto (ex: /tmp/uploads/... no Vercel)
    } else {
      absPath = path.join(__dirname, '../../public', imageSource); // URL relativa local
    }
    const buf  = fs.readFileSync(absPath);
    const ext  = path.extname(absPath).slice(1).toLowerCase() || 'jpeg';
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    fileValue  = `data:${mime};base64,${buf.toString('base64')}`;
  }

  const res = await send.post('/send/media', {
    number:  formatPhone(number),
    type:    'image',
    file:    fileValue,
    caption: caption || '',
  });
  return res.data;
}

/**
 * Envia documento/arquivo.
 */
async function sendDocument(number, docUrl, fileName, caption = '') {
  const res = await send.post('/send/document', {
    number: formatPhone(number),
    docUrl,
    fileName,
    caption,
  });
  return res.data;
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

async function getContacts() {
  const res = await send.get('/contacts');
  return res.data;
}

/**
 * Verifica se um número tem WhatsApp.
 * @returns {{ exists: boolean, number: string }}
 */
async function checkNumber(number) {
  const res = await send.post('/contact/check', { number: formatPhone(number) });
  return res.data;
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────

async function setWebhook(webhookUrl, events = ['messages', 'status']) {
  const res = await send.post('/webhook', { url: webhookUrl, events });
  return res.data;
}

async function getWebhook() {
  const res = await send.get('/webhook');
  return res.data;
}

// ─── INSTANCE MANAGEMENT (admin) ─────────────────────────────────────────────

async function createInstance(instanceName, instanceToken) {
  const res = await admin.post('/instance/create', {
    instanceName: instanceName || config.uazapi.instanceName,
    token: instanceToken,
  });
  return res.data;
}

async function connectInstance() {
  const res = await admin.post('/instance/connect', {
    instanceName: config.uazapi.instanceName,
  });
  return res.data;
}

async function disconnectInstance() {
  const res = await admin.post('/instance/disconnect', {
    instanceName: config.uazapi.instanceName,
  });
  return res.data;
}

// ─── BULK SEND ────────────────────────────────────────────────────────────────

/**
 * Dispara mensagem para uma lista de contatos com delay entre envios.
 * @param {Array<{telefone|number, nome}>} contacts
 * @param {string|Function} buildMessage - texto fixo ou fn(contact) => string
 * @param {number} [delayMs=3000] - ms entre envios (respeitar limite anti-spam)
 */
async function sendBulk(contacts, buildMessage, delayMs = 3000) {
  const results = [];
  let enviados = 0, erros = 0;

  for (const contact of contacts) {
    const phone = contact.telefone || contact.number || '';
    try {
      const text = typeof buildMessage === 'function'
        ? buildMessage(contact)
        : buildMessage;

      if (!text || !phone) {
        results.push({ contact, status: 'skipped', reason: 'sem telefone ou texto' });
        continue;
      }

      const r = await sendText(phone, text);
      results.push({ contact, status: 'sent', data: r });
      enviados++;
    } catch (err) {
      results.push({ contact, status: 'error', error: err.message });
      erros++;
      console.error(`[UAZAPI] Erro enviando para ${phone}: ${err.message}`);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(`[UAZAPI] Bulk concluído: ${enviados} enviados, ${erros} erros de ${contacts.length}`);
  return results;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Normaliza número para formato E164 sem '+' (ex: 5511999999999).
 * Remove caracteres não-numéricos e adiciona DDI 55 se necessário.
 */
function formatPhone(number) {
  const clean = String(number || '').replace(/\D/g, '');
  if (!clean) return '';
  // Já tem DDI 55
  if (clean.startsWith('55') && clean.length >= 12) return clean;
  // Número local com DDD (10 ou 11 dígitos)
  if (clean.length === 10 || clean.length === 11) return `55${clean}`;
  // Retorna como está (pode já estar completo)
  return clean;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  getInstanceStatus,
  sendText,
  sendImage,
  sendDocument,
  getContacts,
  checkNumber,
  setWebhook,
  getWebhook,
  createInstance,
  connectInstance,
  disconnectInstance,
  sendBulk,
  formatPhone,
};
