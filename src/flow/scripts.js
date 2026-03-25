/**
 * SCRIPTS E CADÊNCIAS COMERCIAIS - 24H NORTE
 *
 * Funil: Lead → Contato → Visita → Proposta → Fechamento → Ativo → Fidelização
 */

const UNIDADE = '24H NORTE';

// ─── MENSAGENS ESSENCIAIS ────────────────────────────────────────────────────

const MENSAGENS = {

  // 1. CONFIRMAÇÃO DE VISITA / AGENDAMENTO
  confirmacao_visita: (nome, data, hora) =>
    `Olá, *${nome}*! 👋\n\n` +
    `Sua visita à *${UNIDADE}* está confirmada!\n\n` +
    `📅 *Data:* ${data}\n` +
    `🕐 *Horário:* ${hora}\n\n` +
    `Te esperamos para conhecer nossa estrutura e tirar todas as suas dúvidas.\n\n` +
    `Qualquer dúvida, é só chamar! 💪`,

  // 2. LEMBRETE (1 dia antes)
  lembrete_visita: (nome, hora) =>
    `Oi, *${nome}*! 😊\n\n` +
    `Lembrando que *amanhã* você tem uma visita agendada na *${UNIDADE}*!\n\n` +
    `🕐 *Horário:* ${hora}\n\n` +
    `Te esperamos para apresentar tudo o que temos pra você. Até amanhã! 💪`,

  // 3. LEMBRETE NO DIA
  lembrete_dia: (nome, hora) =>
    `Bom dia, *${nome}*! ☀️\n\n` +
    `Hoje é o dia da sua visita à *${UNIDADE}*!\n\n` +
    `🕐 *Horário:* ${hora}\n\n` +
    `Qualquer dúvida ou imprevisto, nos avise. Te esperamos! 💪`,

  // 4. REAGENDAMENTO
  reagendamento: (nome) =>
    `Oi, *${nome}*! Tudo bem?\n\n` +
    `Percebemos que você não pôde comparecer à sua visita na *${UNIDADE}*.\n\n` +
    `Sem problemas! Queremos muito te apresentar nossa academia. 😊\n\n` +
    `👉 *Quando seria um bom horário para remarcar?*\n\n` +
    `Temos horários disponíveis de *6h às 22h*, de segunda a sábado, e *8h às 14h* aos domingos.`,

  // 5. PÓS-ATENDIMENTO (após visita sem fechamento)
  pos_atendimento: (nome) =>
    `Oi, *${nome}*! 😊\n\n` +
    `Foi muito bom receber você hoje na *${UNIDADE}*!\n\n` +
    `Ficou com alguma dúvida sobre os planos ou a estrutura? Estou aqui para ajudar.\n\n` +
    `💪 Vamos juntos nessa jornada fitness?`,

  // 6. FOLLOW-UP D+1 (após visita)
  follow_up_d1: (nome, plano) =>
    `Oi, *${nome}*! Tudo certo?\n\n` +
    `Lembrei de você e do interesse no *${plano || 'nosso plano'}*. 🏋️\n\n` +
    `Posso te ajudar com mais alguma informação para facilitar sua decisão?\n\n` +
    `Estamos com condições especiais esta semana! 🎯`,

  // 7. FOLLOW-UP D+3
  follow_up_d3: (nome) =>
    `Oi, *${nome}*! Como você está?\n\n` +
    `Ainda pensando em começar seus treinos na *${UNIDADE}*? 💪\n\n` +
    `Posso te apresentar uma condição exclusiva e tirar qualquer dúvida que tenha ficado.\n\n` +
    `É só responder aqui! 😊`,

  // 8. FOLLOW-UP D+7 (última tentativa)
  follow_up_d7: (nome) =>
    `Oi, *${nome}*! 👋\n\n` +
    `Não quero ser inconveniente, mas quero te contar sobre nossa *oferta especial* de esta semana.\n\n` +
    `🎯 Condições imperdíveis para quem deseja começar a treinar!\n\n` +
    `Se quiser saber mais, é só responder. Se preferir não receber mais mensagens, me fala também. 😊`,

  // 9. BOAS-VINDAS (após contrato assinado)
  boas_vindas: (nome, plano) =>
    `*Bem-vindo(a) à família ${UNIDADE}!* 🎉🏋️\n\n` +
    `Olá, *${nome}*! Estamos muito felizes em te ter conosco!\n\n` +
    `✅ *Plano:* ${plano}\n` +
    `🏆 Estamos prontos para te ajudar a alcançar seus objetivos!\n\n` +
    `Qualquer dúvida sobre horários, equipamentos ou treinos, pode chamar. 💪\n\n` +
    `*Bora treinar!* 🚀`,

  // 10. LEMBRETE DE RENOVAÇÃO (30 dias antes)
  lembrete_renovacao: (nome, vencimento) =>
    `Oi, *${nome}*! 😊\n\n` +
    `Seu plano na *${UNIDADE}* vence em *${vencimento}*.\n\n` +
    `Renove agora e mantenha seu ritmo sem interrupção! 💪\n\n` +
    `Tenho condições especiais para quem renova antecipado. Posso te apresentar?`,

  // 11. REATIVAÇÃO (aluno que cancelou ou ficou inativo)
  reativacao: (nome, diasSemTreinar) =>
    `Oi, *${nome}*! Sentimos sua falta! 😢\n\n` +
    (diasSemTreinar ? `Faz *${diasSemTreinar} dias* que você não passa por aqui.\n\n` : '') +
    `Queremos te ver de volta na *${UNIDADE}*! 🏋️\n\n` +
    `Temos uma *oferta especial de reativação* para você. Posso te contar mais?`,

  // 12. COBRANÇA AMIGÁVEL (inadimplência)
  cobranca_amigavel: (nome, valor) =>
    `Oi, *${nome}*! Tudo bem?\n\n` +
    `Identificamos uma pendência de *R$ ${valor}* em seu cadastro na *${UNIDADE}*.\n\n` +
    `Para evitar a suspensão do acesso, pode regularizar por aqui?\n\n` +
    `Qualquer dúvida, estou à disposição. 😊`,

  // 13. PESQUISA DE SATISFAÇÃO (pós-treino do mês)
  pesquisa_satisfacao: (nome) =>
    `Oi, *${nome}*! 👋\n\n` +
    `Como tem sido sua experiência na *${UNIDADE}*?\n\n` +
    `De *1 a 5*, como você avaliaria:\n` +
    `1️⃣ Péssimo  2️⃣ Ruim  3️⃣ Regular  4️⃣ Bom  5️⃣ Excelente\n\n` +
    `Seu feedback é muito importante para melhorarmos! 🙏`,
};

