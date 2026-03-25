const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const uazapi = require('../integrations/uazapi');

// Upload de imagens — usa /tmp no Vercel (serverless), public/uploads localmente
const UPLOADS_DIR = process.env.VERCEL
  ? '/tmp/uploads'
  : path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `img_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Job tracker em memória
const bulkJobs = {};
function createJob(total) {
  const id = `bulk_${Date.now()}`;
  bulkJobs[id] = { id, total, sent: 0, erros: 0, skipped: 0, status: 'running', startedAt: new Date().toISOString(), log: [] };
  return id;
}
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pickVariacao(variacoes) {
  if (!variacoes?.length) return '';
  return variacoes[Math.floor(Math.random() * variacoes.length)];
}

const OPS_FILE = require('../config/paths').OPS_FILE;

function loadOps() {
  try { return JSON.parse(fs.readFileSync(OPS_FILE, 'utf8')); } catch { return []; }
}
function saveOps(data) {
  fs.writeFileSync(OPS_FILE, JSON.stringify(data, null, 2));
}

// POST /api/whatsapp/send
router.post('/send', async (req, res) => {
  try {
    const { telefone, texto, nome } = req.body;
    if (!telefone || !texto) {
      return res.status(400).json({ success: false, error: 'telefone e texto são obrigatórios' });
    }
    const result = await uazapi.sendText(telefone, texto);
    res.json({ success: true, data: result, nome });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/send-image — envia imagem e, se houver texto, envia como mensagem separada
router.post('/send-image', async (req, res) => {
  try {
    const { telefone, imagemUrl, caption, nome } = req.body;
    if (!telefone || !imagemUrl) {
      return res.status(400).json({ success: false, error: 'telefone e imagemUrl são obrigatórios' });
    }

    // Envia a imagem (sem caption — UAZAPI ignora o campo caption em /send/media)
    const result = await uazapi.sendImage(telefone, imagemUrl, '');

    // Se tem texto, envia como mensagem de texto separada logo em seguida
    if (caption && caption.trim()) {
      await new Promise(r => setTimeout(r, 800)); // pequeno delay natural
      await uazapi.sendText(telefone, caption.trim());
    }

    res.json({ success: true, data: result, nome });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/send-bulk
router.post('/send-bulk', async (req, res) => {
  try {
    const { contatos, mensagem, delay } = req.body;
    if (!contatos || !mensagem) {
      return res.status(400).json({ success: false, error: 'contatos e mensagem são obrigatórios' });
    }
    const results = await uazapi.sendBulk(contatos, mensagem, delay || 2000);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/status
router.get('/status', async (req, res) => {
  try {
    const status = await uazapi.getInstanceStatus();
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/webhook
// Recebe eventos do UAZAPI — registra respostas no CRM automaticamente
router.post('/webhook', (req, res) => {
  const event = req.body;

  if (event.event === 'messages.upsert') {
    const msg = event.data;
    // Só processa mensagens RECEBIDAS (não enviadas por nós)
    if (msg && !msg.key?.fromMe) {
      const jid   = msg.key?.remoteJid || '';
      const phone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace(/\D/g, '');
      const text  = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '[mídia]'
      ).substring(0, 300);

      if (phone.length >= 10) {
        try {
          const items = loadOps();
          const idx = items.findIndex(
            o => o.telefone === phone && o.etapa !== 'FECHADO' && o.etapa !== 'PERDIDO'
          );
          if (idx !== -1) {
            const op = items[idx];
            op.historico.push({
              data: new Date().toISOString(),
              tipo: 'whatsapp_recebido',
              texto: `Respondeu via WhatsApp: "${text}"`,
            });
            op.ultimoContato = new Date().toISOString();
            op.atualizadoEm = new Date().toISOString();
            // Se ainda está em LEAD e respondeu, avança para CONTATO automaticamente
            if (op.etapa === 'LEAD') {
              op.historico.push({
                data: new Date().toISOString(),
                tipo: 'etapa',
                texto: 'Movido de LEAD → CONTATO (respondeu via WhatsApp)',
              });
              op.etapa = 'CONTATO';
            }
            items[idx] = op;
            saveOps(items);
            console.log(`[WEBHOOK] Resposta de ${op.nome} (${phone}) registrada — etapa: ${op.etapa}`);
          } else {
            console.log(`[WEBHOOK] Mensagem de ${phone} sem lead correspondente no CRM`);
          }
        } catch (e) {
          console.error('[WEBHOOK] Erro ao atualizar CRM:', e.message);
        }
      }
    }
  }

  res.json({ received: true });
});

// GET /api/whatsapp/contacts
router.get('/contacts', async (req, res) => {
  try {
    const contacts = await uazapi.getContacts();
    res.json({ success: true, contacts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/broadcast — dispara mensagem para toda a base
router.post('/broadcast', async (req, res) => {
  try {
    const { templateKey, mensagemCustom } = req.body;
    const cache = require('../storage/cache');
    const { MENSAGENS } = require('../flow/scripts');

    const alunosCache = cache.get('alunos');
    if (!alunosCache?.items?.length) {
      return res.status(400).json({ success: false, error: 'Nenhum aluno no cache. Aguarde o sync automático.' });
    }

    const target = req.body.target || 'ativos';
    let baseList = alunosCache.items;
    if (target === 'inadimplentes') {
      const inadCache = cache.get('inadimplentes_lista');
      baseList = inadCache?.items || [];
    }
    const alunos = baseList.filter(a => a.telefone && a.telefone.replace(/\D/g,'').length >= 10);
    if (!templateKey && !mensagemCustom) {
      return res.status(400).json({ success: false, error: 'templateKey ou mensagemCustom obrigatório' });
    }

    const jobId = Date.now().toString();
    res.json({ success: true, jobId, total: alunos.length });

    (async () => {
      let enviados = 0, erros = 0;
      for (const aluno of alunos) {
        try {
          let texto = mensagemCustom;
          if (!texto && templateKey && MENSAGENS[templateKey]) {
            texto = MENSAGENS[templateKey](aluno.nome || 'Aluno', {});
          }
          if (!texto) continue;
          await uazapi.sendText(aluno.telefone.replace(/\D/g,''), texto);
          enviados++;
        } catch (_) { erros++; }
        await new Promise(r => setTimeout(r, 3500));
      }
      console.log(`[BROADCAST ${jobId}] Concluído: ${enviados} enviados, ${erros} erros`);
    })();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/broadcast/preview — retorna count de alunos com telefone
router.get('/broadcast/preview', (req, res) => {
  const cache = require('../storage/cache');
  const target = req.query.target || 'ativos';
  if (target === 'inadimplentes') {
    const inadCache = cache.get('inadimplentes_lista');
    const items = (inadCache?.items || []).filter(a => a.telefone && a.telefone.replace(/\D/g,'').length >= 10);
    return res.json({ total: items.length, target: 'inadimplentes' });
  }
  const alunosCache = cache.get('alunos');
  const alunos = (alunosCache?.items || []).filter(a => a.telefone && a.telefone.replace(/\D/g,'').length >= 10);
  res.json({ total: alunos.length, target: 'ativos', syncedAt: alunosCache ? 'ok' : null });
});

// POST /api/whatsapp/upload-image — salva imagem e retorna URL/path
router.post('/upload-image', upload.single('imagem'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  // No Vercel retorna o path absoluto (não é servido como estático, mas o backend consegue ler)
  // Localmente retorna a URL pública
  const url = process.env.VERCEL
    ? path.join(UPLOADS_DIR, req.file.filename)
    : `/uploads/${req.file.filename}`;
  res.json({ success: true, url, filename: req.file.filename });
});

// POST /api/whatsapp/bulk-csv — disparo em massa com anti-bloqueio
router.post('/bulk-csv', async (req, res) => {
  const { contatos, variacoes, imagemUrl, delayMin = 8, delayMax = 20 } = req.body;

  if (!contatos?.length)
    return res.status(400).json({ error: 'Nenhum contato fornecido' });
  if (!variacoes?.length)
    return res.status(400).json({ error: 'Pelo menos uma variação de mensagem é obrigatória' });

  const jobId = createJob(contatos.length);
  res.json({ success: true, jobId, total: contatos.length });

  // Roda em background
  (async () => {
    const job = bulkJobs[jobId];
    for (const c of contatos) {
      if (job.status === 'aborted') break;
      const phone = String(c.telefone || c.numero || '').replace(/\D/g, '');
      if (!phone || phone.length < 10) {
        job.skipped++;
        job.log.push({ nome: c.nome, status: 'skipped', motivo: 'telefone inválido' });
        continue;
      }
      const nome = String(c.nome || '').trim();
      const texto = pickVariacao(variacoes).replace(/\{nome\}/gi, nome || 'você');

      try {
        if (imagemUrl) {
          // Envia imagem primeiro (caption ignorado pelo UAZAPI)
          await uazapi.sendImage(phone, imagemUrl, '');
          // Texto como mensagem separada logo após
          if (texto && texto.trim()) {
            await new Promise(r => setTimeout(r, 800));
            await uazapi.sendText(phone, texto.trim());
          }
        } else {
          await uazapi.sendText(phone, texto);
        }
        job.sent++;
        job.log.push({ nome, telefone: phone, status: 'sent' });
      } catch (err) {
        job.erros++;
        job.log.push({ nome, telefone: phone, status: 'error', motivo: err.message });
        console.error(`[BULK ${jobId}] Erro ${phone}: ${err.message}`);
      }

      // Delay randômico anti-bloqueio (segundos → ms)
      const delay = randInt(delayMin, delayMax) * 1000;
      await new Promise(r => setTimeout(r, delay));
    }
    job.status = job.status === 'aborted' ? 'aborted' : 'done';
    job.finishedAt = new Date().toISOString();
    console.log(`[BULK ${jobId}] Concluído: ${job.sent} enviados, ${job.erros} erros, ${job.skipped} pulados`);
  })();
});

// GET /api/whatsapp/bulk-status/:jobId
router.get('/bulk-status/:jobId', (req, res) => {
  const job = bulkJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json(job);
});

// POST /api/whatsapp/bulk-abort/:jobId
router.post('/bulk-abort/:jobId', (req, res) => {
  const job = bulkJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  job.status = 'aborted';
  res.json({ success: true });
});

module.exports = router;
