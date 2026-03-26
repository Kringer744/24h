/**
 * PACTO Headless Login
 * Estratégia em camadas para obter JWT automaticamente:
 *
 * 1. CDP (Chrome DevTools Protocol): conecta ao Chrome já aberto pelo usuário
 *    na porta 9222 e extrai o JWT direto do localStorage — sem reCAPTCHA.
 *
 * 2. CDP Auto-Fill: se o Chrome estiver na tela de login, preenche os campos
 *    automaticamente. O reCAPTCHA geralmente auto-valida em Chrome real com
 *    perfil do usuário (conta Google ativa).
 *
 * 3. Puppeteer launch: abre Chrome headless com perfil clonado e faz login.
 *    Funciona se o Chrome reconhecer o usuário (cookies válidos).
 *
 * 4. Cache TTL: JWT extraído fica válido por 90 min sem novas tentativas.
 */

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const axios     = require('axios');
const config    = require('../config/apis');

const CHROME_PATH    = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_URL        = 'http://localhost:9222';
// Sintetico é servido em lgn.pactosolucoes.com.br; login JSF em app
const _sinteticoBase = (config.pacto.sinteticoUrl || 'https://lgn.pactosolucoes.com.br/sintetico').replace(/\/$/, '');
const APP_URL        = new URL(_sinteticoBase).origin; // ex: https://lgn.pactosolucoes.com.br
const LOGIN_URL      = 'https://app.pactosolucoes.com.br/login/';
const EMPRESA_ID     = parseInt(config.pacto.empresaId || '4', 10);
const UNIDADE_ID     = parseInt(config.pacto.unidadeId || '4', 10);
const CHAVE          = config.pacto.unidadeChave || '24H_NORTE';

let _jwt      = null;
let _jwtAt    = null;
const JWT_TTL = 90 * 60 * 1000; // 90 minutos

function isJwtValid() {
  return _jwt && _jwtAt && (Date.now() - _jwtAt) < JWT_TTL;
}

/**
 * Tenta extrair JWT do Chrome já aberto via CDP (porta 9222).
 * Se não encontrar JWT, tenta auto-fill do formulário de login.
 * Retorna o JWT se encontrado, ou null.
 */
async function tryExtractFromRunningChrome() {
  try {
    // Verifica se Chrome está com debug port aberta
    const listRes = await axios.get(`${CDP_URL}/json`, { timeout: 2000 });
    const tabs = listRes.data;

    if (!Array.isArray(tabs) || tabs.length === 0) return null;

    // Procura aba do PACTO aberta
    const pactoTab = tabs.find(t =>
      t.url && t.url.includes('pactosolucoes.com.br') && t.type === 'page'
    );

    if (!pactoTab) {
      console.log('[HEADLESS] Chrome conectado mas sem aba PACTO aberta.');
      return null;
    }

    console.log(`[HEADLESS] Aba PACTO encontrada: ${pactoTab.url}`);

    // Conectar ao tab via CDP e extrair JWT
    const browser = await puppeteerExtra.connect({
      browserURL: CDP_URL,
      defaultViewport: null,
    });

    const pages = await browser.pages();
    const page  = pages.find(p => p.url().includes('pactosolucoes.com.br'));

    if (!page) {
      await browser.disconnect();
      return null;
    }

    const jwt = await page.evaluate(() =>
      localStorage.getItem('apiToken') ||
      localStorage.getItem('token') ||
      localStorage.getItem('access_token') ||
      null
    );

    if (jwt && jwt.startsWith('eyJ')) {
      await browser.disconnect();
      console.log(`[HEADLESS] JWT extraído do Chrome aberto (${jwt.length} chars)`);
      const relay = require('./pactoJwtRelay');
      relay.storeAndRelay(jwt).catch(() => {});
      return jwt;
    }

    // PACTO está aberto mas sem JWT — tenta auto-fill do login
    console.log('[HEADLESS] Sem JWT no localStorage. Tentando auto-fill do login...');
    const autoJwt = await cdpAutoFillLogin(browser, page).catch(() => null);
    await browser.disconnect();

    if (autoJwt) {
      console.log(`[HEADLESS] JWT obtido via auto-fill (${autoJwt.length} chars)`);
      const relay = require('./pactoJwtRelay');
      relay.storeAndRelay(autoJwt).catch(() => {});
    }
    return autoJwt;

  } catch (_) {
    // Chrome não está com porta de debug aberta — normal
    return null;
  }
}

/**
 * Preenche automaticamente o formulário de login do PACTO via CDP.
 * Funciona com o Chrome visível (real) — reCAPTCHA geralmente auto-valida.
 * Retorna JWT se o login for bem-sucedido dentro do timeout.
 */
