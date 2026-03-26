/**
 * PACTO Session Manager
 * Faz login automático via formulário JSF e reutiliza a sessão para
 * chamar os endpoints do sintetico (app.pactosolucoes.com.br/sintetico/prest/...)
 *
 * Configuração: PACTO_USER e PACTO_PASS no .env
 */

const axios = require('axios');
const config = require('../config/apis');

// URL base do PACTO — vem do env (lgn.pactosolucoes.com.br ou app.pactosolucoes.com.br)
const _sinteticoBase = (config.pacto.sinteticoUrl || 'https://lgn.pactosolucoes.com.br/sintetico').replace(/\/$/, '');
const _sinteticoHost = new URL(_sinteticoBase).origin; // ex: https://lgn.pactosolucoes.com.br
const APP_URL        = _sinteticoHost;
const SINTETICO_BASE = `${_sinteticoBase}/prest`;
const LOGIN_URL      = `${APP_URL}/login/`;
// Login JSF sempre em app.pactosolucoes.com.br (lgn não tem JSF)
const JSF_LOGIN_URL  = 'https://app.pactosolucoes.com.br/login/';
const JSF_APP_URL    = 'https://app.pactosolucoes.com.br';
const EMPRESA_ID     = parseInt(config.pacto.empresaId || '4', 10);
const UNIDADE_ID     = parseInt(config.pacto.unidadeId || '4', 10);

// Estado da sessão em memória
let _session = {
  jsessionid: null,
  loggedInAt: null,
  expiresAt: null,
  loginAttempts: 0,
  lastError: null,
};

// Axios sem redirect automático para capturar cookies
const http = axios.create({
  timeout: 15000,
  maxRedirects: 0,
  validateStatus: s => s < 500,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9',
  },
});

