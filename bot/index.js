import express from 'express';
import twilio from 'twilio';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// ── Clientes ──────────────────────────────────────────────────────────────────
const app       = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai    = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const ALLOWED_PHONES = (process.env.ALLOWED_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);
const USER_ID        = process.env.SUPABASE_USER_ID;

const CAT_DESP = [
  'Saúde e Plano','Serviços Digitais','Alimentação','Supermercados',
  'Educação','Lazer','Casa / Moradia','Telecomunicações','Transporte',
  'Compras / Varejo','Tarifas e IOF','Entretenimento','Parcelamentos',
  'Investimentos','Gorjetas / Doações','Outros',
];
const CAT_REC  = ['Salário / Pró-labore','Participação / Projetos','Dividendos','Rendimento','Aluguel','Outros'];
const FORMAS   = ['Cartão de Crédito','Pix / TED','Débito Automático','Boleto','Dinheiro'];

// ── IA: interpretar mensagem ──────────────────────────────────────────────────
async function interpret(text) {
  const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit' });
  const todayISO = new Date().toLocaleDateString('sv', { timeZone: 'America/Sao_Paulo' });

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 512,
    system: `Você é um assistente financeiro pessoal brasileiro. Interprete mensagens e extraia dados de transações financeiras.
Hoje é ${today} (${todayISO} em ISO).
Categorias de despesa: ${CAT_DESP.join(', ')}.
Categorias de receita: ${CAT_REC.join(', ')}.
Formas de pagamento/recebimento: ${FORMAS.join(', ')}.
Responda SOMENTE com JSON válido, sem markdown.`,
    messages: [{
      role: 'user',
      content: `Mensagem: "${text}"

Retorne um JSON com exatamente este formato:
{
  "tipo": "despesa" ou "receita",
  "descricao": "descrição curta e clara",
  "valor": numero,
  "categoria": "categoria exata da lista",
  "data": "YYYY-MM-DD",
  "forma": "forma exata da lista",
  "nota": "info adicional ou string vazia"
}

Se a mensagem não for uma transação financeira clara, retorne:
{"erro": "explique brevemente o motivo"}`,
    }],
  });

  const raw = response.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('JSON inválido na resposta da IA');
  return JSON.parse(match[0]);
}

// ── Supabase: salvar transação ────────────────────────────────────────────────
async function save(data) {
  if (data.tipo === 'despesa') {
    const { error } = await supabase.from('despesas').insert({
      user_id: USER_ID,
      data: data.data,
      descricao: data.descricao,
      valor: data.valor,
      categoria: data.categoria,
      forma_pagamento: data.forma,
      tipo: 'À Vista',
      nota: data.nota || '',
    });
    if (error) throw new Error('Supabase despesa: ' + error.message);
  } else {
    const { error } = await supabase.from('receitas').insert({
      user_id: USER_ID,
      data: data.data,
      descricao: data.descricao,
      valor: data.valor,
      categoria: data.categoria,
      forma_recebimento: data.forma,
      tipo: 'Outros',
      nota: data.nota || '',
    });
    if (error) throw new Error('Supabase receita: ' + error.message);
  }
}

// ── Áudio: transcrever via Whisper ────────────────────────────────────────────
async function transcribeAudio(mediaUrl) {
  if (!openai) throw new Error('OPENAI_API_KEY não configurada');

  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res  = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error('Erro ao baixar áudio do Twilio');

  const buffer = await res.arrayBuffer();
  const file   = new File([buffer], 'audio.ogg', { type: 'audio/ogg' });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'pt',
  });
  return transcription.text;
}

// ── Formatação da resposta ────────────────────────────────────────────────────
function formatReply(data) {
  const brl   = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const emoji = data.tipo === 'despesa' ? '🔴' : '🟢';
  const tipo  = data.tipo === 'despesa' ? 'Despesa' : 'Receita';
  const [y, m, d] = data.data.split('-');
  return [
    `${emoji} *${tipo} registrada no Financia!*`,
    '',
    `📝 ${data.descricao}`,
    `💰 ${brl(data.valor)}`,
    `📂 ${data.categoria}`,
    `📅 ${d}/${m}/${y}`,
    `💳 ${data.forma}`,
    data.nota ? `📌 ${data.nota}` : '',
  ].filter(l => l !== null).join('\n').trim();
}

// ── Webhook principal ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const from   = req.body.From  || '';
  const body   = (req.body.Body || '').trim();
  const numMedia    = parseInt(req.body.NumMedia || '0');
  const mediaUrl    = req.body.MediaUrl0;
  const mediaType   = req.body.MediaContentType0 || '';

  const phone = from.replace('whatsapp:', '');
  const twiml = new twilio.twiml.MessagingResponse();

  // Bloquear números não autorizados
  if (!ALLOWED_PHONES.includes(phone)) {
    console.warn(`Bloqueado: ${phone}`);
    return res.status(200).send('');
  }

  try {
    let messageText = body;

    // Se for áudio, transcrever primeiro
    if (numMedia > 0 && mediaType.startsWith('audio/')) {
      if (!openai) {
        twiml.message('🎙️ Áudio recebido, mas transcrição não está configurada.\nEnvie uma mensagem de texto, por favor.');
        return res.type('text/xml').send(twiml.toString());
      }
      twiml.message('🎙️ Transcrevendo áudio…');
      // (Twilio não suporta múltiplas mensagens no mesmo TwiML, então transcrevemos e respondemos juntos)
      messageText = await transcribeAudio(mediaUrl);
      console.log(`Áudio transcrito [${phone}]: ${messageText}`);
    }

    if (!messageText) {
      twiml.message('👋 Olá! Me envie uma mensagem descrevendo sua transação.\n\n*Exemplos:*\n• _Gastei 50 reais no almoço hoje_\n• _Paguei 89,90 no Netflix no cartão_\n• _Recebi 3000 de salário_\n• 🎙️ Pode enviar áudio também!');
      return res.type('text/xml').send(twiml.toString());
    }

    const data = await interpret(messageText);

    if (data.erro) {
      twiml.message(
        `❌ Não consegui identificar a transação.\n_${data.erro}_\n\n*Tente assim:*\n• _Gastei R$50 no supermercado hoje_\n• _Recebi 2000 de freelance_`
      );
    } else {
      await save(data);
      twiml.message(formatReply(data));
    }

  } catch (err) {
    console.error('Erro no webhook:', err);
    twiml.message('❌ Ocorreu um erro interno. Tente novamente em instantes.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: 'Financia WhatsApp Bot',
    audio: openai ? 'habilitado (Whisper)' : 'desabilitado (configure OPENAI_API_KEY)',
    phones: ALLOWED_PHONES.length + ' número(s) autorizado(s)',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Financia Bot rodando na porta ${PORT}`);
  console.log(`   Áudio: ${openai ? 'habilitado' : 'desabilitado'}`);
  console.log(`   Números autorizados: ${ALLOWED_PHONES.join(', ') || 'nenhum!'}`);
});
