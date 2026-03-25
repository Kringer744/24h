require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const cookieParser = require('cookie-parser');

const app = express();

// Detect port from environment or command line arguments
let PORT = process.env.PORT || 3000;
const portArgIndex = process.argv.indexOf('--port');
if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
  PORT = process.argv[portArgIndex + 1];
}

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
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const update = (content, key, value) => {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      return regex.test(content)
        ? content.replace(regex, `${key}=${value}`)
        : content + `\n${key}=${value}`;
    };

    envContent = update(envContent, 'PACTO_USER', pactoUser);
    envContent = update(envContent, 'PACTO_PASS', pactoPass);
    fs.writeFileSync(envPath, envContent, 'utf8');

    process.env.PACTO_USER = pactoUser;
    process.env.PACTO_PASS = pactoPass;

    const autoSync = require('./src/flow/autoSync');
    autoSync.runSync().catch(() => {});

    res.json({ success: true, message: 'Credenciais salvas. Sincronizando dados...' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/config/status', (req, res) => {
  const pactoSession = require('./src/integrations/pactoSession');
  res.json({
    hasCredentials: !!(process.env.PACTO_USER && process.env.PACTO_PASS),
    session: pactoSession.getSessionStatus(),
  });
});

app.get('/api/scripts', (req, res) => {
  const { SCRIPTS, MENSAGENS, CADENCIAS, FUNIL_ETAPAS } = require('./src/flow/scripts');
  res.json({
    scripts: Object.keys(SCRIPTS).map(k => ({ id: k, conteudo: SCRIPTS[k] })),
    templates: Object.keys(MENSAGENS),
    cadencias: Object.keys(CADENCIAS),
    funil: FUNIL_ETAPAS,
  });
});

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

app.get('*', (req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login') {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
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

const autoSync = require('./src/flow/autoSync');
autoSync.start();

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`\n🏋️  24H NORTE — Sistema Comercial`);
    console.log(`📊  Dashboard:  http://localhost:${PORT}`);
    console.log(`🔌  API:        http://localhost:${PORT}/api`);
    console.log(`\n📡  PACTO:  ${process.env.PACTO_GATEWAY_URL}`);
    console.log(`💬  UAZAPI: ${process.env.UAZAPI_BASE_URL}`);
    console.log('');

    const { iniciarCron } = require('./src/flow/cadencias');
    iniciarCron();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Please check if another instance is running.`);
      process.exit(1);
    } else {
      throw err;
    }
  });
}