function parseCookies(setCookieArr) {
  if (!setCookieArr) return {};
  const arr = Array.isArray(setCookieArr) ? setCookieArr : [setCookieArr];
  const result = {};
  for (const c of arr) {
    const parts = c.split(';')[0].trim();
    const idx = parts.indexOf('=');
    if (idx > 0) result[parts.slice(0, idx)] = parts.slice(idx + 1);
  }
  return result;
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function isSessionValid() {
  if (!_session.jsessionid) return false;
  if (!_session.expiresAt) return false;
  return Date.now() < _session.expiresAt;
}

/**
 * Faz login automático e armazena JSESSIONID
 * Retorna true se bem-sucedido
 */
async function login() {
  const user = process.env.PACTO_USER;
  const pass = process.env.PACTO_PASS;
  const chave = config.pacto.unidadeChave || '24H_NORTE';

  if (!user || !pass) {
    _session.lastError = 'PACTO_USER e PACTO_PASS não configurados no .env';
    console.warn('[PACTO-SESSION]', _session.lastError);
    return false;
  }

  _session.loginAttempts++;
  console.log(`[PACTO-SESSION] Fazendo login automático... (tentativa ${_session.loginAttempts})`);

  try {
    // Passo 1: GET /login/ na JSF → JSESSIONID + ViewState
    const getResp = await http.get(JSF_LOGIN_URL, {
      headers: { 'Cookie': '' },
    });

    const rawCookies = parseCookies(getResp.headers['set-cookie']);
    const jsessionid = rawCookies['JSESSIONID'];
    if (!jsessionid) {
      throw new Error('Não obteve JSESSIONID na página de login');
    }

    // Extrair ViewState do HTML
    const html = getResp.data;
    const vsMatch = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
    const viewState = vsMatch ? vsMatch[1] : '';

    // Passo 2: POST via PrimeFaces AJAX (fmLay:btnEntrar)
    const body = new URLSearchParams({
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': 'fmLay:btnEntrar',
      'javax.faces.partial.execute': 'fmLay',
      'javax.faces.partial.render': 'fmLay:painelGeral fmLay:painelLogado fmLay:painelLogin',
      'fmLay:btnEntrar': 'fmLay:btnEntrar',
      'fmLay': 'fmLay',
      'javax.faces.ViewState': viewState,
      'fmLay:chave': chave,
      'fmLay:usernameLoginZW': user,
      'fmLay:pwdLoginZW': pass,
      'fmLay:pwdLoginRecenteZW': pass,
    });

    const postResp = await http.post(JSF_LOGIN_URL, body.toString(), {
      headers: {
        'Cookie': `JSESSIONID=${jsessionid}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Faces-Request': 'partial/ajax',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': JSF_LOGIN_URL,
        'Origin': JSF_APP_URL,
        'Accept': 'application/xml, text/xml, */*; q=0.01',
      },
    });

    // Passo 3: Verificar resultado do login via resposta AJAX
    const newCookies = parseCookies(postResp.headers['set-cookie']);
    const finalSession = newCookies['JSESSIONID'] || jsessionid;

    const responseText = typeof postResp.data === 'string' ? postResp.data : JSON.stringify(postResp.data);

    // Detectar erros explícitos de credencial no XML de resposta
    // NÃO usar 'fmLay:pwdLoginZW' — o JSF inclui o campo no HTML do painel mesmo em login OK
    const loginFailed = responseText.includes('Usu&#225;rio ou senha inv&#225;lidos') ||
                        responseText.includes('Usuário ou senha inválidos') ||
                        responseText.includes('usuario_ou_senha_invalidos') ||
                        responseText.includes('senha_invalida');

    if (loginFailed) {
      const errMatch = responseText.match(/mensagem[^>]*>([^<]{5,100})</i);
      const errMsg = errMatch ? errMatch[1].trim() : 'Usuário ou senha inválidos';
      throw new Error(errMsg);
    }

    // Passo 4: Tenta trocar JSESSIONID por JWT via /prest/session/{id}
    // (endpoint descoberto no bundle Angular da lgn — não requer reCAPTCHA)
    try {
      const sessionExchangeResp = await axios.get(
        `${JSF_APP_URL}/login/prest/session/${finalSession}`,
        {
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': `JSESSIONID=${finalSession}`,
          },
          timeout: 10000,
          validateStatus: s => s < 500,
        }
      );
      const d = sessionExchangeResp.data || {};
      // Formato: { token: "eyJ..." } ou { content: { token: "eyJ..." } }
      const jwtFromSession = d.token || d.content?.token || d.jwt || d.access_token;
      if (jwtFromSession && jwtFromSession.startsWith('eyJ')) {
        const relay = require('./pactoJwtRelay');
        relay.saveJwt(jwtFromSession, Date.now() + 90 * 60 * 1000);
        console.log(`[PACTO-SESSION] JWT obtido via session exchange! (${jwtFromSession.length} chars)`);
        _session.jsessionid = finalSession;
        _session.loggedInAt = Date.now();
        _session.expiresAt  = Date.now() + 2 * 60 * 60 * 1000;
        _session.lastError  = null;
        _session.loginAttempts = 0;
        return true;
      }
    } catch (_) {}

    // Passo 5: Verificação com JSESSIONID direto no sintetico
    const verifyResp = await http.get(`${JSF_APP_URL}/sintetico/`, {
      headers: { 'Cookie': `JSESSIONID=${finalSession}` },
      maxRedirects: 0,
      validateStatus: s => s < 500,
    }).catch(() => null);

    // Se redirecionar para /login → sessão inválida
    if (!verifyResp || (verifyResp.status === 302 && verifyResp.headers?.location?.includes('login'))) {
      throw new Error('Sessão não confirmada após login — credenciais podem estar incorretas');
    }

    _session.jsessionid = finalSession;
    _session.loggedInAt = Date.now();
    _session.expiresAt = Date.now() + 2 * 60 * 60 * 1000; // 2 horas
    _session.lastError = null;
    _session.loginAttempts = 0;

    console.log(`[PACTO-SESSION] Login OK (JSESSIONID). Sessão válida até ${new Date(_session.expiresAt).toLocaleTimeString('pt-BR')}`);
    return true;

  } catch (err) {
    _session.lastError = err.message;
    console.error('[PACTO-SESSION] Erro no login:', err.message);
    return false;
  }
}

/**
 * Tenta obter JWT via Auth MS (REST — funciona no Vercel sem browser)
 * Salva o JWT no relay para reutilização
 */
async function loginViaAuthMs() {
  const user  = process.env.PACTO_USER;
  const pass  = process.env.PACTO_PASS;
  const chave = config.pacto.unidadeChave || '24H_NORTE';
  const authUrl = (config.pacto.authUrl || 'https://auth.ms.pactosolucoes.com.br').replace(/\/$/, '');

  if (!user || !pass) return null;

  const candidates = [
    { url: `${authUrl}/auth/login`,   body: { login: user, senha: pass, chave } },
    { url: `${authUrl}/login`,        body: { login: user, senha: pass, chave } },
    { url: `${authUrl}/auth/token`,   body: { username: user, password: pass, chave } },
    { url: `${authUrl}/oauth/token`,  body: { grant_type: 'password', username: user, password: pass } },
  ];

  for (const { url, body } of candidates) {
    try {
      const resp = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 12000,
        validateStatus: s => s < 500,
      });
      const d = resp.data || {};
      const jwt = d.token || d.jwt || d.accessToken || d.access_token;
      if (jwt && typeof jwt === 'string' && jwt.startsWith('eyJ')) {
        const expiresAt = d.expiresAt || (d.expires_in ? Date.now() + d.expires_in * 1000 : Date.now() + 90 * 60 * 1000);
        const relay = require('./pactoJwtRelay');
        relay.saveJwt(jwt, expiresAt);
        console.log(`[PACTO-SESSION] Auth MS login OK (${url}). JWT válido por ~90min.`);
        return jwt;
      }
    } catch (_) {}
  }
  console.warn('[PACTO-SESSION] Auth MS: nenhum endpoint retornou JWT válido.');
  return null;
}

/**
 * Garante que existe JWT válido ou sessão JSESSIONID ativa
 * Ordem: 1) JWT relay existente → 2) Auth MS REST → 3) JSESSIONID login
 */
async function ensureSession() {
  // 1. JWT relay já válido?
  try {
    const relay = require('./pactoJwtRelay');
    const existing = relay.loadJwt();
    if (existing) return true;
  } catch (_) {}

  // 2. Tenta obter JWT via Auth MS (funciona no Vercel sem browser)
  const jwt = await loginViaAuthMs();
  if (jwt) return true;

  // 3. Fallback: JSESSIONID cookie via JSF form
  if (isSessionValid()) return true;
  return login();
}

/**
 * Tenta requisição GET no sintetico usando um JWT Bearer
 * Retorna a resposta se for JSON válido (200), null se falhou ou retornou HTML.
 */
async function _jwtGet(url, params, jwt) {
  try {
    const resp = await axios.get(url, {
      params,
      timeout: 20000,
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'empresaId': String(EMPRESA_ID),
        'unidadeId': String(UNIDADE_ID),
      },
      validateStatus: s => s < 500,
    });
    // Rejeita HTML (página de login)
    if (resp.status === 200 && typeof resp.data !== 'string') return resp;
    if (resp.status === 200 && typeof resp.data === 'string' && !resp.data.trim().startsWith('<')) return resp;
    return null;
  } catch (_) { return null; }
}

/**
 * Faz GET em endpoint do sintetico.
 * Ordem: 1) JWT relay existente → 2) Auth MS login → 3) JSESSIONID cookie
 */
async function getsintetico(path, params = {}) {
  const url = `${SINTETICO_BASE}${path}`;
  const relay = require('./pactoJwtRelay');

  // 1. Tenta JWT relay já armazenado
  const existingJwt = relay.loadJwt();
  if (existingJwt) {
    const r = await _jwtGet(url, params, existingJwt);
    if (r) return r;
    console.warn('[PACTO-SESSION] JWT relay existente falhou — tentando re-login Auth MS...');
  }

  // 2. Tenta Auth MS para obter novo JWT automaticamente
  const newJwt = await loginViaAuthMs();
  if (newJwt) {
    const r = await _jwtGet(url, params, newJwt);
    if (r) return r;
    console.warn('[PACTO-SESSION] Auth MS JWT também falhou no sintetico.');
  }

  // 3. JSESSIONID — só útil se o relay de JWT foi obtido via session exchange em login()
  //    Se não há JWT no relay após login, lgn sintetico não aceita JSESSIONID → pular
  const jwtAfterLogin = relay.loadJwt();
  if (jwtAfterLogin) {
    // login() pode ter obtido JWT via session exchange — tenta novamente
    const r = await _jwtGet(url, params, jwtAfterLogin);
    if (r) return r;
  }

  const ok = await ensureSession();
  if (!ok) throw new Error(_session.lastError || 'Sem sessão PACTO (JWT necessário — abra o Chrome com iniciar-24h.bat)');

  const sessionHeaders = {
    'Cookie': `JSESSIONID=${_session.jsessionid}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${JSF_APP_URL}/sintetico/`,
  };

  const response = await axios.get(url, {
    params,
    timeout: 20000,
    headers: sessionHeaders,
    validateStatus: s => s < 500,
  });

  // Rejeita resposta HTML (página de login retornada quando JSESSIONID é inválido)
  if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
    throw new Error('Sintetico retornou HTML com JSESSIONID — JWT necessário (use iniciar-24h.bat)');
  }

  if (response.status === 401 || response.status === 403) {
    // Sessão expirou — forçar re-login
    console.warn('[PACTO-SESSION] Sessão expirada, refazendo login...');
    _session.jsessionid = null;
    _session.expiresAt = null;
    const relogged = await login();
    if (!relogged) throw new Error('Re-login falhou');

    // Retry
    return axios.get(url, {
      params,
      timeout: 20000,
      headers: {
        ...sessionHeaders,
        'Cookie': `JSESSIONID=${_session.jsessionid}`,
      },
    });
  }

  return response;
}

/**
 * Busca dados de movimentação de contratos do mês atual
 */
async function getMovimentacao() {
  const hoje = new Date().toISOString().split('T')[0]; // "2026-03-21"
  const mes = hoje.slice(0, 8) + '01';                  // "2026-03-01"

  const resp = await getsintetico('/movimentacao-contratos', {
    empresa: EMPRESA_ID,
    unidade: UNIDADE_ID,
    dtIni: mes,
    dtFim: hoje,
  });

  if (resp.status !== 200) {
    throw new Error(`Movimentação retornou ${resp.status}`);
  }
  return resp.data;
}

/**
 * Busca dados financeiros do mês atual
 */
async function getFinanceiro() {
  const hoje = new Date().toISOString().split('T')[0];
  const mes = hoje.slice(0, 7); // "2026-03"

  const resp = await getsintetico('/financeiro', {
    empresa: EMPRESA_ID,
    unidade: UNIDADE_ID,
    mes,
  });

  if (resp.status !== 200) {
    throw new Error(`Financeiro retornou ${resp.status}`);
  }
  return resp.data;
}

/**
 * Busca lista nominal de inadimplentes via sintetico autenticado
 */
async function getInadimplentesLista() {
  const resp = await getsintetico('/clientes/inadimplentes', {
    empresa: EMPRESA_ID,
    unidade: UNIDADE_ID,
    page: 0,
    size: 500,
  });

  if (resp.status !== 200) {
    throw new Error(`Inadimplentes retornou ${resp.status}`);
  }

  const data = resp.data;
  // Normalizar qualquer estrutura de resposta
  const raw = data?.content?.clientes || data?.clientes || data?.items || (Array.isArray(data) ? data : []);

  return raw.map(c => ({
    nome:             c.nome || c.nomeCliente || '',
    matricula:        String(c.matricula || c.codigoCliente || c.id || ''),
    situacao:         'INADIMPLENTE',
    situacaoContrato: 'INADIMPLENTE',
    telefone:         Array.isArray(c.telefones) ? (c.telefones[0]?.numero || c.telefones[0] || '') : (c.telefone || ''),
    email:            Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
    ultimoAcesso:     c.ultimoAcesso || null,
    datamatricula:    c.datamatricula || null,
  })).filter(c => c.nome);
}

/**
 * Busca leads ativos do CRM via personagem MS com JWT
 * (Tenta com JWT extraído da sessão, se disponível)
 */
async function getLeadsCrm() {
  // O personagem MS usa JWT Bearer, não JSESSIONID
  // Tentar via API key como fallback
  try {
    const resp = await axios.get(`${config.pacto.personagemUrl}/crm/leads`, {
      params: { empresa: EMPRESA_ID, unidade: UNIDADE_ID, situacao: 'ABERTO', size: 1 },
      headers: { 'Authorization': `Bearer ${config.pacto.apiKey}` },
      timeout: 10000,
    });
    if (resp.data?.totalElements !== undefined) return resp.data;
  } catch (_) {}
  return null;
}

/**
 * Retorna status da sessão atual
 */
function getSessionStatus() {
  return {
    active: isSessionValid(),
    loggedInAt: _session.loggedInAt ? new Date(_session.loggedInAt).toISOString() : null,
    expiresAt: _session.expiresAt ? new Date(_session.expiresAt).toISOString() : null,
    lastError: _session.lastError,
    hasCredentials: !!(process.env.PACTO_USER && process.env.PACTO_PASS),
  };
}

function getJsessionid() { return _session.jsessionid; }

module.exports = { login, ensureSession, getMovimentacao, getFinanceiro, getInadimplentesLista, getLeadsCrm, getSessionStatus, getJsessionid };
