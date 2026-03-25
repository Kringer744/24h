const express = require('express');
const router = express.Router();
const { agendarCadencia, cancelarCadencia, cancelarAgendamento, getFila } = require('../flow/cadencias');
const { CADENCIAS } = require('../flow/scripts');

// POST /api/cadencias/iniciar
router.post('/iniciar', async (req, res) => {
  try {
    const { nome, telefone, tipo, params, oportunidadeId } = req.body;
    if (!nome || !telefone || !tipo) {
      return res.status(400).json({ success: false, error: 'nome, telefone e tipo são obrigatórios' });
    }
    if (!CADENCIAS[tipo]) {
      return res.status(400).json({ success: false, error: `Tipo de cadência "${tipo}" não encontrado` });
    }
    const leadId = oportunidadeId || `${Date.now()}`;
    const lead = { id: leadId, nome, telefone };
    const agendamentos = agendarCadencia(tipo, lead, params || {});

    // Registrar no histórico da oportunidade se vinculada
    if (oportunidadeId) {
      try {
        const fs = require('fs');
        const FILE = require('../config/paths').OPS_FILE;
        const items = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const idx = items.findIndex(o => o.id === oportunidadeId);
        if (idx !== -1) {
          items[idx].cadenciaAtiva = tipo;
          items[idx].atualizadoEm = new Date().toISOString();
          items[idx].historico.push({
            data: new Date().toISOString(),
            tipo: 'cadencia',
            texto: `Cadência "${tipo.replace(/_/g,' ')}" iniciada — ${agendamentos.length} mensagens agendadas`,
          });
          fs.writeFileSync(FILE, JSON.stringify(items, null, 2));
        }
      } catch (_) {}
    }

    res.json({ success: true, agendamentos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/cadencias/cancelar/:leadId  — cancela todos do lead
router.delete('/cancelar/:leadId', (req, res) => {
  try {
    const count = cancelarCadencia(req.params.leadId);
    res.json({ success: true, cancelados: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/cadencias/agendamento/:id  — cancela agendamento individual
router.delete('/agendamento/:id', (req, res) => {
  try {
    const count = cancelarAgendamento(req.params.id);
    res.json({ success: true, cancelados: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/cadencias/fila
router.get('/fila', (req, res) => {
  const fila = getFila(req.query);
  res.json({ fila, total: fila.length });
});

// GET /api/cadencias/massa/preview?base=ativos|inadimplentes|oportunidades
router.get('/massa/preview', (req, res) => {
  try {
    const { base } = req.query;
    const cache = require('../storage/cache');
    let total = 0;

    if (base === 'ativos') {
      const items = (cache.get('alunos')?.items || []);
      total = items.filter(a => a.nome && (a.numero || a.telefone || '').replace(/\D/g, '')).length;
    } else if (base === 'inadimplentes') {
      const items = (cache.get('inadimplentes_lista')?.items || []);
      total = items.filter(a => a.nome && (a.telefone || '').replace(/\D/g, '')).length;
    } else if (base === 'oportunidades') {
      const fs = require('fs');
      try {
        const items = JSON.parse(fs.readFileSync(require('../config/paths').OPS_FILE, 'utf8'));
        total = items.filter(o => o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO' && o.nome && o.telefone).length;
      } catch (_) {}
    }

    res.json({ total });
  } catch (err) {
    res.status(500).json({ error: err.message, total: 0 });
  }
});

// POST /api/cadencias/massa — agenda cadência para toda uma base de contatos
router.post('/massa', async (req, res) => {
  try {
    const { base, tipo } = req.body;
    if (!base || !tipo) {
      return res.status(400).json({ success: false, error: 'base e tipo são obrigatórios' });
    }
    if (!CADENCIAS[tipo]) {
      return res.status(400).json({ success: false, error: `Tipo de cadência "${tipo}" não encontrado` });
    }

    const cache = require('../storage/cache');
    let contatos = [];

    if (base === 'ativos') {
      const items = cache.get('alunos')?.items || [];
      contatos = items.map(a => ({
        id: String(a.matricula || a.id || Math.random()),
        nome: a.nome,
        telefone: (a.numero || a.telefone || '').replace(/\D/g, ''),
      })).filter(c => c.nome && c.telefone);
    } else if (base === 'inadimplentes') {
      const items = cache.get('inadimplentes_lista')?.items || [];
      contatos = items.map(a => ({
        id: String(a.matricula || a.id || Math.random()),
        nome: a.nome,
        telefone: (a.telefone || '').replace(/\D/g, ''),
      })).filter(c => c.nome && c.telefone);
    } else if (base === 'oportunidades') {
      const fs = require('fs');
      try {
        const items = JSON.parse(fs.readFileSync(require('../config/paths').OPS_FILE, 'utf8'));
        contatos = items
          .filter(o => o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO')
          .map(o => ({ id: o.id, nome: o.nome, telefone: o.telefone }))
          .filter(c => c.nome && c.telefone);
      } catch (_) {}
    } else {
      return res.status(400).json({ success: false, error: 'base inválida' });
    }

    let agendados = 0, erros = 0;
    for (const c of contatos) {
      try {
        agendarCadencia(tipo, c, {});
        agendados++;
      } catch (_) { erros++; }
    }

    res.json({ success: true, agendados, erros, total: contatos.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/cadencias/tipos
router.get('/tipos', (req, res) => {
  res.json({
    tipos: Object.keys(CADENCIAS).map(k => ({
      id: k,
      nome: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      etapas: CADENCIAS[k].length,
    })),
  });
});

module.exports = router;