// ─── SCRIPTS DE ATENDIMENTO (consultor) ─────────────────────────────────────

const SCRIPTS = {

  // Primeiro contato com lead (telefone/WhatsApp)
  primeiro_contato: `
🎯 SCRIPT - PRIMEIRO CONTATO

"Olá, [NOME]! Aqui é [SEU NOME] da academia 24H Norte.
Vi que você demonstrou interesse em começar a treinar. Posso tirar 2 minutinhos do seu tempo?"

SE SIM:
→ "Que ótimo! Me conta, o que você busca com a academia?
   (Emagrecimento / Hipertrofia / Saúde / Bem-estar)"

→ Identificar DISPONIBILIDADE: "Você prefere treinar de manhã, tarde ou noite?"

→ Propor visita: "Que tal você vir conhecer nossa estrutura?
   Tenho horários disponíveis [DIA] às [HORA] ou [DIA] às [HORA]."

SE NÃO / OCUPADO:
→ "Entendo! Posso te enviar uma mensagem pelo WhatsApp para marcarmos um melhor horário?"
  `,

  // Apresentação na visita
  visita_presencial: `
🎯 SCRIPT - VISITA PRESENCIAL

1. RECEPÇÃO (1 min)
   "Olá, [NOME]! Seja bem-vindo(a) à 24H Norte! Sou [SEU NOME]."
   → Oferecer água / fazer sentir confortável

2. DESCOBERTA (5 min)
   "Me conta um pouco sobre você... O que te trouxe aqui hoje?"
   "Você já treinou antes? Qual foi sua experiência?"
   "Qual é o seu principal objetivo agora?"

3. TOUR GUIADO (10 min)
   → Mostrar equipamentos relevantes ao objetivo do cliente
   → Destacar diferenciais: 24h, instrutores, limpeza, energia
   → "Aqui é onde você vai [atingir seu objetivo]..."

4. PROPOSTA (10 min)
   → Apresentar 2-3 opções de plano (não mais que 3)
   → Começar pelo plano que melhor atende o perfil
   → "Para o seu objetivo de [X], eu recomendo este plano..."

5. FECHAMENTO
   "O que você achou? Tem alguma dúvida antes de a gente fechar?"
   → Tratar objeções
   → Propor início imediato: "Podemos já fechar hoje e você começa amanhã!"
  `,

  // Tratamento de objeções
  objecoes: `
🎯 SCRIPT - OBJEÇÕES COMUNS

💬 "Está caro"
→ "Entendo! Mas vamos fazer uma conta rápida: dividindo por dia, é menos de R$ X.
   Quanto vale para você ter saúde e disposição todos os dias?"

💬 "Vou pensar"
→ "Claro! O que você precisa pensar? Posso ajudar com alguma informação?"
→ "Tem algo específico que está impedindo você de decidir agora?"

💬 "Não tenho tempo"
→ "Por isso mesmo a 24H Norte é perfeita! Abrimos [HORÁRIO].
   Você consegue incluir 45 minutos no seu dia — de manhã cedo, na hora do almoço ou à noite."

💬 "Vou esperar a academia mais perto abrir"
→ "Entendo! Mas enquanto isso, você perde tempo e resultados.
   A [DISTÂNCIA] é realmente um obstáculo para você?"

💬 "Posso cancelar quando quiser?"
→ "Sim! Nosso contrato é flexível. Mas tenho certeza que quando você ver os resultados,
   não vai querer sair. 😊"
  `,
};

