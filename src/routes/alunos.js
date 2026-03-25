const express = require('express');
const router = express.Router();
const pacto = require('../integrations/pacto');
const cache = require('../storage/cache');

// GET /api/alunos — lista alunos (prioridade: cache de ativos PACTO, fallback: /clientes)
router.get('/', async (req, res) => {
  // Prioridade 1: cache de ativos populado pelo /api/dashboard/stats
  const cachedAlunos = cache.get('alunos');
  if (cachedAlunos?.items?.length > 0) {
    const { page = 0, size = 100, search } = req.query;
    let items = cachedAlunos.items;
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(a => (a.nome || '').toLowerCase().includes(q));
    }
    const start = parseInt(page) * parseInt(size);
    const pageItems = items.slice(start, start + parseInt(size));
    return res.json(pageItems);
  }

  // Fallback: endpoint /clientes do PACTO
  try {
    const params = { page: 0, size: 50, ...req.query };
    const data = await pacto.getClientes(params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alunos/inadimplentes
router.get('/inadimplentes', async (req, res) => {
  try {
    const cache = require('../storage/cache');
    // Try from cache first (inadimplentes list)
    const cached = cache.get('inadimplentes_lista');
    if (cached?.items?.length > 0) {
      const { search } = req.query;
      let items = cached.items;
      if (search) items = items.filter(a => (a.nome||'').toLowerCase().includes(search.toLowerCase()));
      return res.json({ items, total: cached.total, source: 'cache' });
    }

    // Fetch fresh from PACTO using the full fallback chain
    const items = await pacto.getContratosInadimplentes();
    if (items.length > 0) {
      cache.set('inadimplentes_lista', { items, total: items.length });
    }
    const { search } = req.query;
    const filtered = search ? items.filter(a => a.nome.toLowerCase().includes(search.toLowerCase())) : items;
    res.json({ items: filtered, total: items.length, source: 'pacto' });
  } catch (err) {
    res.status(500).json({ error: err.message, items: [], total: 0 });
  }
});

// GET /api/alunos/:id
router.get('/:id', async (req, res) => {
  try {
    const data = await pacto.getClienteById(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
