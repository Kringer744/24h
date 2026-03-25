require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// Rotas públicas (sem autenticação)
app.use('/api/auth', require('./src/routes/auth'));

// Arquivos estáticos públicos (login.html, assets)
app.use(express.static(path.join(__dirname, 'public')));

// ─── PROTEÇÃO DAS ROTAS DE API ───────────────────────────────────────────────
const requireAuth = require('./src/middleware/requireAuth');
app.use('/api/', requireAuth);

// ─── ROTAS PROTEGIDAS ────────────────────────────────────────────────────────
app.use('/api/dashboard',     require('./src/routes/dashboard'));
app.use('/api/alunos',        require('./src/routes/alunos'));
app.use('/api/whatsapp',      require('./src/routes/whatsapp'));
app.use('/api/cadencias',     require('./src/routes/cadencias'));
app.use('/api/oportunidades', require('./src/routes/oportunidades'));
app.use('/api/meta',          require('./src/routes/meta'));

// Status check
app.get('/api/status', async (req, res) => {
  const pacto  = require('./src/integrations/pacto');
  const uazapi = require('./src/integrations/uazapi');

  const [pactoHealth, uazapiStatus] = await Promise.allSettled([
    pacto.healthCheck(),
    uazapi.getInstanceStatus(),
  ]);

  const uazapiOk = uazapiStatus.status === 'fulfilled';
  const uazapiData = uazapiStatus.status === 'fulfilled' ? uazapiStatus.value : null;
  const tokenInvalid = uazapiData?._tokenInvalid || false;

  res.json({
    pacto:         pactoHealth.status === 'fulfilled',
    uazapi:        uazapiOk,
    uazapiWarning: tokenInvalid ? uazapiData._message : null,
    uptime: process.uptime(),
    ts: new Date().toISOString(),
  });
});

