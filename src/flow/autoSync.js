/**
 * Auto-Sync Engine
 * Busca dados completos do PACTO (sintetico + ativos) automaticamente.
 * Roda na inicialização e a cada 30 minutos.
 * Não requer nenhuma ação do usuário.
 */

const cache = require('../storage/cache');
const pacto = require('../integrations/pacto');

// pactoSession usa apenas Axios (HTTP) — funciona em qualquer ambiente incluindo Vercel
// pactoHeadless usa puppeteer (Chrome) — só funciona localmente
let pactoSession  = null;
let pactoHeadless = null;
try { pactoSession  = require('../integrations/pactoSession');  } catch (_) {}
if (!process.env.VERCEL) {
  try { pactoHeadless = require('../integrations/pactoHeadless'); } catch (_) {}
}

let _lastSyncAt = null;
let _syncRunning = false;

/**
 * Executa a sincronização completa
 */
async function runSync() {
  if (_syncRunning) return;
  _syncRunning = true;

  console.log('[AUTO-SYNC] Iniciando sincronização automática...');

  try {
    // ── 1. Dados via API Key (sempre disponíveis) ─────────────────────────────
    let ativosData = null;
    let inadimplentesData = null;
    try {
      [ativosData, inadimplentesData] = await Promise.all([
        pacto.getContratosAtivos(),
        pacto.getContratosInadimplentes(),
      ]);
    } catch (e) {
      console.error('[AUTO-SYNC] Erro ao buscar ativos/inadimplentes:', e.message);
      if (!ativosData) try { ativosData = await pacto.getContratosAtivos(); } catch (_) {}
    }

    // ── 2. Dados via sintetico (headless login com JWT) ───────────────────────
    let movData = null;
    let finData = null;
    let leadsData = null;
    let fallbackData = {}; // fallbacks via API key

    const hoje = new Date().toISOString().split('T')[0];
    const mesInicio = hoje.substring(0, 8) + '01';

    // ── 2.1 Fallbacks via API Key (sempre tentamos para garantir dados básicos)
    try {
      const [cancelados, renovados] = await Promise.all([
        pacto.getContratosCount('CANCELADO', mesInicio, hoje),
        pacto.getContratosCount('RENOVADO',  mesInicio, hoje), // Tenta 'REMATRICULADO' se o sistema usar
      ]);
      fallbackData = { 
        canceladosMes: cancelados, 
        rematriculadosMes: renovados,
        matriculadosMes: ativosData?.matriculadosMes || 0
      };
      console.log(`[AUTO-SYNC] Fallback API Key: Cancelados=${cancelados}, Renovados=${renovados}`);
    } catch (e) {
      console.warn('[AUTO-SYNC] Erro nos fallbacks API key:', e.message);
    }

    const hasCredentials = !!(process.env.PACTO_USER && process.env.PACTO_PASS);

    if (hasCredentials && !pactoHeadless && pactoSession) {
      // Vercel / sem Chrome: usa sessão HTTP direto
      console.log('[AUTO-SYNC] Modo HTTP session (sem puppeteer)...');
      const sessionOk = await pactoSession.ensureSession().catch(() => false);
      if (sessionOk) {
        const [movRes, finRes, leadsRes] = await Promise.allSettled([
          pactoSession.getMovimentacao(),
          pactoSession.getFinanceiro(),
          pactoSession.getLeadsCrm(),
        ]);
        movData   = movRes.status  === 'fulfilled' ? movRes.value  : null;
        finData   = finRes.status  === 'fulfilled' ? finRes.value  : null;
        leadsData = leadsRes.status === 'fulfilled' ? leadsRes.value : null;
        if (movData) console.log('[AUTO-SYNC] Movimentação OK (session HTTP)');
        if (finData) console.log('[AUTO-SYNC] Financeiro OK (session HTTP)');
      } else {
        console.warn('[AUTO-SYNC] Login HTTP falhou — apenas dados da API key.');
      }
    } else if (hasCredentials && pactoHeadless) {
      try {
        // Garante JWT válido (faz login headless se necessário)
        await pactoHeadless.ensureJwt();

        const [movRes, finRes, leadsRes, inadListRes] = await Promise.allSettled([
          pactoHeadless.getMovimentacao(),
          pactoHeadless.getFinanceiro(),
          pactoSession.getLeadsCrm(),        // leads via API key (não precisa de JWT)
          pactoHeadless.getInadimplentesLista(),
        ]);

        movData  = movRes.status  === 'fulfilled' ? movRes.value  : null;
        finData  = finRes.status  === 'fulfilled' ? finRes.value  : null;
        leadsData = leadsRes.status === 'fulfilled' ? leadsRes.value : null;

        const inadList = inadListRes.status === 'fulfilled' ? inadListRes.value : null;
        if (inadList?.length > 0) {
          cache.set('inadimplentes_lista', { items: inadList, total: inadList.length });
          inadimplentesData = inadList;
          console.log(`[AUTO-SYNC] Inadimplentes via headless: ${inadList.length}`);
        } else if (inadListRes.status === 'rejected') {
          console.warn('[AUTO-SYNC] Inadimplentes headless falhou:', inadListRes.reason?.message);
        }

        if (movData)  console.log('[AUTO-SYNC] Movimentação OK:', JSON.stringify(movData).slice(0, 120));
        else console.warn('[AUTO-SYNC] Movimentação falhou:', movRes.reason?.message);
        if (finData)  console.log('[AUTO-SYNC] Financeiro OK:', JSON.stringify(finData).slice(0, 120));
        else console.warn('[AUTO-SYNC] Financeiro falhou:', finRes.reason?.message);

      } catch (headlessErr) {
        console.warn('[AUTO-SYNC] Login headless falhou, tentando sessão JSF...', headlessErr.message);

        // Fallback: sessão JSF (pode falhar com reCAPTCHA)
        const sessionOk = pactoSession
          ? await pactoSession.ensureSession().catch(() => false)
          : false;
        if (sessionOk) {
          const [movRes, finRes, leadsRes] = await Promise.allSettled([
            pactoSession.getMovimentacao(),
            pactoSession.getFinanceiro(),
            pactoSession.getLeadsCrm(),
          ]);
          movData   = movRes.status  === 'fulfilled' ? movRes.value  : null;
          finData   = finRes.status  === 'fulfilled' ? finRes.value  : null;
          leadsData = leadsRes.status === 'fulfilled' ? leadsRes.value : null;
        } else {
          console.warn('[AUTO-SYNC] Sem sessão disponível — apenas dados da API key.');
        }
      }
    } else {
      console.warn('[AUTO-SYNC] Sem credenciais PACTO — apenas dados da API key disponíveis.');
    }

    // ── 3. Montar stats consolidados ──────────────────────────────────────────
    const cached = cache.get('stats') || {};

    // Valores derivados dos ativos (API key)
    const ativos = ativosData?.total || cached.ativos || 0;
    const checkinsHoje = ativosData?.checkinsHoje || 0;
    const checkinsLista = ativosData?.checkinsLista || [];
    const matriculadosMes = ativosData?.matriculadosMes || 0;

    // Valores do sintetico (sessão JSF) com fallback para cache
    const md = movData || {};
    const fd = finData || {};

    const det = {
      matriculadosHoje:   md.matriculadosHoje   ?? md.matriculado ?? 0,
      matriculadosMes:    md.matriculadosMes    ?? md.matriculadoAteHoje ?? md.novasMatriculas ?? fallbackData.matriculadosMes ?? 0,
      rematriculadosHoje: md.rematriculadosHoje ?? 0,
      rematriculadosMes:  md.rematriculadosMes  ?? md.renovacoes ?? fallbackData.rematriculadosMes ?? 0,
      canceladosHoje:     md.canceladosHoje     ?? md.cancelado ?? 0,
      canceladosMes:      md.canceladosMes      ?? md.canceladoAteHoje ?? md.cancelamentos ?? fallbackData.canceladosMes ?? 0,
      desistenciaHoje:    md.desistenciaHoje    ?? 0,
      desistenciaMes:     md.desistenciaMes     ?? md.desistencias ?? 0,
      trancadosHoje:      md.trancadosHoje      ?? 0,
      trancadosMes:       md.trancadosMes       ?? md.trancados ?? 0,
    };

    const agregadores   = md.clientesAgregadores ?? md.agregadores ?? md.dependentes ?? cached.agregadores;
    const vencidos      = md.contratosVencidos   ?? md.vencidos   ?? cached.vencidos;
    const inadimplentes = md.inadimplentes ?? md.totalInadimplentes ??
      (inadimplentesData?.length > 0 ? inadimplentesData.length : undefined) ?? cached.inadimplentes;
    const renovacoes30d = md.renovacoes30d       ?? md.renovacoesMes ?? cached.renovacoes30d;
    const leadsAtivos   = leadsData?.totalElements ?? leadsData?.total ?? cached.leadsAtivos;
    const receita       = fd.receitaMes ?? fd.totalReceita ?? fd.receita ?? cached.receita;
    const aReceber      = fd.aReceber ?? fd.totalAReceber ?? cached.aReceber;

    const novasVendas   = det.matriculadosMes + det.rematriculadosMes || cached.novasVendas || 0;
    const cancelamentos = det.canceladosMes + det.desistenciaMes || cached.cancelamentos || 0;

    const stats = {
      // Sempre disponíveis via API key
      ativos,
      checkinsHoje,

      // Do sintetico (ou cache anterior se sessão indisponível)
      ...(agregadores !== undefined && { agregadores }),
      ...(vencidos     !== undefined && { vencidos }),
      ...(inadimplentes !== undefined && { inadimplentes }),
      ...(renovacoes30d !== undefined && { renovacoes30d }),
      ...(leadsAtivos   !== undefined && { leadsAtivos }),
      ...(receita       !== undefined && { receita }),
      ...(aReceber      !== undefined && { aReceber }),

      novasVendas,
      cancelamentos,
      totalAlunos: ativos + (agregadores || 0) + (vencidos || 0),
      saldoMes: novasVendas - cancelamentos,

      funil: {
        lead:     Math.floor((leadsAtivos || 0) * 0.4),
        contato:  Math.floor((leadsAtivos || 0) * 0.3),
        visita:   Math.floor((leadsAtivos || 0) * 0.2),
        proposta: Math.floor((leadsAtivos || 0) * 0.1),
        fechado:  novasVendas,
      },
      leadsSemContato: Math.floor((leadsAtivos || 0) * 0.15),

      _syncedAt: new Date().toISOString(),
      _autoSync: true,
    };

    // ── 4. Salvar no cache ────────────────────────────────────────────────────
    cache.set('stats', stats);
    cache.set('_raw', {
      movimentacao: { table: det, ...md },
      financeiro: fd,
      leads: leadsData,
    });

    if (checkinsLista.length > 0) {
      cache.set('checkins', { items: checkinsLista });
    }

    // ── 5. Cache de inadimplentes ─────────────────────────────────────────────
    if (inadimplentesData?.length > 0) {
      cache.set('inadimplentes_lista', { items: inadimplentesData, total: inadimplentesData.length });
      console.log(`[AUTO-SYNC] Inadimplentes cacheados: ${inadimplentesData.length}`);
    }

    if (ativosData?.items?.length > 0) {
      const alunosNormalizados = ativosData.items.map(c => ({
        nome:             c.nome,
        matricula:        String(c.matricula || ''),
        codigoCliente:    c.cliente,
        situacao:         typeof c.situacao === 'string' ? c.situacao.toUpperCase() : 'ATIVO',
        situacaoContrato: typeof c.situacaoContrato === 'string' ? c.situacaoContrato.toUpperCase() : 'NORMAL',
        categoria:        c.categoria || null,
        fimContrato:      c.fimContrato || null,
        telefone:         Array.isArray(c.telefones) ? (c.telefones[0]?.numero || '') : (c.telefone || ''),
        email:            Array.isArray(c.emails) ? (c.emails[0] || '') : (c.email || ''),
        ultimoAcesso:     c.ultimoAcesso || null,
        datamatricula:    c.datamatricula || null,
      }));
      cache.set('alunos', { items: alunosNormalizados, total: alunosNormalizados.length });

      // Derivar lista de inadimplentes a partir dos ativos: situacaoContrato INADIMPLENTE ou CANCELADO
      const inadDerived = alunosNormalizados.filter(a =>
        a.situacaoContrato === 'INADIMPLENTE' || a.situacao === 'INADIMPLENTE' ||
        a.situacaoContrato === 'CANCELADO'    || a.situacao === 'CANCELADO'
      );
      if (inadDerived.length > 0 && !inadimplentesData?.length) {
        cache.set('inadimplentes_lista', { items: inadDerived, total: inadDerived.length });
        console.log(`[AUTO-SYNC] Inadimplentes derivados dos ativos: ${inadDerived.length}`);
      }
    }

    _lastSyncAt = new Date();
    const temSintetico = sessionOk && (movData || finData);
    console.log(`[AUTO-SYNC] Concluído em ${new Date().toLocaleTimeString('pt-BR')}. Ativos=${ativos} | Checkins=${checkinsHoje} | Sintetico=${temSintetico ? 'OK' : 'SEM SESSÃO'}`);

  } catch (err) {
    console.error('[AUTO-SYNC] Erro geral:', err.message);
  } finally {
    _syncRunning = false;
  }
}

/**
 * Inicia o motor de auto-sync
 * - Sync imediato na inicialização
 * - Sync a cada 30 minutos
 */
function start() {
  // Sync inicial com delay de 3s (dar tempo ao servidor de iniciar)
  setTimeout(runSync, 3000);

  // Sync periódico a cada 30 minutos
  const INTERVAL = 30 * 60 * 1000;
  setInterval(runSync, INTERVAL);

  console.log('[AUTO-SYNC] Motor iniciado — sync a cada 30 minutos');
}

function getStatus() {
  return {
    lastSyncAt: _lastSyncAt?.toISOString() || null,
    running: _syncRunning,
    headless: pactoHeadless?.getStatus() || null,
    session: pactoSession?.getSessionStatus() || null,
  };
}

module.exports = { start, runSync, getStatus };