async function cdpAutoFillLogin(browser, page) {
  const user  = process.env.PACTO_USER;
  const pass  = process.env.PACTO_PASS;
  if (!user || !pass) return null;

  const currentUrl = page.url();

  // Se não está na página de login, navegar para lá
  if (!currentUrl.includes('app.pactosolucoes.com.br/login')) {
    console.log(`[HEADLESS] Navegando para login JSF... (estava em ${currentUrl.slice(0, 60)})`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 20000 });
  }

  // Verificar se campos de login estão presentes
  const hasLoginForm = await page.evaluate(() =>
    !!document.querySelector('[name="fmLay:usernameLoginZW"]')
  ).catch(() => false);

  if (!hasLoginForm) {
    console.log('[HEADLESS] Formulário de login não encontrado na página atual.');
    return null;
  }

  console.log('[HEADLESS] Preenchendo formulário de login via CDP...');

  // Preencher chave
  await page.evaluate((chave) => {
    const el = document.querySelector('[name="fmLay:chave"]');
    if (el) { el.focus(); el.value = chave; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
  }, CHAVE);

  await new Promise(r => setTimeout(r, 500));

  // Preencher usuário
  await page.evaluate((username) => {
    const el = document.querySelector('[name="fmLay:usernameLoginZW"]');
    if (el) { el.focus(); el.value = username; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
  }, user);

  await new Promise(r => setTimeout(r, 300));

  // Preencher senha
  await page.evaluate((password) => {
    const el = document.querySelector('[name="fmLay:pwdLoginZW"]');
    if (el) { el.focus(); el.value = password; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
  }, pass);

  await new Promise(r => setTimeout(r, 500));

  // Tentar clicar no reCAPTCHA (em Chrome real, frequentemente auto-valida)
  try {
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaFrame) {
      const frame = await recaptchaFrame.contentFrame();
      if (frame) {
        const anchor = await frame.$('#recaptcha-anchor');
        if (anchor) {
          await anchor.click();
          console.log('[HEADLESS] reCAPTCHA clicado. Aguardando auto-validação (15s)...');
          // Esperar validação — em Chrome real com conta Google, geralmente auto-valida
          await new Promise(r => setTimeout(r, 15000));
        }
      }
    }
  } catch (_) {
    console.log('[HEADLESS] reCAPTCHA não interativo — pode ser invisible v3.');
    await new Promise(r => setTimeout(r, 2000));
  }

  // Clicar no botão Entrar
  await page.evaluate(() => {
    const btn = document.getElementById('fmLay:btnEntrar') ||
                document.querySelector('button.ui-button[id*="btnEntrar"]') ||
                document.querySelector('input[type="submit"]') ||
                document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });
  console.log('[HEADLESS] Botão Entrar clicado. Aguardando JWT (até 30s)...');

  // Aguardar JWT aparecer no localStorage (dentro de 30s)
  let jwt = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const candidate = await page.evaluate(() =>
        localStorage.getItem('apiToken') ||
        localStorage.getItem('token') ||
        localStorage.getItem('access_token') ||
        null
      );
      if (candidate && candidate.startsWith('eyJ')) {
        jwt = candidate;
        break;
      }
      // Também verifica se houve redirect para lgn (login bem-sucedido mas JWT em outra aba)
      const url = page.url();
      if (url.includes('lgn.pactosolucoes.com.br') && !url.includes('login')) {
        // Está no dashboard — JWT deve estar no localStorage
        const lgnjwt = await page.evaluate(() => localStorage.getItem('apiToken')).catch(() => null);
        if (lgnjwt && lgnjwt.startsWith('eyJ')) { jwt = lgnjwt; break; }
      }
      // Verificar erro reCAPTCHA na página
      const recaptchaError = await page.evaluate(() => {
        const el = document.querySelector('.ui-growl-message, .ui-messages-error, .ui-messages-fatal');
        return el ? el.innerText?.trim() : null;
      }).catch(() => null);
      if (recaptchaError && recaptchaError.includes('reCAPTCHA')) {
        console.log('[HEADLESS] reCAPTCHA bloqueou o login automático. Usuário precisa resolver manualmente.');
        break;
      }
    } catch (_) {}
  }

  return jwt;
}

/**
 * Faz login headless no PACTO e extrai o JWT do localStorage.
 * Usa Chrome real com perfil clonado para tentar passar pelo reCAPTCHA.
 */
