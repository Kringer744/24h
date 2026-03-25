const express = require('express');
const router  = express.Router();
const meta    = require('../integrations/meta');
const fs      = require('fs');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const OPS_FILE    = require('../config/paths').OPS_FILE;
const WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || '24hnorte_webhook_2024';

function loadOps() {
  try { return JSON.parse(fs.readFileSync(OPS_FILE, 'utf8')); } catch { return []; }
}
function saveOps(data) {
  fs.writeFileSync(OPS_FILE, JSON.stringify(data, null, 2));
}

// ─── CAMPANHAS ────────────────────────────────────────────────────────────────

// GET /api/meta/campanhas?period=last_30d
router.get('/campanhas', async (req, res) => {
  const period = req.query.period || 'last_30d';
  const allowed = ['today', 'last_7d', 'last_30d', 'this_month', 'last_month'];
  if (!allowed.includes(period)) return res.status(400).json({ error: 'period inválido' });
  try {
    const data = await meta.getCampanhas(period);
    res.json(data);
  } catch (err) {
    console.error('[META] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LEADS NO CRM ─────────────────────────────────────────────────────────────

// GET /api/meta/leads?unidade=NORTE
// Retorna oportunidades com fonte=meta_ads, opcionalmente filtradas por unidade
router.get('/leads', (req, res) => {
  const { unidade } = req.query;
  let items = loadOps().filter(o => o.fonte === 'meta_ads');
  if (unidade && unidade !== 'ALL') {
    items = items.filter(o =>
      (o.metaCampanhaNome || '').toUpperCase().includes(unidade.toUpperCase()) ||
      (o.metaUnidade || '').toUpperCase() === unidade.toUpperCase()
    );
  }
  items.sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm));
  res.json({ leads: items, total: items.length });
});

// ─── IMPORTAÇÃO MANUAL ────────────────────────────────────────────────────────

/**
 * POST /api/meta/leads/import
 * Body: { leads: [{ nome, telefone, email?, campanha, adset?, unidade? }] }
 * Cria oportunidades no CRM para cada lead, evitando duplicados por telefone.
 */
router.post('/leads/import', (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'leads[] é obrigatório e não pode ser vazio' });
  }

  const ops   = loadOps();
  let criados = 0, duplicados = 0, erros = 0;
  const criados_ids = [];

  for (const lead of leads) {
    try {
      const nome     = (lead.nome     || '').trim();
      const telefone = (lead.telefone || '').replace(/\D/g, '');
      const campanha = (lead.campanha || lead.campaign_name || '').trim();
      const unidade  = detectarUnidade(campanha, lead.unidade);

      if (!nome || telefone.length < 8) { erros++; continue; }

      // Evitar duplicado por telefone + fonte meta_ads
      const dup = ops.find(o =>
        o.telefone === telefone &&
        o.fonte === 'meta_ads' &&
        o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO'
      );
      if (dup) { duplicados++; continue; }

      const op = {
        id:               uuidv4(),
        nome,
        telefone,
        email:            lead.email || null,
        planoInteresse:   lead.plano || 'Plano Academia',
        etapa:            'LEAD',
        origem:           'meta_ads',
        fonte:            'meta_ads',
        metaCampanhaNome: campanha,
        metaCampanhaId:   lead.campaign_id || lead.form_id || null,
        metaAdsetNome:    lead.adset || lead.adset_name || null,
        metaFormId:       lead.form_id || null,
        metaLeadId:       lead.leadgen_id || lead.id || null,
        metaUnidade:      unidade,
        observacao:       lead.observacao || null,
        historico: [{
          data:  new Date().toISOString(),
          tipo:  'criacao',
          texto: `Lead importado do Meta Ads${campanha ? ' — ' + campanha : ''}`,
        }],
        cadenciaAtiva: null,
        ultimoContato: null,
        criadoEm:     lead.created_time ? new Date(lead.created_time * 1000).toISOString() : new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
      };

      ops.push(op);
      criados_ids.push(op.id);
      criados++;

    } catch (e) {
      erros++;
      console.error('[META-IMPORT] Erro ao criar lead:', e.message);
    }
  }

  saveOps(ops);
  console.log(`[META-IMPORT] Criados: ${criados}, Duplicados: ${duplicados}, Erros: ${erros}`);
  res.json({ success: true, criados, duplicados, erros, ids: criados_ids });
});

// ─── WEBHOOK META LEAD ADS ────────────────────────────────────────────────────

// GET /api/meta/webhook — verificação da assinatura pelo Meta
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('[META-WEBHOOK] Verificação OK');
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'Verify token inválido' });
});

