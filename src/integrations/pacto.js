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

    // Helper: parse dd/mm/yyyy or ISO date string → Date object
    const parseDate = (str) => {
      if (!str) return null;
      const parts = str.split('/');
      if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      return new Date(str);
    };

    // Checkins de hoje: clientes cujo ultimoAcesso é hoje
    const hojeISO = new Date().toISOString().split('T')[0]; // "2026-03-26"
    const checkinsLista = clientes.filter(c => c.ultimoAcesso && c.ultimoAcesso.startsWith(hojeISO.split('-').reverse().join('/')));

    // Matriculados este mês
    const mesAtual = new Date().toISOString().slice(0, 7); // "2026-03"
    const [ano, mes] = mesAtual.split('-');
    const matriculadosMes = clientes.filter(c => {
      if (!c.datamatricula) return false;
      const [d, m, a] = c.datamatricula.split('/');
      return a === ano && m === mes;
    }).length;

    // Contratos vencendo nos próximos 30 dias e já vencidos (derivado de fimContrato)
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const limite30 = new Date(hoje.getTime() + 30 * 24 * 60 * 60 * 1000);
    let renovacoes30d = 0;
    let vencidos = 0;
    let agregadores = 0;
    clientes.forEach(c => {
      // Vencidos / renovações
      const fim = parseDate(c.fimContrato || c.dataFimContrato || c.vencimento);
      if (fim && !isNaN(fim)) {
        if (fim < hoje) vencidos++;
        else if (fim <= limite30) renovacoes30d++;
      }
      // Dependentes / agregadores
      const tipo = (c.tipo || c.tipoContrato || '').toString().toUpperCase();
      if (tipo === 'DEP' || tipo === 'DEPENDENTE' || tipo === 'AGR' || tipo === 'AGREGADOR'
          || c.dependente === true || c.agregador === true || c.clienteAgregador === true) {
        agregadores++;
      }
    });

    console.log(`[PACTO] Ativos: ${clientes.length} | Renov30d: ${renovacoes30d} | Vencidos: ${vencidos} | Agreg: ${agregadores}`);

    return {
      total:          clientes.length,
      items:          clientes,
      checkinsHoje:   checkinsLista.length,
      checkinsLista,
      matriculadosMes,
      renovacoes30d,
      vencidos,
      agregadores,
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
    ativos:           ativosRes.total,
    inadimplentes:    inad.length || ativosRes.vencidos || 0,
    receitaMes:       fin.receitaMes,
    aReceber:         fin.aReceber,
    checkinsHoje:     ativosRes.checkinsHoje,
    matriculadosMes:  matriculas || ativosRes.matriculadosMes || 0,
    cancelamentosMes: cancelados,
    rematriculadosMes: renovados,
    renovacoes30d:    ativosRes.renovacoes30d || 0,
    vencidos:         ativosRes.vencidos      || 0,
    agregadores:      ativosRes.agregadores   || 0,
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

/**
 * Lista clientes genérica (fallback para /api/alunos quando cache vazio)
 */
async function getClientes(params = {}) {
  try {
    const res = await requestWithRetry(gateway, 'get', '/psec/clientes/ativos', {
      headers: {
        'Authorization': `Bearer ${config.pacto.apiKey}`,
        'empresaId': String(EMPRESA_ID),
        'unidadeId': String(UNIDADE_ID),
      },
      params: { page: params.page || 0, size: params.size || 50 },
    });
    const clientes = res.data?.content?.clientes || res.data?.clientes || (Array.isArray(res.data) ? res.data : []);
    return clientes;
  } catch (err) {
    console.error('[PACTO] getClientes erro:', err.message);
    return [];
  }
}

/**
 * Busca cliente por matrícula
 */
async function getClienteById(id) {
  try {
    const res = await requestWithRetry(gateway, 'get', `/psec/clientes/${id}`, {
      headers: {
        'Authorization': `Bearer ${config.pacto.apiKey}`,
        'empresaId': String(EMPRESA_ID),
        'unidadeId': String(UNIDADE_ID),
      },
    });
    return res.data;
  } catch (err) {
    throw new Error(`Cliente ${id} não encontrado: ${err.message}`);
  }
}

/**
 * Inadimplentes — tenta gateway, fallback para lista vazia
 */
async function getContratosInadimplentes() {
  // Sem endpoint de gateway disponível — retorna lista do cache ou vazia
  const cache = require('../storage/cache');
  const cached = cache.get('inadimplentes_lista');
  if (cached?.items?.length) return cached.items;
  return [];
}

module.exports = {
  getContratosAtivos,
  getFinanceiroMS,
  getInadimplentesMS,
  getSintetico,
  getContratosCount,
  getClientes,
  getClienteById,
  getContratosInadimplentes,
  healthCheck,
};
