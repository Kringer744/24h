/**
 * Meta Ads Integration
 * API: https://graph.facebook.com/v20.0
 * Auth: access_token (long-lived system user token)
 */

const axios = require('axios');

const TOKEN      = process.env.META_ACCESS_TOKEN;
const ACCOUNTS   = (process.env.META_AD_ACCOUNTS || 'act_933304206753192').split(',').map(s => s.trim());
const GRAPH_URL  = 'https://graph.facebook.com/v20.0';

const CACHE_TTL  = 10 * 60 * 1000; // 10 minutes
let _cache = null;
let _cacheTs = 0;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function extractUnidade(name) {
  const m = name.match(/\[(NORTE|ALPHAVILLE|TATUAP[EÉ]|CAMPINAS|LAGOA|CAMBUI|CAMBUÍ|NORTE|NORTE\s*\d*)\]/i);
  if (m) return m[1].toUpperCase().replace('TATUAPE','TATUAPÉ');
  if (/NORTE/i.test(name))     return 'NORTE';
  if (/ALPHAVILLE/i.test(name)) return 'ALPHAVILLE';
  if (/TATUAP/i.test(name))    return 'TATUAPÉ';
  if (/CAMPINAS/i.test(name))  return 'CAMPINAS';
  if (/LAGOA/i.test(name))     return 'LAGOA';
  return 'GERAL';
}

function extractObjetivo(objective) {
  const map = {
    OUTCOME_ENGAGEMENT: 'Mensagens',
    OUTCOME_LEADS:      'Leads',
    OUTCOME_AWARENESS:  'Alcance',
    OUTCOME_TRAFFIC:    'Tráfego',
    OUTCOME_SALES:      'Vendas',
  };
  return map[objective] || objective;
}

function metricVal(actions, type) {
  const found = (actions || []).find(a => a.action_type === type);
  return found ? parseInt(found.value, 10) : 0;
}

async function graphGet(path, params = {}) {
  const res = await axios.get(`${GRAPH_URL}${path}`, {
    params: { access_token: TOKEN, ...params },
    timeout: 15000,
  });
  return res.data;
}

// ─── CORE FUNCTIONS ──────────────────────────────────────────────────────────

/**
 * Busca campanhas ativas + insights de todas as contas.
 * @param {string} period - date_preset do Meta: 'today', 'last_7d', 'last_30d', 'this_month'
 */
async function getCampanhas(period = 'last_30d') {
  const cacheKey = period;
  if (_cache?.[cacheKey] && Date.now() - _cacheTs < CACHE_TTL) {
    return _cache[cacheKey];
  }

  const results = await Promise.allSettled(
    ACCOUNTS.map(account => fetchAccountCampanhas(account, period))
  );

  const campanhas = [];
  const totals = { spend: 0, impressions: 0, clicks: 0, reach: 0, leads: 0, mensagens: 0 };

  for (const r of results) {
    if (r.status === 'fulfilled') {
      campanhas.push(...r.value);
    }
  }

  campanhas.forEach(c => {
    totals.spend      += c.spend;
    totals.impressions += c.impressions;
    totals.clicks      += c.clicks;
    totals.reach       += c.reach;
    totals.leads       += c.leads;
    totals.mensagens   += c.mensagens;
  });

  const payload = { campanhas, totals, period, fetchedAt: new Date().toISOString() };

  if (!_cache) _cache = {};
  _cache[cacheKey] = payload;
  _cacheTs = Date.now();

  return payload;
}

async function fetchAccountCampanhas(accountId, period) {
  // 1. Busca lista de campanhas ativas
  const campsData = await graphGet(`/${accountId}/campaigns`, {
    fields: 'id,name,status,objective,daily_budget,lifetime_budget',
    filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
    limit: 100,
  });
  const campIds = (campsData.data || []).map(c => c.id);
  const campMap = {};
  (campsData.data || []).forEach(c => { campMap[c.id] = c; });

  if (campIds.length === 0) return [];

  // 2. Busca insights no nível campanha (1 chamada por conta)
  const insightsData = await graphGet(`/${accountId}/insights`, {
    fields: 'campaign_id,campaign_name,impressions,clicks,spend,cpc,ctr,reach,actions,date_start,date_stop',
    date_preset: period,
    level: 'campaign',
    limit: 200,
  });

  const insightMap = {};
  (insightsData.data || []).forEach(ins => {
    insightMap[ins.campaign_id] = ins;
  });

  // 3. Montar objeto final — só campanhas ativas
  return (campsData.data || []).map(camp => {
    const ins = insightMap[camp.id] || {};
    const actions = ins.actions || [];

    const spend       = parseFloat(ins.spend  || '0');
    const impressions = parseInt(ins.impressions || '0', 10);
    const clicks      = parseInt(ins.clicks || '0', 10);
    const reach       = parseInt(ins.reach  || '0', 10);
    const cpc         = parseFloat(ins.cpc   || '0');
    const ctr         = parseFloat(ins.ctr   || '0');

    const leads    = metricVal(actions, 'lead');
    const mensagens = metricVal(actions, 'onsite_conversion.messaging_conversation_started_7d');
    const conversas = metricVal(actions, 'onsite_conversion.messaging_first_reply');

    const dailyBudget = camp.daily_budget ? parseInt(camp.daily_budget, 10) / 100 : null;

    return {
      id:         camp.id,
      nome:       camp.name,
      status:     camp.status,
      objetivo:   extractObjetivo(camp.objective),
      objetivoRaw: camp.objective,
      unidade:    extractUnidade(camp.name),
      dailyBudget,
      spend,
      impressions,
      clicks,
      reach,
      cpc,
      ctr,
      leads,
      mensagens,
      conversas,
      account:    accountId,
      dateStart:  ins.date_start || null,
      dateStop:   ins.date_stop  || null,
    };
  });
}

/**
 * Tenta buscar dados de um lead pelo leadgen_id.
 * Requer permissão leads_retrieval — pode falhar com token de sistema.
 * @returns {{ nome, telefone, email, campanha } | null}
 */
async function fetchLeadById(leadgenId) {
  if (!leadgenId) return null;
  const data = await graphGet(`/${leadgenId}`, {
    fields: 'field_data,created_time,campaign_name,ad_name,adset_name',
  });

  const fields = data.field_data || [];
  const get = (keys) => {
    for (const k of keys) {
      const f = fields.find(f => f.name.toLowerCase() === k.toLowerCase());
      if (f?.values?.[0]) return f.values[0];
    }
    return '';
  };

  return {
    nome:     get(['full_name','name','nome']),
    telefone: get(['phone_number','phone','telefone','celular','whatsapp']).replace(/\D/g,''),
    email:    get(['email','e-mail']),
    campanha: data.campaign_name || '',
    adset:    data.adset_name    || '',
    ad:       data.ad_name       || '',
  };
}

module.exports = { getCampanhas, fetchLeadById };
