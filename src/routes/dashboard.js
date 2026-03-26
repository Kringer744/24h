const express = require('express');
const router = express.Router();
const cache = require('../storage/cache');
const autoSync = require('../flow/autoSync');

// POST /api/dashboard/sync  — recebe dados do browser (bookmarklet, fallback manual)
router.post('/sync', (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ success: false, error: 'payload inválido' });
  }
  if (data.stats)         cache.set('stats', { ...data.stats, _syncedAt: new Date().toISOString() });
  if (data.checkins)      cache.set('checkins', { items: data.checkins });
  if (data.alunos)        cache.set('alunos', { items: data.alunos, total: data.alunos.length });
  if (data.leads)         cache.set('leads', { items: data.leads, total: data.leads.length });
  if (data._raw)          cache.set('_raw', data._raw);
  if (data.inadimplentes?.length > 0) {
    cache.set('inadimplentes_lista', { items: data.inadimplentes, total: data.inadimplentes.length });
    console.log('[SYNC] Inadimplentes recebidos do browser:', data.inadimplentes.length);
  }
  console.log('[SYNC] Dados recebidos do browser:', Object.keys(data).join(', '));
  res.json({ success: true, keys: Object.keys(data), ts: new Date().toISOString() });
});

// POST /api/dashboard/sync/force — força um novo sync imediato
router.post('/sync/force', async (req, res) => {
  try {
    await autoSync.runSync();
    const stats = cache.get('stats') || {};
    res.json({ success: true, ts: new Date().toISOString(), ativos: stats.ativos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Tempo máximo de cache antes de forçar re-sync (25 minutos)
const STATS_MAX_AGE_MS = 25 * 60 * 1000;

// GET /api/dashboard/stats — lê cache populado pelo auto-sync
router.get('/stats', async (req, res) => {
  let stats   = cache.get('stats') || {};
  let rawData = cache.get('_raw');

  // No Vercel, PACTO API é bloqueada por IP — só usa dados do relay local
  // Localmente, roda sync se cache vazio ou expirado
  const isVercel = !!process.env.VERCEL;
  const cacheAge = stats._syncedAt ? Date.now() - new Date(stats._syncedAt).getTime() : Infinity;
  const needsSync = (!stats._syncedAt && !stats.ativos) || cacheAge > STATS_MAX_AGE_MS;

  if (!isVercel && needsSync) {
    console.log(`[DASHBOARD] Cache ${!stats._syncedAt ? 'vazio' : 'expirado (' + Math.round(cacheAge/60000) + 'min)'}. Rodando sync...`);
    try { await autoSync.runSync(); } catch (_) {}
    stats   = cache.get('stats') || {};
    rawData = cache.get('_raw');
  }

  if (!stats._syncedAt && !stats.ativos) {
    return res.json({ _source: 'sem-dados', _autoSync: true });
  }

  // Dados reais do Funil CRM (oportunidades.json local)
  let oportunidadesAtivas = 0;
  let funilReal = null;
  let cadenciasStats = null;
  try {
    const fs   = require('fs');
    const path = require('path');
    const ops  = JSON.parse(fs.readFileSync(require('../config/paths').OPS_FILE, 'utf8'));
    oportunidadesAtivas = ops.filter(o => o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO').length;
    funilReal = {
      lead:     ops.filter(o => o.etapa === 'LEAD').length,
      contato:  ops.filter(o => o.etapa === 'CONTATO').length,
      visita:   ops.filter(o => o.etapa === 'VISITA').length,
      proposta: ops.filter(o => o.etapa === 'PROPOSTA').length,
      fechado:  ops.filter(o => o.etapa === 'FECHADO').length,
      perdido:  ops.filter(o => o.etapa === 'PERDIDO').length,
    };
    // Leads sem contato = LEAD há mais de 2 dias sem ultimoContato
    const limite = Date.now() - 2 * 24 * 60 * 60 * 1000;
    funilReal.semContato = ops.filter(o =>
      o.etapa === 'LEAD' && (!o.ultimoContato || new Date(o.ultimoContato).getTime() < limite)
    ).length;
  } catch (_) {}

  // Stats de cadências
  try {
    const cadencias = require('../flow/cadencias');
    cadenciasStats = cadencias.getStats();
  } catch (_) {}

  const result = {
    ...stats,
    oportunidadesAtivas,
    ...(funilReal && { funil: funilReal }),
    ...(funilReal && { leadsSemContato: funilReal.semContato }),
    ...(cadenciasStats && { cadencias: cadenciasStats }),
    _source: stats._autoSync ? 'auto' : (stats._syncedAt ? 'cache' : 'sem-dados'),
    _hasCredentials: !!(process.env.PACTO_USER && process.env.PACTO_PASS),
  };

  if (rawData) result._raw = rawData;

  res.json(result);
});

// GET /api/dashboard/leads — lista leads do CRM
router.get('/leads', (req, res) => {
  const raw = cache.get('_raw');
  const leadsData = raw?.leads;
  if (leadsData) {
    const items = leadsData.content || leadsData.items || [];
    const total = leadsData.totalElements || leadsData.total || items.length;
    return res.json({ leads: items, total, _source: 'cache' });
  }
  res.json({ leads: [], total: 0, _source: 'sem-dados' });
});

// GET /api/dashboard/financeiro — dados financeiros do cache
router.get('/financeiro', (req, res) => {
  const stats = cache.get('stats') || {};
  const raw   = cache.get('_raw');

  // Parcelas vencendo: derivar da lista de alunos do cache (próximos 30 dias)
  const parcelas = [];
  try {
    const alunos = (cache.get('alunos')?.items || []);
    const hoje = new Date();
    const limite30 = new Date(hoje.getTime() + 30 * 24 * 60 * 60 * 1000);
    alunos.forEach(a => {
      if (a.fimContrato) {
        const fim = new Date(a.fimContrato);
        if (fim >= hoje && fim <= limite30) {
          parcelas.push({
            nome: a.nome,
            matricula: a.matricula,
            telefone: a.telefone,
            vencimento: a.fimContrato,
            diasRestantes: Math.ceil((fim - hoje) / (1000 * 60 * 60 * 24)),
          });
        }
      }
    });
    parcelas.sort((a, b) => a.diasRestantes - b.diasRestantes);
  } catch (_) {}

  res.json({
    receita:       stats.receita       ?? null,
    inadimplentes: stats.inadimplentes ?? null,
    aReceber:      stats.aReceber      ?? null,
    parcelas,
    _raw: raw?.financeiro || null,
    _source: stats._syncedAt ? (stats._autoSync ? 'auto' : 'cache') : 'sem-dados',
  });
});

// GET /api/dashboard/checkins
router.get('/checkins', (req, res) => {
  const cachedCheckins = cache.get('checkins');
  if (cachedCheckins?.items?.length) {
    return res.json(cachedCheckins.items);
  }
  res.json([]);
});

// GET /api/dashboard/sync/status — status do auto-sync
router.get('/sync/status', (req, res) => {
  res.json(autoSync.getStatus());
});

module.exports = router;