async function headlessLogin() {
  const user = process.env.PACTO_USER;
  const pass = process.env.PACTO_PASS;
  if (!user || !pass) throw new Error('PACTO_USER e PACTO_PASS não configurados');

  // Estratégia 1: Tentar extrair do Chrome já aberto (sem reCAPTCHA)
  const existingJwt = await tryExtractFromRunningChrome();
  if (existingJwt) {
    _jwt   = existingJwt;
    _jwtAt = Date.now();
    return { jwt: existingJwt, empresa: String(EMPRESA_ID), unidade: String(UNIDADE_ID) };
  }

  // Estratégia 2: Abrir Chrome com perfil clonado e tentar login
  console.log('[HEADLESS] Iniciando login automático via Chrome...');

  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const srcProfile = 'C:/Users/combu/AppData/Local/Google/Chrome/User Data/Default';
  const tmpDir     = path.join(os.tmpdir(), 'pacto-chrome-' + Date.now());
  const tmpProfile = path.join(tmpDir, 'Default');
  fs.mkdirSync(tmpProfile, { recursive: true });

  for (const f of ['Cookies', 'Preferences', 'Local State', 'Web Data']) {
    const src = path.join(srcProfile, f);
    const dst = path.join(tmpProfile, f);
    try { fs.copyFileSync(src, dst); } catch (_) {}
  }
  try {
    fs.copyFileSync(
      'C:/Users/combu/AppData/Local/Google/Chrome/User Data/Local State',
      path.join(tmpDir, 'Local State')
    );
  } catch (_) {}

  const browser = await puppeteerExtra.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: null,
    userDataDir: tmpDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800',
      '--profile-directory=Default',
    ],
  });

  const cleanupTemp = () => {
    try { require('fs').rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('[HEADLESS] Abrindo página de login PACTO...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.waitForSelector('[name="fmLay:chave"]', { timeout: 10000 });

    await page.click('[name="fmLay:chave"]', { clickCount: 3 });
    await page.type('[name="fmLay:chave"]', CHAVE, { delay: 80 });

    await page.mouse.move(400 + Math.random() * 50, 300 + Math.random() * 30, { steps: 10 });

    await page.click('[name="fmLay:usernameLoginZW"]', { clickCount: 3 });
    await page.type('[name="fmLay:usernameLoginZW"]', user, { delay: 90 });

    await page.click('[name="fmLay:pwdLoginZW"]', { clickCount: 3 });
    await page.type('[name="fmLay:pwdLoginZW"]', pass, { delay: 90 });

    console.log('[HEADLESS] Credenciais preenchidas. Clicando em reCAPTCHA...');

    await new Promise(r => setTimeout(r, 1000));
    try {
      const recaptchaFrame = await page.waitForSelector('iframe[src*="recaptcha"]', { timeout: 5000 });
      if (recaptchaFrame) {
        const frame = await recaptchaFrame.contentFrame();
        if (frame) {
          await frame.waitForSelector('#recaptcha-anchor', { timeout: 5000 });
          await frame.click('#recaptcha-anchor');
          console.log('[HEADLESS] reCAPTCHA clicado. Aguardando validação (até 20s)...');
          await new Promise(r => setTimeout(r, 20000));
        }
      }
    } catch (_) {
      console.log('[HEADLESS] reCAPTCHA iframe não encontrado — pode ser invisível (v3)');
    }

    await page.evaluate(() => {
      const btn = document.getElementById('fmLay:btnEntrar') ||
                  document.querySelector('button.ui-button[id*="btnEntrar"]') ||
                  document.querySelector('button.ui-button');
      if (btn) btn.click();
    });
    console.log('[HEADLESS] Botão Entrar clicado. Aguardando JWT...');

    await page.waitForFunction(
      () => !!(localStorage.getItem('apiToken') || localStorage.getItem('token') || localStorage.getItem('access_token')),
      { timeout: 30000, polling: 500 }
    ).catch(() => null);

    await new Promise(r => setTimeout(r, 1500));

    const jwt = await page.evaluate(() =>
      localStorage.getItem('apiToken') || localStorage.getItem('token') || localStorage.getItem('access_token')
    );

    const emp = await page.evaluate(() =>
      localStorage.getItem('empresa') || localStorage.getItem('codEmpresa') || '1'
    ).catch(() => '1');

    const uni = await page.evaluate(() =>
      localStorage.getItem('unidade') || localStorage.getItem('codUnidade') || '1'
    ).catch(() => '1');

    if (!jwt) {
      const growl = await page.evaluate(() => {
        const el = document.querySelector('.ui-growl-message, .ui-messages-error');
        return el ? el.innerText?.trim() : null;
      }).catch(() => null);
      throw new Error(growl || 'Login falhou — reCAPTCHA pode ter bloqueado. Abra o Chrome com a porta de debug para login automático.');
    }

    _jwt   = jwt;
    _jwtAt = Date.now();
    console.log(`[HEADLESS] Login OK. JWT obtido (${jwt.length} chars). Empresa=${emp} Unidade=${uni}`);

    // Relay JWT para o Vercel (se VERCEL_SYNC_URL configurado)
    const relay = require('./pactoJwtRelay');
    relay.storeAndRelay(jwt).catch(() => {});

    return { jwt, empresa: emp, unidade: uni };

  } finally {
    await browser.close();
    cleanupTemp();
  }
}

/**
 * Garante JWT válido.
 * Ordem: cache → CDP (Chrome aberto) → headless login
 */
async function ensureJwt() {
  if (isJwtValid()) return _jwt;

  // Tenta primeiro extrair do Chrome já aberto (mais rápido e sem reCAPTCHA)
  const cdpJwt = await tryExtractFromRunningChrome();
  if (cdpJwt) {
    _jwt   = cdpJwt;
    _jwtAt = Date.now();
    return cdpJwt;
  }

  const { jwt } = await headlessLogin();
  return jwt;
}

/**
 * Chama endpoint do sintetico com JWT autenticado
 */
async function callSintetico(path, params = {}) {
  const jwt = await ensureJwt();
  const url = `${_sinteticoBase}/prest${path}`;

  const res = await axios.get(url, {
    params: { empresa: EMPRESA_ID, unidade: UNIDADE_ID, ...params },
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'empresaId': String(EMPRESA_ID),
      'unidadeId': String(UNIDADE_ID),
    },
    timeout: 20000,
    validateStatus: s => s < 500,
  });

  if (res.status === 401 || res.status === 403) {
    _jwt = null;
    _jwtAt = null;
    const newJwt = await ensureJwt();
    return axios.get(url, {
      params: { empresa: EMPRESA_ID, unidade: UNIDADE_ID, ...params },
      headers: { 'Authorization': `Bearer ${newJwt}`, 'empresaId': String(EMPRESA_ID), 'unidadeId': String(UNIDADE_ID) },
      timeout: 20000,
    });
  }

  return res;
}