// POST /api/meta/webhook — recebe eventos de leads em tempo real
router.post('/webhook', async (req, res) => {
  res.status(200).json({ received: true }); // responde imediatamente (< 20s exigido pelo Meta)

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const value = change.value || {};

      try {
        // Tentar buscar dados do lead via API (requer leads_retrieval no token)
        const leadData = await meta.fetchLeadById(value.leadgen_id).catch(() => null);

        const nome     = leadData?.nome     || `Lead #${value.leadgen_id}`;
        const telefone = (leadData?.telefone || '').replace(/\D/g, '');
        const campanha = leadData?.campanha  || value.campaign_name || '';
        const unidade  = detectarUnidade(campanha);

        const ops  = loadOps();
        const dup  = telefone ? ops.find(o =>
          o.telefone === telefone && o.fonte === 'meta_ads' &&
          o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO'
        ) : null;

        if (dup) {
          console.log(`[META-WEBHOOK] Lead duplicado: ${nome} (${telefone})`);
          continue;
        }

        const op = {
          id:               uuidv4(),
          nome,
          telefone:         telefone || '',
          email:            leadData?.email || null,
          planoInteresse:   'Plano Academia',
          etapa:            'LEAD',
          origem:           'meta_ads',
          fonte:            'meta_ads',
          metaCampanhaNome: campanha,
          metaCampanhaId:   value.campaign_id || null,
          metaAdsetNome:    value.adgroup_id   || null,
          metaFormId:       value.form_id      || null,
          metaLeadId:       value.leadgen_id   || null,
          metaUnidade:      unidade,
          observacao:       null,
          historico: [{
            data:  new Date().toISOString(),
            tipo:  'criacao',
            texto: `Lead recebido via webhook Meta Ads${campanha ? ' — ' + campanha : ''}`,
          }],
          cadenciaAtiva: null,
          ultimoContato: null,
          criadoEm:     new Date(value.created_time * 1000 || Date.now()).toISOString(),
          atualizadoEm: new Date().toISOString(),
        };

        ops.push(op);
        saveOps(ops);
        console.log(`[META-WEBHOOK] Novo lead criado: ${nome} | Unidade: ${unidade}`);

      } catch (e) {
        console.error('[META-WEBHOOK] Erro ao processar lead:', e.message);
      }
    }
  }
});

// ─── BULK SEND PARA LEADS META ────────────────────────────────────────────────

/**
 * POST /api/meta/leads/bulk-send
 * Dispara mensagem/cadência para todos os leads de campanha Meta de uma unidade.
 */
router.post('/leads/bulk-send', async (req, res) => {
  const { unidade, mensagem, templateKey, cadenciaTipo } = req.body;
  if (!unidade) return res.status(400).json({ error: 'unidade é obrigatório' });

  let leads = loadOps().filter(o =>
    o.fonte === 'meta_ads' &&
    o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO' &&
    o.telefone &&
    ((o.metaUnidade || '').toUpperCase() === unidade.toUpperCase() ||
     (o.metaCampanhaNome || '').toUpperCase().includes(unidade.toUpperCase()))
  );

  if (leads.length === 0) {
    return res.status(404).json({ error: 'Nenhum lead Meta encontrado para esta unidade' });
  }

  const jobId = Date.now().toString();
  res.json({ success: true, jobId, total: leads.length });

  // Processar em background
  (async () => {
    const { MENSAGENS } = require('../flow/scripts');
    const uazapi = require('../integrations/uazapi');
    let enviados = 0, erros = 0;

    for (const lead of leads) {
      try {
        if (cadenciaTipo) {
          const cadencias = require('../flow/cadencias');
          cadencias.agendarCadencia(cadenciaTipo, lead, {});
          enviados++;
        } else {
          let texto = mensagem;
          if (!texto && templateKey && MENSAGENS[templateKey]) {
            texto = MENSAGENS[templateKey](lead.nome || 'Você', {});
          }
          if (!texto) continue;
          await uazapi.sendText(lead.telefone, texto);
          enviados++;
        }
      } catch (_) { erros++; }
      await new Promise(r => setTimeout(r, 2500));
    }
    console.log(`[META-BULK ${jobId}] ${enviados} enviados, ${erros} erros`);
  })();
});

// ─── HELPER ───────────────────────────────────────────────────────────────────

function detectarUnidade(campanha = '', hint = '') {
  const s = (campanha + ' ' + hint).toUpperCase();
  if (s.includes('NORTE'))      return 'NORTE';
  if (s.includes('ALPHAVILLE')) return 'ALPHAVILLE';
  if (s.includes('TATUAP'))     return 'TATUAPÉ';
  if (s.includes('CAMPINAS'))   return 'CAMPINAS';
  if (s.includes('LAGOA'))      return 'LAGOA';
  return 'GERAL';
}

module.exports = router;
