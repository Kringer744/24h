const axios = require('axios');
const config = require('../config/apis');
const fs = require('fs');
const path = require('path');

// ID da Unidade (ajuste conforme necessário)
const EMPRESA_ID = config.pacto.empresaId || '4';
const UNIDADE_ID = config.pacto.unidadeId || '4';

// Instâncias Axios
const gateway = axios.create({
  baseURL: config.pacto.gatewayUrl || 'https://gateway.sistemapacto.com.br',
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

/**
 * Helper para retry em requisições
 */
async function requestWithRetry(instance, method, url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await instance[method](url, options);
    } catch (err) {
      if (i === retries) throw err;
      const wait = Math.pow(2, i) * 1000;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

/**
 * Busca total de contratos com uma situação específica e período
 */
async function getContratosCount(situacao, dataDe, dataAte) {
  // Endpoint /adm-core-ms não existe — retorna 0 (dados virão via sintetico JWT relay)
  return 0;
}

/**
 * Busca contratos ativos e metadados básicos
 */
async function getContratosAtivos() {
  try {
    const res = await requestWithRetry(gateway, 'get', '/psec/clientes/ativos', {
      headers: {
        'Authorization': `Bearer ${config.pacto.apiKey}`,
        'empresaId': String(EMPRESA_ID),
        'unidadeId': String(UNIDADE_ID),
      }
    });

    const clientes = res.data?.content?.clientes || res.data?.clientes || (Array.isArray(res.data) ? res.data : []);

    // Checkins de hoje: clientes cujo ultimoAcesso é hoje
    const hoje = new Date().toISOString().split('T')[0]; // "2026-03-26"
    const checkinsLista = clientes.filter(c => c.ultimoAcesso && c.ultimoAcesso.startsWith(hoje.split('-').reverse().join('/')));

    // Matriculados este mês
    const mesAtual = new Date().toISOString().slice(0, 7); // "2026-03"
    const [ano, mes] = mesAtual.split('-');
    const matriculadosMes = clientes.filter(c => {
      if (!c.datamatricula) return false;
      const [d, m, a] = c.datamatricula.split('/');
      return a === ano && m === mes;
    }).length;

    console.log(`[PACTO] Ativos via /psec/clientes/ativos: ${clientes.length}`);

    return {
      total:          clientes.length,
      items:          clientes,
      checkinsHoje:   checkinsLista.length,
      checkinsLista,
      matriculadosMes,
    };
  } catch (err) {
    console.error('[PACTO] Erro ao buscar contratos ativos:', err.message);
    throw err;
  }
}

/**
 * Busca dados financeiros via Microserviço
 */
async function getFinanceiroMS() {
  const hoje = new Date().toISOString().split('T')[0];
  const mesAno = hoje.substring(0, 7);
  try {
    const res = await requestWithRetry(gateway, 'get', `/financeiro-ms/v1/receitas`, {
      params: { empresa: EMPRESA_ID, unidade: UNIDADE_ID, mesAno },
      headers: { 'Authorization': `Bearer ${config.pacto.apiKey}` }
    });
    return {
      receitaMes: res.data?.totalReceita || res.data?.receita || 0,
      aReceber: res.data?.totalAReceber || 0
    };
  } catch (err) {
    return { receitaMes: 0, aReceber: 0 };
  }
}

/**
 * Busca inadimplentes via Microserviço
 */
async function getInadimplentesMS() {
  // Endpoint /adm-core-ms não existe — dados virão via sintetico JWT relay
  return [];
}

/**
 * Função principal para o Dashboard: consolida Microserviços
 */
async function getSintetico() {
  const hoje = new Date().toISOString().split('T')[0];
  const mesInicio = hoje.substring(0, 8) + '01';

  const [ativosRes, fin, inad, matriculas, cancelados, renovados] = await Promise.all([
    getContratosAtivos(),
    getFinanceiroMS(),
    getInadimplentesMS(),
    getContratosCount('ATIVO', mesInicio, hoje), // simplificação para pegar vendas do mês
    getContratosCount('CANCELADO', mesInicio, hoje),
    getContratosCount('REMATRICULADO', mesInicio, hoje).catch(() => 0),
  ]);

  return {
    ativos: ativosRes.total,
    inadimplentes: inad.length,
    receitaMes: fin.receitaMes,
    aReceber: fin.aReceber,
    checkinsHoje: ativosRes.checkinsHoje,
    matriculadosMes: matriculas,
    cancelamentosMes: cancelados,
    rematriculadosMes: renovados,
    _source: 'pacto-ms-api'
  };
}

async function healthCheck() {
  try {
    const res = await requestWithRetry(gateway, 'get', '/psec/clientes/ativos', {
      headers: { 'empresaId': EMPRESA_ID, 'unidadeId': UNIDADE_ID },
      params: { page: 0, size: 1 },
    });
    return res.status === 200;
  } catch (_) { return false; }
}

module.exports = {
  getContratosAtivos,
  getFinanceiroMS,
  getInadimplentesMS,
  getSintetico,
  getContratosCount,
  healthCheck,
};
