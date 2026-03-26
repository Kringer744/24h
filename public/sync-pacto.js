/**
 * 24H NORTE — Super Sync Script (Versão Completa)
 *
 * Roda no navegador logado no PACTO e envia todos os dados para o Vercel.
 * Como ele roda no seu navegador já autenticado, acessa o sintetico sem barreiras.
 *
 * COMO USAR:
 * 1. Abra app.pactosolucoes.com.br e faça login
 * 2. Abra o console (F12 → Console)
 * 3. Cole e execute este script
 */

(async function SUPER_SYNC_24H_NORTE() {
  const SERVER   = 'https://24h-nine.vercel.app';
  const SYNC_KEY = '24hNorte_sync';
  const EMPRESA  = 4;
  const UNIDADE  = 4;

  const hoje      = new Date().toISOString().split('T')[0];
  const mes       = hoje.substring(0, 7);
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

  // ── 1. Dados do Sintetico (requer login PACTO no browser)
  console.log('📊 Capturando dados financeiros e movimentação...');
  const [resMov, resFin, resInad] = await Promise.all([
    fetchPacto(`/sintetico/prest/movimentacao-contratos?empresa=${EMPRESA}&unidade=${UNIDADE}&dtIni=${mesInicio}&dtFim=${hoje}`),
    fetchPacto(`/sintetico/prest/financeiro?empresa=${EMPRESA}&unidade=${UNIDADE}&mes=${mes}`),
    fetchPacto(`/sintetico/prest/clientes/inadimplentes?empresa=${EMPRESA}&unidade=${UNIDADE}&page=0&size=500`)
  ]);

  // ── 2. Normaliza movimentação: API retorna { table: {...} } ou flat
  const movRaw   = resMov || {};
  const movTable = movRaw.table || movRaw;  // suporte a ambos os formatos
  const fin      = resFin || {};

  const inadList = resInad?.content || resInad?.clientes || resInad?.items || (Array.isArray(resInad) ? resInad : []);

  // ── 3. Monta stats completo
  const stats = {
    // Movimentação do mês
    novasVendas:   (movTable.matriculadosMes   || 0) + (movTable.rematriculadosMes || 0),
    cancelamentos: (movTable.canceladosMes     || 0) + (movTable.desistenciaMes    || 0),

    // Financeiro (sintetico)
    receita:       fin.receitaMes  || fin.totalReceita  || fin.receita  || fin.receitaBruta  || 0,
    aReceber:      fin.aReceber    || fin.totalAReceber  || 0,
    inadimplentes: inadList.length || movTable.inadimplentes || 0,

    // Vínculos e contratos
    agregadores:   movTable.clientesAgregadores || movTable.dependentes  || movTable.agregadores  || 0,
    vencidos:      movTable.contratosVencidos   || movTable.vencidos     || 0,
    renovacoes30d: movTable.renovacoes30d       || movTable.renovacoesMes || 0,

    _isFullSync: true,
  };

  // ── 4. Inadimplentes detalhado para lista
  const inadimplentesDetalhe = inadList.map(c => ({
    nome:      c.nome || c.nomeCliente || '',
    matricula: String(c.matricula || c.codigoCliente || ''),
    situacao:  'INADIMPLENTE',
    telefone:  Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
    email:     Array.isArray(c.emails)    ? (c.emails[0]    || '')         : (c.email    || ''),
  })).filter(c => c.nome);

  const payload = {
    stats,
    inadimplentes: inadimplentesDetalhe,
    _raw: { movimentacao: resMov, financeiro: resFin },
  };

  console.log('📤 Enviando para Vercel...', { receita: stats.receita, inadimplentes: stats.inadimplentes, novasVendas: stats.novasVendas });

  try {
    const r = await fetch(`${SERVER}/api/dashboard/sync`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
      body:    JSON.stringify(payload),
    });
    const res = await r.json();
    if (res.success) {
      console.log('✅ SUPER SYNC COMPLETO!');
      console.table({
        Ativos:        '(mantido)',
        Receita:       'R$ ' + stats.receita,
        Inadimplentes: stats.inadimplentes,
        'Vendas Mês':  stats.novasVendas,
        Renovações:    stats.renovacoes30d,
        Vencidos:      stats.vencidos,
        Agregadores:   stats.agregadores,
      });
    } else {
      console.error('❌ Erro no envio:', res);
    }
  } catch (e) {
    console.error('❌ Falha ao enviar:', e.message);
  }
})();