async function getMovimentacao() {
  const hoje = new Date().toISOString().split('T')[0];
  const mes  = hoje.slice(0, 8) + '01';
  const res  = await callSintetico('/movimentacao-contratos', { dtIni: mes, dtFim: hoje });
  if (res.status !== 200) throw new Error(`Movimentação retornou ${res.status}`);
  return res.data;
}

async function getFinanceiro() {
  const mes = new Date().toISOString().slice(0, 7);
  const res  = await callSintetico('/financeiro', { mes });
  if (res.status !== 200) throw new Error(`Financeiro retornou ${res.status}`);
  return res.data;
}

async function getInadimplentesLista() {
  const res = await callSintetico('/clientes/inadimplentes', { page: 0, size: 500 });
  if (res.status !== 200) throw new Error(`Inadimplentes retornou ${res.status}`);

  const data = res.data;
  const raw  = data?.content?.clientes || data?.clientes || data?.items || (Array.isArray(data) ? data : []);

  return raw.map(c => ({
    nome:             c.nome || c.nomeCliente || '',
    matricula:        String(c.matricula || c.codigoCliente || ''),
    situacao:         'INADIMPLENTE',
    situacaoContrato: 'INADIMPLENTE',
    telefone:         Array.isArray(c.telefones) ? (c.telefones[0]?.numero || c.telefones[0] || '') : (c.telefone || ''),
    email:            Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
    ultimoAcesso:     c.ultimoAcesso || null,
  })).filter(c => c.nome);
}

/**
 * Injeta JWT manualmente (ex: enviado pelo frontend via bookmarklet/extensão)
 */
function setJwt(jwt) {
  if (!jwt) return false;
  _jwt   = jwt;
  _jwtAt = Date.now();
  console.log(`[HEADLESS] JWT injetado manualmente (${jwt.length} chars)`);
  return true;
}

function getStatus() {
  return {
    active:         isJwtValid(),
    jwtObtainedAt:  _jwtAt ? new Date(_jwtAt).toISOString() : null,
    expiresAt:      _jwtAt ? new Date(_jwtAt + JWT_TTL).toISOString() : null,
    hasCredentials: !!(process.env.PACTO_USER && process.env.PACTO_PASS),
    cdpUrl:         CDP_URL,
  };
}

module.exports = { headlessLogin, ensureJwt, setJwt, getMovimentacao, getFinanceiro, getInadimplentesLista, getStatus };
