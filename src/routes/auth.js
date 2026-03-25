const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');

const NOCODB_URL   = process.env.NOCODB_API_URL   || 'https://app.nocodb.com';
const NOCODB_TOKEN = process.env.NOCODB_API_TOKEN;
const BASE_ID      = process.env.NOCODB_BASE_ID;
const TABLE_ID     = process.env.NOCODB_USUARIOS_TABLE;
const JWT_SECRET   = process.env.JWT_SECRET || '24hNorte_secret';
const JWT_EXP      = '8h';

const nocodb = axios.create({
  baseURL: NOCODB_URL,
  headers: { 'xc-token': NOCODB_TOKEN },
  timeout: 8000,
});

function hashSenha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }

  try {
    // Busca usuário pelo email no NocoDB
    // NocoDB retorna colunas com Title (pode ser capitalizado)
    const r = await nocodb.get(`/api/v1/db/data/noco/${BASE_ID}/${TABLE_ID}`, {
      params: { where: `(Email,eq,${email.toLowerCase().trim()})`, limit: 1 },
    });

    const users = r.data?.list || [];
    if (!users.length) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const u = users[0];
    // Normaliza campos (NocoDB pode retornar Email ou email)
    const uEmail  = u.Email  || u.email  || '';
    const uSenha  = u.Senha  || u.senha  || '';
    const uNome   = u.Nome   || u.nome   || '';
    const uRole   = u.Role   || u.role   || 'admin';
    const uAtivo  = u.Ativo  ?? u.ativo  ?? true;

    if (!uAtivo) {
      return res.status(401).json({ error: 'Usuário desativado' });
    }

    if (uSenha !== hashSenha(senha)) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Atualiza último login
    try {
      await nocodb.patch(`/api/v1/db/data/noco/${BASE_ID}/${TABLE_ID}/${u.Id}`, {
        UltimoLogin: new Date().toISOString(),
      });
    } catch (_) {}

    // Gera JWT
    const token = jwt.sign(
      { id: u.Id, email: uEmail, nome: uNome, role: uRole },
      JWT_SECRET,
      { expiresIn: JWT_EXP }
    );

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure:   false,
      maxAge:   8 * 60 * 60 * 1000,
      sameSite: 'lax',
    });

    res.json({ success: true, token, user: { id: u.Id, email: uEmail, nome: uNome, role: uRole } });
  } catch (err) {
    console.error('[AUTH] Erro no login:', err.message);
    res.status(500).json({ error: 'Erro ao autenticar' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// GET /api/auth/me — valida token e retorna usuário
router.get('/me', (req, res) => {
  const token = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded });
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
});

module.exports = router;