// Configuração de credenciais PACTO (salva no .env e aplica em runtime)
app.post('/api/config/pacto-credentials', async (req, res) => {
  const { pactoUser, pactoPass } = req.body || {};
  if (!pactoUser || !pactoPass) {
    return res.status(400).json({ success: false, error: 'Usuário e senha são obrigatórios' });
  }

  try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    // Substituir ou adicionar PACTO_USER e PACTO_PASS
    const update = (content, key, value) => {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      return regex.test(content)
        ? content.replace(regex, `${key}=${value}`)
        : content + `\n${key}=${value}`;
    };

    envContent = update(envContent, 'PACTO_USER', pactoUser);
    envContent = update(envContent, 'PACTO_PASS', pactoPass);
    fs.writeFileSync(envPath, envContent, 'utf8');

    // Aplicar em runtime (sem reiniciar)
    process.env.PACTO_USER = pactoUser;
    process.env.PACTO_PASS = pactoPass;

    // Disparar sync imediato com as novas credenciais
    const autoSync = require('./src/flow/autoSync');
    autoSync.runSync().catch(() => {});

    console.log('[CONFIG] Credenciais PACTO atualizadas. Sync disparado.');
    res.json({ success: true, message: 'Credenciais salvas. Sincronizando dados...' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Retorna status das credenciais (sem expor os valores)
app.get('/api/config/status', (req, res) => {
  const pactoSession = require('./src/integrations/pactoSession');
  res.json({
    hasCredentials: !!(process.env.PACTO_USER && process.env.PACTO_PASS),
    session: pactoSession.getSessionStatus(),
  });
});

// Diagnóstico público (sync key) — força sync e mostra resultado
app.get('/diag', async (req, res) => {
  const key = req.headers['x-sync-key'] || req.query.key;
  const SYNC_KEY = process.env.SYNC_KEY || '24hNorte_sync';
  if (!key || key !== SYNC_KEY) return res.status(403).json({ error: 'Forbidden' });
  const cache     = require('./src/storage/cache');
  const autoSync  = require('./src/flow/autoSync');
  let syncError   = null;
  try { await autoSync.runSync(); } catch (e) { syncError = e.message; }
  const raw   = cache.get('_raw') || null;
  const stats = cache.get('stats') || null;
  // Testa direto as chamadas de sessão para ver o que a API retorna
  const pactoSession = require('./src/integrations/pactoSession');
  let directMov = null, directFin = null, directMovErr = null, directFinErr = null;
  if (pactoSession.getSessionStatus().active) {
    [directMov, directMovErr] = await pactoSession.getMovimentacao().then(d => [d, null]).catch(e => [null, e.message]);
    [directFin, directFinErr] = await pactoSession.getFinanceiro().then(d => [d, null]).catch(e => [null, e.message]);
  }

  const axios = require('axios');
  const apiKey      = process.env.PACTO_API_KEY;
  const authUrl     = process.env.PACTO_AUTH_URL;
  const sinteticoBase = 'https://app.pactosolucoes.com.br/sintetico/prest';
  const hoje = new Date().toISOString().split('T')[0];
  const mesInicio = hoje.slice(0, 8) + '01';
  const emp = process.env.PACTO_EMPRESA_ID || '1';
  const uni = process.env.PACTO_UNIDADE_ID || '1';

  // Tenta sintetico com API key como Bearer
  let apiKeyMovResult = null, apiKeyMovErr = null;
  if (apiKey) {
    try {
      const r = await axios.get(`${sinteticoBase}/movimentacao-contratos`, {
        params: { empresa: emp, unidade: uni, dtIni: mesInicio, dtFim: hoje },
        headers: { 'Authorization': `Bearer ${apiKey}`, 'empresaId': emp, 'unidadeId': uni },
        timeout: 10000, validateStatus: s => s < 600,
      });
      apiKeyMovResult = { status: r.status, keys: r.data ? Object.keys(r.data) : null, sample: JSON.stringify(r.data).slice(0, 300) };
    } catch (e) { apiKeyMovErr = e.message; }
  }

  // Analisa ativosData do cache para derivar renovacoes/vencidos
  const cache2 = require('./src/storage/cache');
  const alunosCached = cache2.get('alunos');
  const itens = alunosCached?.items || [];
  const hoje2 = new Date();
  const em30dias = new Date(hoje2.getTime() + 30 * 24 * 60 * 60 * 1000);
  let renovacoes30 = 0, vencidosCalc = 0, semFimContrato = 0, comFimContrato = 0;
  const amostraDatas = [];
  itens.forEach(a => {
    if (!a.fimContrato) { semFimContrato++; return; }
    comFimContrato++;
    const fim = new Date(a.fimContrato);
    if (amostraDatas.length < 5) amostraDatas.push(a.fimContrato);
    if (fim > hoje2 && fim <= em30dias) renovacoes30++;
    if (fim < hoje2) vencidosCalc++;
  });

  // Testa getContratosCount com campo correto (totalElements)
  const pacto = require('./src/integrations/pacto');
  let rawContratosResp = null;
  try {
    const axios2 = require('axios');
    const config2 = require('./src/config/apis');
    const r = await axios2.get(`${config2.pacto.gatewayUrl}/adm-core-ms/v1/contratos`, {
      params: { empresa: 1, unidade: 1, situacao: 'ATIVO', size: 1 },
      headers: { 'Authorization': `Bearer ${config2.pacto.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 8000, validateStatus: s => s < 600,
    });
    rawContratosResp = { status: r.status, keys: r.data ? Object.keys(r.data) : null, sample: JSON.stringify(r.data).slice(0, 400) };
  } catch(e) { rawContratosResp = { err: e.message }; }

  res.json({
    ts: new Date().toISOString(),
    syncError,
    statsVals: stats ? {
      ativos: stats.ativos, novasVendas: stats.novasVendas,
      renovacoes30d: stats.renovacoes30d, vencidos: stats.vencidos,
      agregadores: stats.agregadores, inadimplentes: stats.inadimplentes,
      receita: stats.receita,
    } : null,
    directMovErr,
    directFinErr,
    fimContratoAnalise: { total: itens.length, comFimContrato, semFimContrato, renovacoes30, vencidosCalc, amostraDatas },
    rawContratosResp,
    pactoSession: pactoSession.getSessionStatus(),
    envVars: {
      PACTO_USER:        process.env.PACTO_USER        ? '✓' : '✗',
      PACTO_PASS:        process.env.PACTO_PASS        ? '✓' : '✗',
      PACTO_API_KEY:     process.env.PACTO_API_KEY     ? '✓' : '✗',
      PACTO_AUTH_URL:    process.env.PACTO_AUTH_URL    ? '✓ ' + process.env.PACTO_AUTH_URL : '✗',
      PACTO_SINTETICO_URL: process.env.PACTO_SINTETICO_URL ? '✓ ' + process.env.PACTO_SINTETICO_URL : '✗',
      PACTO_PERSONAGEM_URL: process.env.PACTO_PERSONAGEM_URL ? '✓ ' + process.env.PACTO_PERSONAGEM_URL : '✗',
      PACTO_EMPRESA_ID:  process.env.PACTO_EMPRESA_ID  || '(default 4)',
      PACTO_UNIDADE_ID:  process.env.PACTO_UNIDADE_ID  || '(default 4)',
      PACTO_UNIDADE_CHAVE: process.env.PACTO_UNIDADE_CHAVE || '(default 24H_NORTE)',
    },
  });
});

// Scripts / templates
app.get('/api/scripts', (req, res) => {
  const { SCRIPTS, MENSAGENS, CADENCIAS, FUNIL_ETAPAS } = require('./src/flow/scripts');
  res.json({
    scripts: Object.keys(SCRIPTS).map(k => ({ id: k, conteudo: SCRIPTS[k] })),
    templates: Object.keys(MENSAGENS),
    cadencias: Object.keys(CADENCIAS),
    funil: FUNIL_ETAPAS,
  });
});

// ─── CONFIG GERAL ─────────────────────────────────────────────────────────────
const CONFIG_FILE = require('./src/config/paths').CONFIG_FILE;
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.patch('/api/config', (req, res) => {
  const cfg = { ...loadConfig(), ...req.body };
  saveConfig(cfg);
  res.json(cfg);
});

// SPA fallback — protege o dashboard
app.get('*', (req, res, next) => {
  // login.html é público
  if (req.path === '/login.html' || req.path === '/login') {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  // Demais páginas exigem auth
  const token = req.cookies?.auth_token;
  if (!token) return res.redirect('/login.html');
  try {
    require('jsonwebtoken').verify(token, process.env.JWT_SECRET || '24hNorte_secret');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch {
    res.clearCookie('auth_token');
    res.redirect('/login.html');
  }
});

// ─── AUTO-SYNC via API Key (funciona local e no Vercel) ──────────────────────
// Busca dados do PACTO via API key automaticamente.
// No Vercel: roda uma vez quando a função é carregada (warm start).
// Localmente: roda a cada 30 min via setInterval.
const autoSync = require('./src/flow/autoSync');
autoSync.start();

// ─── START ───────────────────────────────────────────────────────────────────
// Exporta o app para o Vercel (serverless)
module.exports = app;

// Sobe o servidor apenas quando executado diretamente (local / VPS)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🏋️  24H NORTE — Sistema Comercial`);
    console.log(`📊  Dashboard:  http://localhost:${PORT}`);
    console.log(`🔌  API:        http://localhost:${PORT}/api`);
    console.log(`\n📡  PACTO:  ${process.env.PACTO_GATEWAY_URL}`);
    console.log(`💬  UAZAPI: ${process.env.UAZAPI_BASE_URL}`);
    console.log('');

    // Inicia motor de cadências (não roda em serverless)
    const { iniciarCron } = require('./src/flow/cadencias');
    iniciarCron();
  });
}
