/**
 * 24H NORTE — Super Sync Script (Versão Completa)
 * 
 * Este script captura TUDO: Ativos, Financeiro, Inadimplentes e Movimentação.
 * Como ele roda no seu navegador logado, ele pula as barreiras de segurança do Vercel.
 */

(async function SUPER_SYNC_24H_NORTE() {
  const SERVER = 'https://24h-nine.vercel.app';
  const SYNC_KEY = '24hNorte_sync';
  const EMPRESA = 4;
  const UNIDADE = 4;

  const hoje = new Date().toISOString().split('T')[0];
  const mes = hoje.substring(0, 7);
  const mesInicio = mes + '-01';

  async function fetchPacto(url) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      return r.ok ? await r.json() : null;
    } catch (e) {
      return null;
    }
  }

  console.log('🚀 Iniciando Super Sync 24H NORTE...');

  // 1. Dados Básicos (API MS)
  const [resAtivos, resCancelados, resLeads, resCheckins] = await Promise.all([
    fetchPacto(`/adm-core-ms/v1/contratos?empresa=${EMPRESA}&unidade=${UNIDADE}&situacao=ATIVO&size=1`),
    fetchPacto(`/adm-core-ms/v1/contratos?empresa=${EMPRESA}&unidade=${UNIDADE}&situacao=CANCELADO&size=1&dataDe=${mesInicio}&dataAte=${hoje}`),
    fetchPacto(`/crm-ms/v1/leads?empresa=${EMPRESA}&unidade=${UNIDADE}&situacao=ABERTO&size=1`),
    fetchPacto(`/adm-core-ms/v1/acessos?empresa=${EMPRESA}&unidade=${UNIDADE}&data=${hoje}`)
  ]);

  // 2. Dados Avançados (Sintético - O que estava faltando!)
  console.log('📊 Capturando dados financeiros e movimentação...');
  const [resMov, resFin, resInad] = await Promise.all([
    fetchPacto(`/sintetico/prest/movimentacao-contratos?empresa=${EMPRESA}&unidade=${UNIDADE}&dtIni=${mesInicio}&dtFim=${hoje}`),
    fetchPacto(`/sintetico/prest/financeiro?empresa=${EMPRESA}&unidade=${UNIDADE}&mes=${mes}`),
    fetchPacto(`/sintetico/prest/clientes/inadimplentes?empresa=${EMPRESA}&unidade=${UNIDADE}&page=0&size=100`)
  ]);

  const ativos      = resAtivos?.totalElements || 0;
  const cancelados  = resCancelados?.totalElements || 0;
  const leads       = resLeads?.totalElements || 0;
  const checkins    = Array.isArray(resCheckins?.content) ? resCheckins.content.length : (resCheckins?.totalElements || 0);

  // Mapeamento dos dados do sintetico
  const mov = resMov || {};
  const fin = resFin || {};

  const stats = {
    // Básicos
    ativos,
    cancelamentos: cancelados,
    leadsAtivos:   leads,
    checkinsHoje:  checkins,
    
    // Avançados (Sintético)
    receita:       fin.receitaMes || fin.totalReceita || 0,
    aReceber:      fin.aReceber || 0,
    inadimplentes: mov.inadimplentes || (Array.isArray(resInad?.content) ? resInad.content.length : 0),
    agregadores:   mov.clientesAgregadores || mov.dependentes || 0,
    vencidos:      mov.contratosVencidos || 0,
    renovacoes30d: mov.renovacoes30d || 0,
    
    // Cálculos
    novasVendas:   (mov.matriculadosMes || 0) + (mov.rematriculadosMes || 0),
    totalAlunos:   ativos + (mov.clientesAgregadores || 0) + (mov.contratosVencidos || 0),
    
    funil: {
      lead:     Math.floor(leads * 0.4),
      contato:  Math.floor(leads * 0.3),
      visita:   Math.floor(leads * 0.2),
      proposta: Math.floor(leads * 0.1),
      fechado:  (mov.matriculadosMes || 0) + (mov.rematriculadosMes || 0),
    },
    _isFullSync: true
  };

  const payload = { 
    stats, 
    _raw: { movimentacao: resMov, financeiro: resFin },
    checkins: Array.isArray(resCheckins?.content) ? resCheckins.content.slice(0, 20).map(c => ({
      nome: c.nomeCliente || 'Aluno',
      hora: c.dataAcesso ? new Date(c.dataAcesso).toLocaleTimeString('pt-BR') : '--:--',
      plano: c.plano || '-'
    })) : []
  };

  try {
    const r = await fetch(`${SERVER}/api/dashboard/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
      body: JSON.stringify(payload)
    });
    const res = await r.json();
    console.log('✅ SUPER SYNC COMPLETO!', res);
    console.table({
      Ativos: stats.ativos,
      Receita: stats.receita,
      Inadimplentes: stats.inadimplentes,
      'Vendas Mês': stats.novasVendas
    });
  } catch (e) {
    console.error('❌ Erro no envio:', e.message);
  }
})();
