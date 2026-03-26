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

    if (hasCredentials) {
      // Local: tenta primeiro o CDP (Chrome aberto com --remote-debugging-port=9222)
      // Isso popula o relay JWT ANTES de tentar pactoSession
      if (!isVercel && pactoHeadless) {
        try {
          await pactoHeadless.ensureJwt(); // extrai JWT do Chrome via CDP → salva no relay
          const [movRes, finRes, inadRes] = await Promise.allSettled([
            pactoHeadless.getMovimentacao(),
            pactoHeadless.getFinanceiro(),
            pactoHeadless.getInadimplentesLista(),
          ]);
          movData = movRes.status === 'fulfilled' ? movRes.value : null;
          finData = finRes.status === 'fulfilled' ? finRes.value : null;
          const inadList = inadRes.status === 'fulfilled' ? inadRes.value : null;
          if (inadList?.length > 0) {
            cache.set('inadimplentes_lista', { items: inadList, total: inadList.length });
            console.log(`[AUTO-SYNC] Inadimplentes via headless: ${inadList.length}`);
          }
          if (movData || finData) {
            console.log('[AUTO-SYNC] Dados financeiros via Chrome CDP OK');
          }
        } catch (_) {
          // Chrome sem porta de debug aberta — normal, cai no pactoSession
        }
      }

      // Fallback: pactoSession (JWT relay existente + Auth MS + JSESSIONID)
      // Funciona no Vercel quando local fez relay do JWT
      if (!movData) {
        try {
          const [movRes, finRes, inadRes] = await Promise.allSettled([
            pactoSession.getMovimentacao(),
            pactoSession.getFinanceiro(),
            pactoSession.getInadimplentesLista(),
          ]);
          movData = movRes.status === 'fulfilled' ? movRes.value : null;
          finData = finRes.status === 'fulfilled' ? finRes.value : null;
          const inadList = inadRes.status === 'fulfilled' ? inadRes.value : null;
          if (inadList?.length > 0) {
            cache.set('inadimplentes_lista', { items: inadList, total: inadList.length });
            console.log(`[AUTO-SYNC] Inadimplentes via session: ${inadList.length}`);
          }
          // Verificar se os dados são HTML (falso positivo de JSESSIONID inválido)
          const isHtmlData = d => typeof d === 'string' && d.trim().startsWith('<');
          if (isHtmlData(movData)) movData = null;
          if (isHtmlData(finData)) finData = null;

          if (movData || finData) {
            console.log('[AUTO-SYNC] Dados financeiros via pactoSession OK');
          } else {
            console.warn('[AUTO-SYNC] pactoSession sem dados — aguardando JWT do browser (use iniciar-24h.bat)');
          }
        } catch (e) {
          console.warn('[AUTO-SYNC] pactoSession falhou:', e.message);
        }
      }
    }

    // ── 3. Consolidação Final
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
      setInterval(runSync, 5 * 60 * 1000); // 5 min — mantém Vercel sempre atualizado
      runSync().catch(() => {});
    }
  }
};
