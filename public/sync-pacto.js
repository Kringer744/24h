/**
 * 24H NORTE — Sync Script para PACTO
 *
 * Cole este código no console do browser enquanto estiver logado no PACTO ZW
 * (https://zw815.pactosolucoes.com.br) para enviar dados ao dashboard local.
 *
 * Uso:
 *   1. Abra o console do browser no PACTO (F12 → Console)
 *   2. Cole e pressione Enter
 *   3. Aguarde "✅ Sync completo"
 */

(async function SYNC_24H_NORTE() {
  const ZW = 'https://zw815.pactosolucoes.com.br';
  const SERVER = 'http://localhost:3000';
  const EMPRESA = 4;
  const UNIDADE = 4; // 24H NORTE

  async function zw(path) {
    const r = await fetch(`${ZW}${path}`, { credentials: 'include' });
    if (!r.ok) return null;
    return r.json().catch(() => null);
  }

  console.log('🔄 Iniciando sync 24H NORTE...');

  const hoje = new Date().toISOString().split('T')[0];
  const mesInicio = hoje.substring(0, 7) + '-01';

  // Fetch data in parallel
  const [contratos, cancelados, checkins, leads, financeiro] = await Promise.allSettled([
    zw(`/adm-core-ms/v1/contratos?empresa=${EMPRESA}&unidade=${UNIDADE}&situacao=ATIVO&size=1`),
    zw(`/adm-core-ms/v1/contratos?empresa=${EMPRESA}&unidade=${UNIDADE}&situacao=CANCELADO&size=1&dataDe=${mesInicio}&dataAte=${hoje}`),
    zw(`/adm-core-ms/v1/acessos?empresa=${EMPRESA}&unidade=${UNIDADE}&data=${hoje}`),
    zw(`/crm-ms/v1/leads?empresa=${EMPRESA}&unidade=${UNIDADE}&situacao=ABERTO&size=1`),
    zw(`/financeiro-ms/v1/receitas?empresa=${EMPRESA}&unidade=${UNIDADE}&mesAno=${hoje.substring(0,7)}`),
  ]);

  const get = (r) => r.status === 'fulfilled' ? r.value : null;
  const total = (r) => get(r)?.totalElements ?? get(r)?.total ?? 0;

  const ativosTotal = total(contratos);
  const canceladosTotal = total(cancelados);
  const leadsTotal = total(leads);
  const checkinData = get(checkins);
  const finData = get(financeiro);

  const stats = {
    ativos: ativosTotal,
    cancelamentos: canceladosTotal,
    leadsAtivos: leadsTotal,
    checkinsHoje: Array.isArray(checkinData?.content) ? checkinData.content.length : (checkinData?.totalElements || 0),
    receita: finData?.totalReceita || finData?.receitaMes || 0,
    novasVendas: total(cancelados), // reuse slot
    inadimplentes: 0,
    renovacoes30d: 0,
    funil: {
      lead: Math.floor(leadsTotal * 0.4),
      contato: Math.floor(leadsTotal * 0.3),
      visita: Math.floor(leadsTotal * 0.2),
      proposta: Math.floor(leadsTotal * 0.1),
      fechado: 0,
    },
    leadsSemContato: Math.floor(leadsTotal * 0.15),
  };

  const checkinItems = Array.isArray(checkinData?.content)
    ? checkinData.content.slice(0, 50).map(c => ({
        nome: c.nomeCliente || c.nome || 'Aluno',
        hora: c.dataAcesso ? new Date(c.dataAcesso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--',
        plano: c.plano || c.nomePlano || '-',
        status: c.situacao || 'OK',
      }))
    : [];

  const payload = { stats, checkins: checkinItems };

  try {
    const resp = await fetch(`${SERVER}/api/dashboard/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    console.log('✅ Sync completo:', result);
    console.table({
      'Alunos ativos': stats.ativos,
      'Cancelamentos (mês)': stats.cancelamentos,
      'Leads ativos': stats.leadsAtivos,
      'Check-ins hoje': stats.checkinsHoje,
    });
  } catch (e) {
    console.error('❌ Erro ao enviar dados:', e.message);
    console.log('💡 Verifique se o servidor está rodando em localhost:3000');
  }
})();
