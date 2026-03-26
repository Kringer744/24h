const pacto = require('../integrations/pacto');
const pactoSession = require('../integrations/pactoSession');
const cache = require('../storage/cache');

// Detecção de ambiente Vercel — desabilita headless
const isVercel = !!process.env.VERCEL;
let pactoHeadless = null;
if (!isVercel) {
  try {
    pactoHeadless = require('../integrations/pactoHeadless');
  } catch (e) {
    console.warn('[AUTO-SYNC] Puppeteer indisponível localmente.');
  }
}

/**
 * Motor Principal de Sincronização
 * Prioriza Microserviços (MS) para funcionar no Vercel.
 */
async function runSync() {
  const tStart = Date.now();
  console.log('🔄 [AUTO-SYNC] Iniciando sincronização consolidade...');

  try {
    // ── 1. Dados Cruciais via API (Sempre disponíveis via API Key)
    let ativosData = null;
    try {
      ativosData = await pacto.getContratosAtivos();
      console.log(`[AUTO-SYNC] Ativos: ${ativosData?.total || 0}`);
    } catch (e) {
      console.error('[AUTO-SYNC] Erro ao buscar ativos:', e.message);
    }

    // ── 2. Variáveis de Coleta
    let msData = null;
    let movData = null;
    let finData = null;
    let leadsData = null;
    
    // Tenta Microserviços (Ideal para Vercel)
    try {
      msData = await pacto.getSintetico();
      console.log('[AUTO-SYNC] Dados via Microserviços OK');
    } catch (e) {
      console.warn('[AUTO-SYNC] Erro ao buscar MS:', e.message);
    }

    const hasCredentials = !!(process.env.PACTO_USER && process.env.PACTO_PASS);

    // Se estivermos LOCAL, ainda tentamos o Headless/Session para dados que o MS não tem
    if (!isVercel && hasCredentials) {
      if (pactoHeadless) {
        try {
          await pactoHeadless.ensureJwt();
          const [movRes, finRes] = await Promise.allSettled([
            pactoHeadless.getMovimentacao(),
            pactoHeadless.getFinanceiro(),
          ]);
          movData = movRes.status === 'fulfilled' ? movRes.value : null;
          finData = finRes.status === 'fulfilled' ? finRes.value : null;
        } catch (_) {}
      }
    }

    // ── 3. Consolidação Final
    const cached = cache.get('stats') || {};
    const md = movData || {};
    const fd = finData || {};

    // DEFINIÇÃO DAS VARIÁVEIS ANTES DO USO NO OBJETO 'det'
    const matriculadosMesFromMS   = msData?.matriculadosMes;
    const canceladosMesFromMS      = msData?.cancelamentosMes;
    const rematriculadosMesFromMS = msData?.rematriculadosMes;

    const det = {
      matriculadosHoje:   md.matriculadosHoje   ?? 0,
      matriculadosMes:    matriculadosMesFromMS ?? md.matriculadosMes ?? 0,
      rematriculadosHoje: md.rematriculadosHoje ?? 0,
      rematriculadosMes:  rematriculadosMesFromMS  ?? md.rematriculadosMes ?? 0,
      canceladosHoje:     md.canceladosHoje     ?? 0,
      canceladosMes:      canceladosMesFromMS      ?? md.canceladosMes    ?? 0,
      desistenciaHoje:    md.desistenciaHoje    ?? 0,
      desistenciaMes:     md.desistenciaMes     ?? 0,
    };

    const ativos        = ativosData?.total     || msData?.ativos || cached.ativos || 0;
    const checkinsHoje  = ativosData?.checkinsHoje || msData?.checkinsHoje || 0;
    const inadimplentes = msData?.inadimplentes || md.inadimplentes || cached.inadimplentes || 0;
    const receita       = msData?.receitaMes    || fd.receitaMes    || cached.receita || 0;
    const aReceber      = msData?.aReceber      || fd.aReceber      || cached.aReceber || 0;

    const stats = {
      ativos,
      checkinsHoje,
      inadimplentes,
      receita,
      aReceber,
      novasVendas:   det.matriculadosMes + det.rematriculadosMes,
      cancelamentos: det.canceladosMes + det.desistenciaMes,
      totalAlunos:   ativos, // simplificando
      
      // Funil
      funil: {
        lead:     Math.floor((msData?.leadsAtivos || 0) * 0.4),
        contato:  Math.floor((msData?.leadsAtivos || 0) * 0.3),
        visita:   Math.floor((msData?.leadsAtivos || 0) * 0.2),
        proposta: Math.floor((msData?.leadsAtivos || 0) * 0.1),
        fechado:  det.matriculadosMes + det.rematriculadosMes,
      },
      
      _syncedAt: new Date().toISOString(),
      _isAuto:   true,
    };

    // ── 4. Salvar Cache
    cache.set('stats', stats);
    if (ativosData?.checkinsLista) {
      cache.set('checkins', { items: ativosData.checkinsLista.slice(0, 20) });
    }
    if (ativosData?.items) {
      cache.set('alunos', { items: ativosData.items, total: ativosData.items.length });
    }

    // ── 5. Relay para Vercel (quando rodando local — PACTO API bloqueada no Vercel)
    if (!isVercel) {
      const vercelUrl = process.env.VERCEL_SYNC_URL;
      const syncKey   = process.env.SYNC_KEY || '24hNorte_sync';
      if (vercelUrl) {
        const axios = require('axios');
        const url = vercelUrl.startsWith('http') ? vercelUrl : `https://${vercelUrl}`;
        const payload = {
          stats,
          checkins: ativosData?.checkinsLista?.slice(0, 20) || [],
          alunos:   ativosData?.items || [],
          _raw:     { movimentacao: md, financeiro: fd },
        };
        axios.post(`${url}/data-relay`, payload, {
          headers: { 'x-sync-key': syncKey, 'Content-Type': 'application/json' },
          timeout: 15000,
        }).then(() => console.log('[AUTO-SYNC] Dados enviados para Vercel via /data-relay'))
          .catch(e => console.warn('[AUTO-SYNC] Relay para Vercel falhou:', e.message));
      }
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
      setInterval(runSync, 20 * 60 * 1000);
      runSync().catch(() => {});
    }
  }
};
