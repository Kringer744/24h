/**
 * PACTO CRM Integration
 * API Gateway: https://apigw.pactosolucoes.com.br
 * Auth: Bearer token (API Key) via Authorization header
 *
 * Endpoints confirmados:
 *  GET /v1/cliente/situacao={situacao}   → clientes por situação
 *  GET /clientes                          → lista clientes (sem totalElements)
 *  GET /contratos/by-pessoa/{id}          → contratos por pessoa
 */

const axios = require('axios');
const config = require('../config/apis');

const EMPRESA_ID = parseInt(config.pacto.empresaId || '4', 10);
const UNIDADE_ID = parseInt(config.pacto.unidadeId || '4', 10);
const PAGE_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const gateway = axios.create({
  baseURL: config.pacto.gatewayUrl,
  headers: {
    'Authorization': `Bearer ${config.pacto.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

const personagem = axios.create({
  baseURL: config.pacto.personagemUrl,
  headers: {
    'Authorization': `Bearer ${config.pacto.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

const sintetico = axios.create({
  baseURL: config.pacto.sinteticoUrl,
  headers: {
    'Authorization': `Bearer ${config.pacto.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Retry Wrapper for 429
async function requestWithRetry(client, method, url, config = {}, retries = 2) {
  try {
    return await client[method](url, config);
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      const wait = (3 - retries) * 1000 + Math.random() * 500;
      console.warn(`[PACTO] 429 Detectado. Retrying in ${Math.round(wait)}ms...`);
      await new Promise(r => setTimeout(r, wait));
      return requestWithRetry(client, method, url, config, retries - 1);
    }
    throw err;
  }
}

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────

const _cache = {};

function cacheGet(key) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.value;
  return null;
}

function cacheSet(key, value) {
  _cache[key] = { value, ts: Date.now() };
}

// ─── PAGINATION HELPER ───────────────────────────────────────────────────────

/**
 * Fetches all pages of a paginated endpoint in parallel.
 * First fetches page 0 to determine totalPages, then fetches remaining pages.
 * @param {string} path
 * @param {string} situacao - 'ATIVO' | 'INATIVO'
 * @returns {Array} all content items
 */
async function fetchAllPages(situacao) {
  const cacheKey = `clientes_${situacao}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let all = [];
  let page = 0;
  let done = false;

  console.log(`[PACTO] Buscando todos os clientes ${situacao}...`);

  while (!done) {
    try {
      const res = await gateway.get(`/v1/cliente/situacao=${situacao}`, {
        params: { page, size: PAGE_SIZE },
      });
      
      const items = res.data?.content || res.data || [];
      if (items.length === 0) {
        done = true;
        break;
      }
      
      all.push(...items);
      
      if (items.length < PAGE_SIZE) {
        done = true;
        break;
      }
      
      page++;
      // Limite de segurança para evitar loops infinitos
      if (page > 100) {
        console.warn('[PACTO] Limite de 100 páginas atingido. Parando sync.');
        break;
      }
    } catch (err) {
      console.error(`[PACTO] Erro ao buscar página ${page} (${situacao}):`, err.message);
      // Lança o erro para que o chamador saiba que a coleta falhou e use o cache
      throw new Error(`Falha no sync do PACTO na página ${page}`);
    }
  }

  console.log(`[PACTO] Total de clientes ${situacao} encontrados: ${all.length}`);
  cacheSet(cacheKey, all);
  return all;
}

// ─── CLIENTES / ALUNOS ──────────────────────────────────────────────────────

/**
 * Total de Ativos via endpoint dedicado (/psec/clientes/ativos)
 * Retorna os números exatos e deriva métricas de check-in e matrículas do mês.
 */
async function getContratosAtivos() {
  try {
    const res = await requestWithRetry(gateway, 'get', '/psec/clientes/ativos', {
      headers: { 'empresaId': EMPRESA_ID, 'unidadeId': UNIDADE_ID }
    });

    if (res.data?.content?.clientes) {
      const clientes = res.data.content.clientes;
      const total = clientes.length;
      console.log(`[PACTO] Ativos via /psec/clientes/ativos: ${total}`);

      // ── Derivar métricas a partir dos dados dos clientes ──────────────
      const hojeStr = new Date().toLocaleDateString('pt-BR'); // "20/03/2026"
      const mesAtual = hojeStr.substring(3); // "03/2026"

      let checkinsHoje = 0;
      let matriculadosMes = 0;
      const checkinsLista = [];

      clientes.forEach(c => {
        // Check-ins: quem acessou hoje
        if (c.ultimoAcesso && c.ultimoAcesso.startsWith(hojeStr)) {
          checkinsHoje++;
          checkinsLista.push({
            nome:      c.nome,
            matricula: c.matricula,
            horario:   c.ultimoAcesso.substring(11), // "07:17"
          });
        }
        // Matrículas do mês (datamatricula = "DD/MM/YYYY")
        if (c.datamatricula && c.datamatricula.substring(3) === mesAtual) {
          matriculadosMes++;
        }
      });

      console.log(`[PACTO] Check-ins hoje: ${checkinsHoje} | Matriculados mês: ${matriculadosMes}`);

      return {
        total,
        items: clientes,
        checkinsHoje,
        checkinsLista,
        matriculadosMes,
      };
    }

    // Fallback
    console.warn('[PACTO] /psec/clientes/ativos sem clientes. Tentando v1...');
    const resV1 = await requestWithRetry(gateway, 'get', '/v1/cliente/situacao=ATIVO', {
      params: { page: 0, size: 1 }
    });
    const totalV1 = resV1.data?.totalElements || resV1.data?.total || 0;
    return { total: totalV1, items: [], checkinsHoje: 0, checkinsLista: [], matriculadosMes: 0 };

  } catch (err) {
    console.error('[PACTO] Erro ao buscar ativos:', err.message);
    return { total: 0, items: [], checkinsHoje: 0, checkinsLista: [], matriculadosMes: 0 };
  }
}

/**
 * Lista de inadimplentes via /psec/clientes/inadimplentes (mesmo padrão dos ativos)
 * Fallback para /v1/cliente/situacao=INADIMPLENTE
 */
async function getContratosInadimplentes() {
  // Tenta endpoint dedicado (mesmo padrão do /psec/clientes/ativos)
  try {
    const res = await requestWithRetry(gateway, 'get', '/psec/clientes/inadimplentes', {
      headers: { 'empresaId': EMPRESA_ID, 'unidadeId': UNIDADE_ID }
    });

    if (res.data?.content?.clientes?.length > 0) {
      const clientes = res.data.content.clientes;
      console.log(`[PACTO] Inadimplentes via /psec/clientes/inadimplentes: ${clientes.length}`);
      return clientes.map(c => ({
        nome:        c.nome || '',
        matricula:   String(c.matricula || ''),
        situacao:    'INADIMPLENTE',
        situacaoContrato: c.situacaoContrato || 'INADIMPLENTE',
        telefone:    Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
        email:       Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
        ultimoAcesso: c.ultimoAcesso || null,
      }));
    }
  } catch (e) {
    console.warn('[PACTO] /psec/clientes/inadimplentes falhou:', e.message);
  }

  // Fallback: /v1/cliente/situacao=INADIMPLENTE com paginação
  try {
    console.log('[PACTO] Tentando /v1/cliente/situacao=INADIMPLENTE...');
    const res = await requestWithRetry(gateway, 'get', '/v1/cliente/situacao=INADIMPLENTE', {
      params: { page: 0, size: 200 },
      headers: { 'empresaId': EMPRESA_ID, 'unidadeId': UNIDADE_ID }
    });
    const items = res.data?.content || res.data || [];
    const arr = Array.isArray(items) ? items : [];
    if (arr.length > 0) {
      console.log(`[PACTO] Inadimplentes via v1: ${arr.length}`);
      return arr.map(c => ({
        nome:        c.nome || '',
        matricula:   String(c.matricula || ''),
        situacao:    'INADIMPLENTE',
        situacaoContrato: 'INADIMPLENTE',
        telefone:    Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
        email:       Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
        ultimoAcesso: null,
      }));
    }
  } catch (e) {
    console.warn('[PACTO] /v1/cliente/situacao=INADIMPLENTE falhou:', e.message);
  }

  // Fallback 3: /v1/cliente?situacaoContrato=INADIMPLENTE (paginado)
  try {
    console.log('[PACTO] Tentando /v1/cliente?situacaoContrato=INADIMPLENTE...');
    let all = [], page = 0, done = false;
    while (!done) {
      const res = await requestWithRetry(gateway, 'get', '/v1/cliente', {
        params: { situacaoContrato: 'INADIMPLENTE', page, size: 100 },
        headers: { 'empresaId': EMPRESA_ID, 'unidadeId': UNIDADE_ID }
      });
      const items = res.data?.content || res.data?.clientes || (Array.isArray(res.data) ? res.data : []);
      if (!Array.isArray(items) || items.length === 0) { done = true; break; }
      all.push(...items);
      if (items.length < 100) { done = true; break; }
      page++;
      if (page > 20) break;
    }
    if (all.length > 0) {
      console.log(`[PACTO] Inadimplentes via /v1/cliente?situacaoContrato: ${all.length}`);
      return all.map(c => ({
        nome:        c.nome || '',
        matricula:   String(c.matricula || c.codigoCliente || ''),
        situacao:    'INADIMPLENTE',
        situacaoContrato: 'INADIMPLENTE',
        telefone:    Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
        email:       Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
        ultimoAcesso: null,
      }));
    }
  } catch (e) {
    console.warn('[PACTO] /v1/cliente?situacaoContrato=INADIMPLENTE falhou:', e.message);
  }

  // Fallback 4: /psec/clientes/inadimplentes-parcela
  try {
    const res = await requestWithRetry(gateway, 'get', '/psec/clientes/inadimplentes-parcela', {
      headers: { 'empresaId': EMPRESA_ID, 'unidadeId': UNIDADE_ID }
    });
    const clientes = res.data?.content?.clientes || [];
    if (clientes.length > 0) {
      console.log(`[PACTO] Inadimplentes via inadimplentes-parcela: ${clientes.length}`);
      return clientes.map(c => ({
        nome:        c.nome || '',
        matricula:   String(c.matricula || ''),
        situacao:    'INADIMPLENTE',
        situacaoContrato: 'INADIMPLENTE',
        telefone:    Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
        email:       Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
        ultimoAcesso: null,
      }));
    }
  } catch (_) {}

  // Fallback 5: /psec/clientes/cancelados — no PACTO desta academia, cancelados = inadimplentes
  try {
    console.log('[PACTO] Tentando /psec/clientes/cancelados como proxy de inadimplentes...');
    const res = await requestWithRetry(gateway, 'get', '/psec/clientes/cancelados', {
      headers: { 'empresaId': EMPRESA_ID, 'unidadeId': UNIDADE_ID }
    });
    const clientes = res.data?.content?.clientes || res.data?.clientes || (Array.isArray(res.data) ? res.data : []);
    if (clientes.length > 0) {
      console.log(`[PACTO] Cancelados (proxy inadimplentes): ${clientes.length}`);
      return clientes.map(c => ({
        nome:        c.nome || '',
        matricula:   String(c.matricula || ''),
        situacao:    'CANCELADO',
        situacaoContrato: c.situacaoContrato || 'CANCELADO',
        telefone:    Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
        email:       Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
        ultimoAcesso: c.ultimoAcesso || null,
      }));
    }
  } catch (_) {}

  // Fallback 6: /v1/cliente/situacao=CANCELADO
  try {
    console.log('[PACTO] Tentando /v1/cliente/situacao=CANCELADO...');
    let all = [], page = 0, done = false;
    while (!done) {
      const res = await requestWithRetry(gateway, 'get', '/v1/cliente/situacao=CANCELADO', {
        params: { page, size: 100 },
        headers: { 'empresaId': EMPRESA_ID, 'unidadeId': UNIDADE_ID }
      });
      const items = res.data?.content || res.data?.clientes || (Array.isArray(res.data) ? res.data : []);
      if (!Array.isArray(items) || items.length === 0) { done = true; break; }
      all.push(...items);
      if (items.length < 100) { done = true; break; }
      page++;
      if (page > 20) break;
    }
    if (all.length > 0) {
      console.log(`[PACTO] Cancelados via v1: ${all.length}`);
      return all.map(c => ({
        nome:        c.nome || '',
        matricula:   String(c.matricula || c.codigoCliente || ''),
        situacao:    'CANCELADO',
        situacaoContrato: c.situacaoContrato || 'CANCELADO',
        telefone:    Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
        email:       Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
        ultimoAcesso: null,
      }));
    }
  } catch (_) {}

  console.warn('[PACTO] Nenhum endpoint de inadimplentes retornou dados.');
  return [];
}

/**
 * Retorna o total de contratos para uma situação específica e período.
 * Útil para fallbacks quando o sintetico (JWT) falha.
 */
async function getContratosCount(situacao, dataDe, dataAte) {
  try {
    const res = await requestWithRetry(gateway, 'get', '/adm-core-ms/v1/contratos', {
      params: { 
        empresa: EMPRESA_ID, 
        unidade: UNIDADE_ID, 
        situacao, 
        dataDe, 
        dataAte, 
        size: 1 
      }
    });
    return res.data?.totalElements || res.data?.total || 0;
  } catch (err) {
    console.error(`[PACTO] Erro ao buscar total de ${situacao}:`, err.message);
    return 0;
  }
}

/**
 * Total de cancelados via endpoint de Relatório ou via listagem filtrada.
 */
async function getContratosCancelados(dataDe, dataAte) {
  if (dataDe && dataAte) {
    return { total: await getContratosCount('CANCELADO', dataDe, dataAte) };
  }
  // Legado / Total geral
  try {
    const res = await requestWithRetry(gateway, 'get', '/rel-clientes/situacao', {
      params: { 
        page: 0, 
        size: 1,
        filters: `situacao=INATIVO;empresaId=${EMPRESA_ID}` 
      }
    });
    return { total: res.data?.totalElements || res.data?.total || 0 };
  } catch (err) {
    return { total: await getContratosCount('CANCELADO') };
  }
}

/**
 * Lista clientes paginada (sem totalElements, inclui situacao/situacaoContrato).
 */
async function getClientes(params = {}) {
  const res = await gateway.get('/clientes', { params });
  return res.data;
}

async function getClienteById(id) {
  const res = await gateway.get(`/v1/cliente/${id}`);
  return res.data;
}

// ─── CRM / LEADS ────────────────────────────────────────────────────────────

async function getCrmLeads(params = {}) {
  const res = await requestWithRetry(personagem, 'get', '/crm/leads', {
    params: { empresa: EMPRESA_ID, unidade: UNIDADE_ID, size: 1, ...params }
  });
  return res.data;
}

async function createCrmLead(lead) {
  const res = await gateway.post('/crm/leads', lead);
  return res.data;
}

async function updateCrmLead(id, data) {
  const res = await gateway.put(`/crm/leads/${id}`, data);
  return res.data;
}

// ─── CONTRATOS ──────────────────────────────────────────────────────────────

async function getContratos(params = {}) {
  const res = await gateway.get('/contratos/by-pessoa/1', { params });
  return res.data;
}

// ─── SINTETICO ───────────────────────────────────────────────────────────────

/**
 * Busca dados financeiros do mês atual via Microserviço de Financeiro
 * Não requer login, apenas API Key.
 */
async function getFinanceiroMS() {
  const hoje = new Date().toISOString().split('T')[0];
  const mesAno = hoje.substring(0, 7); // "2026-03"
  
  try {
    const res = await requestWithRetry(gateway, 'get', `/financeiro-ms/v1/receitas`, {
      params: { empresa: EMPRESA_ID, unidade: UNIDADE_ID, mesAno },
      headers: { 'Authorization': `Bearer ${config.pacto.apiKey}` }
    });
    
    // O pacto costuma retornar { totalReceita, totalAReceber, ... }
    return {
      receitaMes: res.data?.totalReceita || res.data?.receita || 0,
      aReceber:   res.data?.totalAReceber || 0,
      _raw: res.data
    };
  } catch (err) {
    console.error('[PACTO] Erro ao buscar Financeiro MS:', err.message);
    return { receitaMes: 0, aReceber: 0 };
  }
}

/**
 * Busca lista nominal de inadimplentes via Microserviço de Contratos
 */
async function getInadimplentesMS() {
  try {
    const res = await requestWithRetry(gateway, 'get', `/adm-core-ms/v1/contratos`, {
      params: { 
        empresa: EMPRESA_ID, 
        unidade: UNIDADE_ID, 
        situacao: 'INADIMPLENTE',
        size: 500
      },
      headers: { 'Authorization': `Bearer ${config.pacto.apiKey}` }
    });
    
    const items = res.data?.content || [];
    return items.map(c => ({
      nome:             c.nomeCliente || c.nome || '',
      matricula:        String(c.matricula || c.codigoCliente || ''),
      situacao:         'INADIMPLENTE',
      situacaoContrato: 'INADIMPLENTE',
      telefone:         Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
      email:            Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
    }));
  } catch (err) {
    console.error('[PACTO] Erro ao buscar Inadimplentes MS:', err.message);
    return [];
  }
}

async function getSintetico() {
  // Agora buscamos via MS para garantir que funcione no Vercel
  const fin = await getFinanceiroMS();
  const inad = await getInadimplentesMS();
  const ativosRes = await getContratosAtivos();

  return {
    ativos: ativosRes.total,
    inadimplentes: inad.length,
    receitaMes: fin.receitaMes,
    aReceber: fin.aReceber,
    checkinsHoje: ativosRes.checkinsHoje,
    matriculadosMes: ativosRes.matriculadosMes,
    _source: 'pacto-ms-api'
  };
}

// ─── ACESSOS / CHECK-IN ─────────────────────────────────────────────────────

async function getAcessos(params = {}) {
  try {
    const res = await gateway.get('/relatorio/acessos', { params });
    return res.data;
  } catch (_) {
    return null;
  }
}

// ─── PLANOS ─────────────────────────────────────────────────────────────────

async function getPlanos() {
  const res = await gateway.get('/planos');
  return res.data;
}

// ─── HEALTH CHECK ───────────────────────────────────────────────────────────

async function healthCheck() {
  try {
    const res = await gateway.get('/v1/cliente/situacao=ATIVO', {
      params: { page: 0, size: 1 },
    });
    return { gateway: res.status === 200 ? 'ok' : 'down' };
  } catch (err) {
    return { gateway: 'down', error: err.message };
  }
}

module.exports = {
  getClientes,
  getClienteById,
  getCrmLeads,
  createCrmLead,
  updateCrmLead,
  getContratos,
  getContratosAtivos,
  getContratosInadimplentes,
  getContratosCancelados,
  getContratosCount,
  getSintetico,
  getAcessos,
  getPlanos,
  healthCheck,
};
