const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const FILE = require('../config/paths').OPS_FILE;
const ETAPAS = ['LEAD', 'CONTATO', 'VISITA', 'PROPOSTA', 'FECHADO', 'PERDIDO'];

// ─── Persistência ─────────────────────────────────────────────────────────────

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// ─── GET /api/oportunidades ────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const { etapa, search, desde } = req.query;
  let items = load();
  if (etapa) items = items.filter(o => o.etapa === etapa.toUpperCase());
  if (desde) {
    const cutoff = new Date(desde);
    items = items.filter(o => new Date(o.criadoEm || 0) >= cutoff);
  }
  if (search) {
    const q = search.toLowerCase();
    items = items.filter(o =>
      (o.nome || '').toLowerCase().includes(q) ||
      (o.telefone || '').includes(q)
    );
  }
  res.json(items);
});

// ─── POST /api/oportunidades ──────────────────────────────────────────────────

router.post('/', (req, res) => {
  const { nome, telefone, email, planoInteresse, origem, observacao, pactoLeadId } = req.body;
  if (!nome || !telefone) {
    return res.status(400).json({ error: 'nome e telefone são obrigatórios' });
  }

  const items = load();
  const tel = telefone.replace(/\D/g, '');
  const dup = items.find(o => o.telefone === tel && o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO');
  if (dup) {
    return res.status(409).json({ error: 'Já existe uma oportunidade ativa para este telefone', id: dup.id });
  }

  const op = {
    id: uuidv4(),
    nome: nome.trim(),
    telefone: tel,
    email: email || null,
    planoInteresse: planoInteresse || null,
    etapa: 'LEAD',
    origem: origem || 'manual',
    pactoLeadId: pactoLeadId || null,
    observacao: observacao || null,
    historico: [{
      data: new Date().toISOString(),
      tipo: 'criacao',
      texto: `Oportunidade criada${origem && origem !== 'manual' ? ' via ' + origem : ''}`,
    }],
    cadenciaAtiva: null,
    ultimoContato: null,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
  };

  items.push(op);
  save(items);

  // Auto-iniciar cadência lead_novo (apenas para criações manuais ou importações de lead)
  if (!origem || origem === 'manual' || origem === 'pacto_crm') {
    try {
      const cadencias = require('../flow/cadencias');
      cadencias.agendarCadencia('lead_novo', op, { plano: planoInteresse || 'nossos planos' });
      op.cadenciaAtiva = 'lead_novo';
      const allItems = load();
      const idx = allItems.findIndex(o => o.id === op.id);
      if (idx !== -1) { allItems[idx].cadenciaAtiva = 'lead_novo'; save(allItems); }
    } catch (e) {
      console.warn('[OPS] Auto-cadência não iniciada:', e.message);
    }
  }

  res.status(201).json(op);
});

// ─── POST /api/oportunidades/importar-inadimplentes ───────────────────────────
// Importa a lista de inadimplentes do cache para o Funil CRM como leads de cobrança

router.post('/importar-inadimplentes', (req, res) => {
  const cache = require('../storage/cache');
  const inadCache = cache.get('inadimplentes_lista');
  const lista = inadCache?.items || [];

  if (!lista.length) {
    return res.status(404).json({
      success: false,
      error: 'Nenhum inadimplente no cache. Execute o Bookmarklet ou aguarde o sync.',
    });
  }

  const items = load();
  let criados = 0, ignorados = 0;

  for (const c of lista) {
    const tel = (c.telefone || '').replace(/\D/g, '');
    if (!tel || !c.nome) { ignorados++; continue; }

    const dup = items.find(o => o.telefone === tel && o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO');
    if (dup) { ignorados++; continue; }

    const op = {
      id: uuidv4(),
      nome: c.nome.trim(),
      telefone: tel,
      email: c.email || null,
      planoInteresse: null,
      etapa: 'LEAD',
      origem: 'inadimplente',
      pactoLeadId: c.matricula || null,
      observacao: 'Inadimplente — enviar mensagem de cobrança amigável',
      historico: [{
        data: new Date().toISOString(),
        tipo: 'criacao',
        texto: 'Importado da lista de inadimplentes para ação de cobrança',
      }],
      cadenciaAtiva: null,
      ultimoContato: null,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
    };
    items.push(op);
    criados++;

    // Auto-iniciar cadência de cobrança
    try {
      const cadencias = require('../flow/cadencias');
      cadencias.agendarCadencia('reativacao', op, {});
      op.cadenciaAtiva = 'reativacao';
      items[items.length - 1].cadenciaAtiva = 'reativacao';
    } catch (_) {}
  }

  save(items);
  res.json({ success: true, criados, ignorados, total: items.length });
});

// ─── POST /api/oportunidades/importar-inativos ───────────────────────────────

router.post('/importar-inativos', async (req, res) => {
  try {
    const { pagina = 0, tamanho = 50 } = req.body;
    const axios  = require('axios');
    const config = require('../config/apis');

    const gateway = axios.create({
      baseURL: config.pacto.gatewayUrl,
      headers: { 'Authorization': `Bearer ${config.pacto.apiKey}` },
      timeout: 20000,
    });

    // Tentar dois endpoints para inativos
    let clientes = [];
    const endpoints = [
      `/v1/cliente/situacao=INATIVO`,
      `/psec/clientes/inativos`,
    ];
    for (const ep of endpoints) {
      try {
        const resp = await gateway.get(ep, { params: { page: pagina, size: tamanho } });
        clientes = resp.data?.content || resp.data?.clientes || resp.data || [];
        if (clientes.length) break;
      } catch (_) {}
    }

    const items = load();
    let criados = 0, ignorados = 0;

    for (const c of clientes) {
      const tel = (c.telefones?.[0]?.numero || c.telefone || '').replace(/\D/g, '');
      if (!tel || !c.nome) { ignorados++; continue; }

      const dup = items.find(o => o.telefone === tel && o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO');
      if (dup) { ignorados++; continue; }

      items.push({
        id: uuidv4(),
        nome: c.nome.trim(),
        telefone: tel,
        email: c.emails?.[0] || null,
        planoInteresse: null,
        etapa: 'LEAD',
        origem: 'pacto_inativo',
        pactoLeadId: String(c.cliente || c.id || ''),
        observacao: `Inativo desde: ${c.fimContrato || 'desconhecido'}`,
        historico: [{ data: new Date().toISOString(), tipo: 'criacao', texto: 'Importado do PACTO como cliente inativo (reativação)' }],
        cadenciaAtiva: null,
        ultimoContato: null,
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
      });
      criados++;
    }

    save(items);
    res.json({ success: true, criados, ignorados, total: items.length, pagina, maisDisponiveis: clientes.length === tamanho });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/oportunidades/kanban/resumo ──────────────────────────────────

router.get('/kanban/resumo', (req, res) => {
  const items = load();
  const resumo = {};
  for (const etapa of ETAPAS) {
    const grupo = items.filter(o => o.etapa === etapa);
    resumo[etapa] = { total: grupo.length, items: grupo };
  }
  res.json(resumo);
});

// ─── GET /api/oportunidades/:id ──────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const items = load();
  const op = items.find(o => o.id === req.params.id);
  if (!op) return res.status(404).json({ error: 'não encontrado' });
  res.json(op);
});

// ─── PUT /api/oportunidades/:id ──────────────────────────────────────────────

router.put('/:id', (req, res) => {
  const items = load();
  const idx = items.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'não encontrado' });

  const op = items[idx];
  const { etapa, nome, telefone, email, planoInteresse, observacao, cadenciaAtiva } = req.body;

  if (etapa && etapa !== op.etapa) {
    if (!ETAPAS.includes(etapa)) {
      return res.status(400).json({ error: 'etapa inválida', etapas: ETAPAS });
    }
    op.historico.push({
      data: new Date().toISOString(),
      tipo: 'etapa',
      texto: `Movido de ${op.etapa} → ${etapa}`,
    });
    op.etapa = etapa;

    // Ao fechar ou perder, cancelar cadências pendentes
    if (etapa === 'FECHADO' || etapa === 'PERDIDO') {
      try {
        const cadencias = require('../flow/cadencias');
        cadencias.cancelarCadencia(op.id);
        op.cadenciaAtiva = null;
      } catch (_) {}
    }
  }

  if (nome !== undefined)           op.nome           = nome.trim();
  if (telefone !== undefined)       op.telefone       = telefone.replace(/\D/g, '');
  if (email !== undefined)          op.email          = email;
  if (planoInteresse !== undefined) op.planoInteresse = planoInteresse;
  if (observacao !== undefined)     op.observacao     = observacao;
  if (cadenciaAtiva !== undefined)  op.cadenciaAtiva  = cadenciaAtiva;

  op.atualizadoEm = new Date().toISOString();
  items[idx] = op;
  save(items);
  res.json(op);
});

// ─── DELETE /api/oportunidades/:id ───────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const items = load();
  const idx = items.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'não encontrado' });
  // Cancelar cadências pendentes antes de deletar
  try {
    const cadencias = require('../flow/cadencias');
    cadencias.cancelarCadencia(items[idx].id);
  } catch (_) {}
  items.splice(idx, 1);
  save(items);
  res.json({ success: true });
});

