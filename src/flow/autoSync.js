const pacto = require('../integrations/pacto');
const cache = require('../storage/cache');

// Detecção de ambiente Vercel
const isVercel = !!process.env.VERCEL;

/**
 * Motor Principal de Sincronização
 * Utiliza APENAS a API oficial do PACTO.
 */
async function runSync() {
  const tStart = Date.now();
  console.log('🔄 [AUTO-SYNC] Iniciando sincronização limpa via API...');

  try {
    let ativosData = null;
    let msData = null;

    try {
      ativosData = await pacto.getContratosAtivos();
      console.log(`[AUTO-SYNC] Ativos: ${ativosData?.total || 0}`);
    } catch (e) {
      console.error('[AUTO-SYNC] Erro ao buscar ativos:', e.message);
    }

    try {
      msData = await pacto.getSintetico();
      console.log('[AUTO-SYNC] Dados Sintéticos OK');
    } catch (e) {
      console.warn('[AUTO-SYNC] Erro ao buscar dados sintéticos:', e.message);
    }

    // ── Consolidação Final
    const cached = cache.get('stats') || {};

    const ativos       = ativosData?.total        || msData?.ativos       || cached.ativos       || 0;
    const checkinsHoje = ativosData?.checkinsHoje  || msData?.checkinsHoje || cached.checkinsHoje || 0;
    const receita      = msData?.receitaMes        || cached.receita       || 0;
    const aReceber     = msData?.aReceber          || cached.aReceber      || 0;
    const faturamento  = msData?.faturamento       || cached.faturamento   || 0;
    const despesas     = msData?.despesas          || cached.despesas      || 0;
    const ticketMedio  = msData?.ticketMedio       || cached.ticketMedio   || 0;
    const novosMes     = msData?.novosMes          || ativosData?.matriculadosMes || cached.novosMes || 0;
    const semCheckin7  = msData?.semCheckin7       || cached.semCheckin7   || 0;
    const semCheckin30 = msData?.semCheckin30      || cached.semCheckin30  || 0;
    const semCheckin60 = msData?.semCheckin60      || cached.semCheckin60  || 0;

    const stats = {
      ativos,
      checkinsHoje,
      receita,
      aReceber,
      faturamento,
      despesas,
      ticketMedio,
      novosMes,
      semCheckin7,
      semCheckin30,
      semCheckin60,
      _syncedAt: new Date().toISOString(),
      _isAuto:   true,
    };

    // ── Salvar Cache
    cache.set('stats', stats);
    if (ativosData?.checkinsLista) {
      cache.set('checkins', { items: ativosData.checkinsLista.slice(0, 20) });
    }
    if (ativosData?.items) {
      cache.set('alunos', { items: ativosData.items, total: ativosData.items.length });
    }

    console.log(`✅ [AUTO-SYNC] Finalizado em ${Date.now() - tStart}ms`);
    return stats;

  } catch (err) {
    console.error('❌ [AUTO-SYNC] Erro Fatal:', err.message);
    throw err;
  }
}

module.exports = {
  runSync,
  start: () => {
    if (isVercel) {
      console.log('[AUTO-SYNC] Mode: Vercel/Serverless (Sincronização reativa)');
      runSync().catch(() => {});
    } else {
      setInterval(runSync, 5 * 60 * 1000); // 5 min
      runSync().catch(() => {});
    }
  }
};

