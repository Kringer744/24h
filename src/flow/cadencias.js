/**
 * Motor de Cadências - Gerencia envio automático de mensagens
 * Executa as cadências de follow-up baseado em timers/cron
 * A fila é persistida em data/cadencias.json para sobreviver restarts
 */

const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const uazapi  = require('../integrations/uazapi');
const { MENSAGENS, CADENCIAS } = require('./scripts');

const FILA_FILE = require('../config/paths').CADENCIAS_FILE;

// ── Persistência ────────────────────────────────────────────────────────────

function loadFila() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILA_FILE, 'utf8'));
    // Converter dataEnvio strings de volta para Date
    return raw.map(a => ({ ...a, dataEnvio: new Date(a.dataEnvio) }));
  } catch {
    return [];
  }
}

let _savePending = false;
function saveFila() {
  if (_savePending) return;
  _savePending = true;
  setImmediate(() => {
    _savePending = false;
    try {
      fs.writeFileSync(FILA_FILE, JSON.stringify(filaAgendamentos, null, 2));
    } catch (e) {
      console.error('[CADENCIA] Erro ao salvar fila:', e.message);
    }
  });
}

// Fila em memória — carregada do disco na inicialização
const filaAgendamentos = loadFila();
console.log(`[CADENCIA] Fila carregada: ${filaAgendamentos.length} agendamentos`);

// ── Agendamento ─────────────────────────────────────────────────────────────

function agendarCadencia(tipo, lead, params = {}) {
  const cadencia = CADENCIAS[tipo];
  if (!cadencia) throw new Error(`Cadência "${tipo}" não encontrada`);

  const agora = new Date();

  cadencia.forEach(etapa => {
    const dataEnvio = new Date(agora);
    dataEnvio.setDate(dataEnvio.getDate() + etapa.dia);
    if (params.dataReferencia && etapa.dia < 0) {
      const ref = new Date(params.dataReferencia);
      const dataEnvioRef = new Date(ref);
      dataEnvioRef.setDate(dataEnvioRef.getDate() + etapa.dia);
      dataEnvio.setTime(dataEnvioRef.getTime());
    }

    const agendamento = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      leadId:         lead.id || lead.matricula,
      leadNome:       lead.nome,
      leadTelefone:   lead.telefone || lead.numero,
      tipo:           etapa.tipo,
      mensagemTipo:   etapa.mensagem,
      descricao:      etapa.descricao,
      dataEnvio,
      params,
      status:         'pendente',
      cadenciaTipo:   tipo,
    };

    filaAgendamentos.push(agendamento);
    console.log(`[CADENCIA] Agendado: ${etapa.descricao} para ${lead.nome} em ${dataEnvio.toLocaleString('pt-BR')}`);
  });

  saveFila();
  return filaAgendamentos.filter(a => a.leadId === (lead.id || lead.matricula));
}

// ── Cancelamento ────────────────────────────────────────────────────────────

function cancelarCadencia(leadId) {
  const cancelados = filaAgendamentos.filter(a => a.leadId === leadId && a.status === 'pendente');
  cancelados.forEach(a => { a.status = 'cancelado'; });
  console.log(`[CADENCIA] Cancelados ${cancelados.length} agendamentos para lead ${leadId}`);
  saveFila();
  return cancelados.length;
}

function cancelarAgendamento(agendamentoId) {
  const ag = filaAgendamentos.find(a => a.id === agendamentoId);
  if (!ag || ag.status !== 'pendente') return 0;
  ag.status = 'cancelado';
  console.log(`[CADENCIA] Agendamento ${agendamentoId} cancelado`);
  saveFila();
  return 1;
}

// ── Processamento ───────────────────────────────────────────────────────────

async function processarFila() {
  const agora = new Date();
  const pendentes = filaAgendamentos.filter(
    a => a.status === 'pendente' && new Date(a.dataEnvio) <= agora
  );

  if (pendentes.length === 0) return;

  console.log(`[CADENCIA] Processando ${pendentes.length} mensagens...`);

  for (const agendamento of pendentes) {
    try {
      agendamento.status = 'enviando';

      const templateFn = MENSAGENS[agendamento.mensagemTipo];
      let texto;

      if (typeof templateFn === 'function') {
        texto = buildTexto(agendamento.mensagemTipo, agendamento);
      } else {
        texto = templateFn || `Olá, ${agendamento.leadNome}!`;
      }

      await uazapi.sendText(agendamento.leadTelefone, texto);
      agendamento.status   = 'enviado';
      agendamento.enviadoEm = new Date();
      console.log(`[CADENCIA] Enviado para ${agendamento.leadNome}: ${agendamento.descricao}`);

    } catch (err) {
      agendamento.status = 'erro';
      agendamento.erro   = err.message;
      console.error(`[CADENCIA] Erro ao enviar para ${agendamento.leadNome}: ${err.message}`);
    }
  }

  saveFila();
}

function buildTexto(tipo, agendamento) {
  const { leadNome: nome, params } = agendamento;
  const fn = MENSAGENS[tipo];
  if (!fn) return `Olá, ${nome}!`;

  switch (tipo) {
    case 'confirmacao_visita':  return fn(nome, params.data, params.hora);
    case 'lembrete_visita':     return fn(nome, params.hora);
    case 'lembrete_dia':        return fn(nome, params.hora);
    case 'reagendamento':       return fn(nome);
    case 'pos_atendimento':     return fn(nome);
    case 'follow_up_d1':        return fn(nome, params.plano);
    case 'follow_up_d3':
    case 'follow_up_d7':        return fn(nome);
    case 'boas_vindas':         return fn(nome, params.plano);
    case 'lembrete_renovacao':  return fn(nome, params.vencimento);
    case 'reativacao':          return fn(nome, params.diasSemTreinar);
    case 'cobranca_amigavel':   return fn(nome, params.valor);
    case 'pesquisa_satisfacao': return fn(nome);
    default: return typeof fn === 'function' ? fn(nome) : fn;
  }
}

// ── Consulta ────────────────────────────────────────────────────────────────

function getFila(filtros = {}) {
  let lista = [...filaAgendamentos];
  if (filtros.status)  lista = lista.filter(a => a.status === filtros.status);
  if (filtros.leadId)  lista = lista.filter(a => a.leadId === filtros.leadId);
  return lista.sort((a, b) => new Date(a.dataEnvio) - new Date(b.dataEnvio));
}

function getStats() {
  const pendentes  = filaAgendamentos.filter(a => a.status === 'pendente').length;
  const enviados   = filaAgendamentos.filter(a => a.status === 'enviado').length;
  const erros      = filaAgendamentos.filter(a => a.status === 'erro').length;
  const cancelados = filaAgendamentos.filter(a => a.status === 'cancelado').length;
  return { total: filaAgendamentos.length, pendentes, enviados, erros, cancelados };
}

// ── Cron ────────────────────────────────────────────────────────────────────

function iniciarCron() {
  console.log('[CADENCIA] Iniciando motor de cadências (executa a cada minuto)...');
  cron.schedule('* * * * *', processarFila);
}

module.exports = {
  agendarCadencia,
  cancelarCadencia,
  cancelarAgendamento,
  processarFila,
  getFila,
  getStats,
  iniciarCron,
};