// ─── POST /api/oportunidades/:id/historico ────────────────────────────────────

router.post('/:id/historico', (req, res) => {
  const { texto, tipo } = req.body;
  const items = load();
  const idx = items.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'não encontrado' });

  const entry = {
    data: new Date().toISOString(),
    tipo: tipo || 'nota',
    texto: texto || '',
  };
  items[idx].historico.push(entry);
  items[idx].atualizadoEm = new Date().toISOString();
  if (tipo === 'mensagem' || tipo === 'whatsapp' || tipo === 'whatsapp_recebido') {
    items[idx].ultimoContato = new Date().toISOString();
  }
  save(items);
  res.json(items[idx]);
});

// ─── POST /api/oportunidades/importar ────────────────────────────────────────

router.post('/importar', (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads)) return res.status(400).json({ error: 'leads deve ser array' });

  const items = load();
  let criados = 0, ignorados = 0;

  for (const l of leads) {
    const tel = (l.telefone || l.phone || '').replace(/\D/g, '');
    if (!tel || !l.nome) { ignorados++; continue; }

    const dup = items.find(o => o.telefone === tel && o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO');
    if (dup) { ignorados++; continue; }

    const op = {
      id: uuidv4(),
      nome: (l.nome || '').trim(),
      telefone: tel,
      email: l.email || null,
      planoInteresse: l.plano || l.planoInteresse || null,
      etapa: l.etapa || 'LEAD',
      origem: 'pacto_crm',
      pactoLeadId: l.id || l.leadId || null,
      observacao: l.observacao || null,
      historico: [{ data: new Date().toISOString(), tipo: 'criacao', texto: 'Importado do PACTO CRM' }],
      cadenciaAtiva: null,
      ultimoContato: null,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
    };
    items.push(op);
    criados++;

    // Auto-cadência para novos leads importados
    try {
      const cadencias = require('../flow/cadencias');
      cadencias.agendarCadencia('lead_novo', op, { plano: op.planoInteresse || 'nossos planos' });
      items[items.length - 1].cadenciaAtiva = 'lead_novo';
    } catch (_) {}
  }

  save(items);
  res.json({ success: true, criados, ignorados, total: items.length });
});

module.exports = router;
