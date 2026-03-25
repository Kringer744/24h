const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || '24hNorte_secret';
const SYNC_KEY   = process.env.SYNC_KEY   || '24hNorte_sync';

module.exports = function requireAuth(req, res, next) {
  // Bookmarklet sync — aceita chave especial no header em vez de JWT
  if (req.method === 'POST' && req.path === '/dashboard/sync') {
    const key = req.headers['x-sync-key'];
    if (key && key === SYNC_KEY) return next();
  }

  const token = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    // Se for request de API (JSON), retorna 401
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    // Senão, redireciona para login
    return res.redirect('/login.html');
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('auth_token');
    if (req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Sessão expirada' });
    }
    return res.redirect('/login.html');
  }
};