// ─── CADÊNCIAS DE FOLLOW-UP ──────────────────────────────────────────────────

const CADENCIAS = {

  // Lead novo (nunca visitou)
  lead_novo: [
    { dia: 0, tipo: 'whatsapp', mensagem: 'primeiro_contato_wpp', descricao: 'Primeiro contato' },
    { dia: 1, tipo: 'whatsapp', mensagem: 'follow_up_d1', descricao: 'Follow-up D+1' },
    { dia: 3, tipo: 'whatsapp', mensagem: 'follow_up_d3', descricao: 'Follow-up D+3' },
    { dia: 7, tipo: 'whatsapp', mensagem: 'follow_up_d7', descricao: 'Follow-up D+7 (último)' },
  ],

  // Visitou mas não fechou
  visita_sem_fechamento: [
    { dia: 0, tipo: 'whatsapp', mensagem: 'pos_atendimento', descricao: 'Pós-atendimento (mesmo dia)' },
    { dia: 1, tipo: 'whatsapp', mensagem: 'follow_up_d1', descricao: 'Follow-up D+1' },
    { dia: 3, tipo: 'whatsapp', mensagem: 'follow_up_d3', descricao: 'Follow-up D+3' },
    { dia: 7, tipo: 'whatsapp', mensagem: 'follow_up_d7', descricao: 'Follow-up D+7 (último)' },
  ],

  // Agendamento marcado
  agendamento: [
    { dia: 0, tipo: 'whatsapp', mensagem: 'confirmacao_visita', descricao: 'Confirmação imediata' },
    { dia: -1, tipo: 'whatsapp', mensagem: 'lembrete_visita', descricao: 'Lembrete D-1' },
    { dia: 0, tipo: 'whatsapp', mensagem: 'lembrete_dia', descricao: 'Lembrete no dia (manhã)' },
  ],

  // Renovação próxima
  renovacao: [
    { dia: -30, tipo: 'whatsapp', mensagem: 'lembrete_renovacao', descricao: 'Aviso 30 dias antes' },
    { dia: -15, tipo: 'whatsapp', mensagem: 'lembrete_renovacao', descricao: 'Aviso 15 dias antes' },
    { dia: -7, tipo: 'whatsapp', mensagem: 'lembrete_renovacao', descricao: 'Aviso 7 dias antes' },
    { dia: -2, tipo: 'whatsapp', mensagem: 'lembrete_renovacao', descricao: 'Aviso 2 dias antes' },
  ],

  // Reativação (inativo)
  reativacao: [
    { dia: 0, tipo: 'whatsapp', mensagem: 'reativacao', descricao: 'Primeiro contato reativação' },
    { dia: 7, tipo: 'whatsapp', mensagem: 'reativacao', descricao: 'Segunda tentativa' },
    { dia: 21, tipo: 'whatsapp', mensagem: 'reativacao', descricao: 'Terceira tentativa' },
  ],
};

// ─── FUNIL DE VENDAS ─────────────────────────────────────────────────────────

const FUNIL_ETAPAS = [
  { id: 'lead',      nome: 'Lead',           cor: '#6c757d', ordem: 1 },
  { id: 'contato',   nome: 'Contato Feito',  cor: '#17a2b8', ordem: 2 },
  { id: 'visita',    nome: 'Visita Agend.',  cor: '#ffc107', ordem: 3 },
  { id: 'proposta',  nome: 'Proposta Feita', cor: '#fd7e14', ordem: 4 },
  { id: 'fechado',   nome: 'Fechado',        cor: '#28a745', ordem: 5 },
  { id: 'perdido',   nome: 'Perdido',        cor: '#dc3545', ordem: 6 },
];

// Gerar mensagem baseada no template
function gerarMensagem(tipo, params = {}) {
  const template = MENSAGENS[tipo];
  if (!template) throw new Error(`Template "${tipo}" não encontrado`);
  if (typeof template === 'function') return template(...Object.values(params));
  return template;
}

module.exports = {
  MENSAGENS,
  SCRIPTS,
  CADENCIAS,
  FUNIL_ETAPAS,
  gerarMensagem,
};
