import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';
import { AIService } from './services/aiService.js';

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Configurações de proxy e segurança
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Rate limiting para o webhook
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 150 });
app.use('/webhook/telegram', limiter);

// ==========================================
// FUNÇÕES AUXILIARES DE INTERFACE
// ==========================================

async function sendMenu(chatId, type) {
  let text = '';
  let keyboard = [];

  if (type === 'lang') {
    text = "🌍 **Configuração de Idioma**\nEscolha qual idioma deseja praticar:";
    keyboard = [
      [{ text: "🇺🇸 Inglês", callback_data: "lang_english" }, { text: "🇪🇸 Espanhol", callback_data: "lang_spanish" }],
      [{ text: "🇫🇷 Francês", callback_data: "lang_french" }]
    ];
  } else if (type === 'rp') {
    text = "🎭 **Cenários de Roleplay**\nEscolha uma situação real para treinar:";
    keyboard = [
      [{ text: "✈️ Imigração", callback_data: "rp_airport" }, { text: "☕ Café", callback_data: "rp_cafe" }],
      [{ text: "💼 Entrevista", callback_data: "rp_job" }, { text: "🏫 Escola", callback_data: "rp_school" }],
      [{ text: "🎓 Universidade", callback_data: "rp_university" }, { text: "🎬 Cinema", callback_data: "rp_cinema" }],
      [{ text: "🌳 Parque", callback_data: "rp_park" }, { text: "🏨 Viagem/Hotel", callback_data: "rp_travel" }],
      [{ text: "⛪ Igreja/Comunidade", callback_data: "rp_church" }, { text: "👔 Reunião Empresa", callback_data: "rp_meeting" }]
    ];
  }

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendTypingIndicator(chatId, isVoice) {
  await axios.post(`${TELEGRAM_API}/sendChatAction`, {
    chat_id: chatId,
    action: isVoice ? 'record_voice' : 'typing'
  }).catch(() => {});
}

// ==========================================
// PIPELINE PRINCIPAL DE PROCESSAMENTO
// ==========================================

async function processInteraction(message, userData, scenarioKey = null) {
  const chatId = message.chat.id;
  const isVoice = !!message.voice;

  try {
    await sendTypingIndicator(chatId, isVoice);

    // 1. Obter texto do usuário
    let userText = message.text || '';
    if (isVoice) {
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${message.voice.file_id}`);
      const audioUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;
      const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
      userText = await AIService.transcribeAudio(Buffer.from(audioRes.data));
    }
    if (!userText) return;

    // 2. Salvar interação no histórico
    await prisma.interaction.create({
      data: {
        userId: BigInt(chatId),
        userMessage: userText,
        botResponse: {},
        score: 0
      }
    });

    // 3. Processar com IA (usando roleplay ativo se existir)
    const activeScenario = scenarioKey || userData.activeRoleplay;
    const result = await AIService.processPedagogy(
      userText,
      userData.targetLanguage,
      userData.cefrLevel,
      activeScenario
    );

    // 4. Atualizar interação com resposta completa
    await prisma.interaction.updateMany({
      where: { userId: BigInt(chatId), userMessage: userText },
      data: {
        botResponse: result,
        score: result.evaluation.score
      }
    });

    // 5. Enviar relatório visual com botões de ação
    const scoreEmoji = result.evaluation.score >= 80 ? "🔥" : result.evaluation.score >= 50 ? "👍" : "💪";
    let report = `🗣️ *Resposta:*\n${result.spoken_response}\n\n`;
    report += `📈 *Fluência:* ${result.evaluation.score}/100 ${scoreEmoji}\n`;
    report += `✨ *Análise:* ${result.evaluation.praise}\n`;
    report += `💡 *Dica:* _${result.deep_correction}_`;

    const keyboard = {
      inline_keyboard: [
        [{ text: "🔁 Tentar de novo", callback_data: "retry_last" }],
        [{ text: "🎭 Novo Roleplay", callback_data: "menu_rp" }, { text: "🌍 Mudar Idioma", callback_data: "menu_lang" }]
      ]
    };

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: report,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });

    // 6. Gerar e enviar áudio bilíngue (se a entrada foi por voz)
    if (isVoice) {
      const voiceBuffer = await AIService.generateBilingualVoice(
        result.spoken_response,
        userData.targetLanguage,
        result.deep_correction
      );
      if (voiceBuffer) {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('audio', voiceBuffer, { filename: 'prose_ia.mp3', contentType: 'audio/mpeg' });
        await axios.post(`${TELEGRAM_API}/sendAudio`, form, { headers: form.getHeaders() });
      }
    }
  } catch (err) {
    console.error("Erro no processamento:", err);
    // Notificar usuário sobre erro
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "❌ Ops! Tive um problema técnico. Tente novamente em instantes."
    }).catch(() => {});
  }
}

// ==========================================
// ROTA DO WEBHOOK (NÃO BLOQUEANTE)
// ==========================================

app.post('/webhook/telegram', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_SECRET_TOKEN) {
    return res.status(403).send('Negado');
  }

  const { message, callback_query } = req.body;

  // Responder imediatamente ao Telegram (evita timeout)
  res.sendStatus(200);

  // Processamento em background
  setImmediate(async () => {
    try {
      if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const data = callback_query.data;
        const userId = BigInt(chatId);

        if (data.startsWith('lang_')) {
          await prisma.user.update({
            where: { id: userId },
            data: { targetLanguage: data.replace('lang_', '') }
          });
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: "✅ Idioma atualizado! Você já pode conversar."
          });
        } else if (data.startsWith('rp_')) {
          await prisma.user.update({
            where: { id: userId },
            data: { activeRoleplay: data }
          });
          const user = await prisma.user.findUnique({ where: { id: userId } });
          await processInteraction(
            { chat: { id: chatId }, text: '[Início do Roleplay]' },
            user,
            data
          );
        } else if (data === 'menu_rp') {
          await sendMenu(chatId, 'rp');
        } else if (data === 'menu_lang') {
          await sendMenu(chatId, 'lang');
        } else if (data === 'retry_last') {
          // Reenvia a última mensagem do usuário (opcional)
          const lastInteraction = await prisma.interaction.findFirst({
            where: { userId },
            orderBy: { createdAt: 'desc' }
          });
          if (lastInteraction) {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            await processInteraction(
              { chat: { id: chatId }, text: lastInteraction.userMessage },
              user
            );
          }
        }

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callback_query.id
        }).catch(() => {});
      }

      if (message) {
        const chatId = message.chat.id;
        const userId = BigInt(chatId);

        // Buscar ou criar usuário
        let user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
          user = await prisma.user.create({
            data: {
              id: userId,
              name: message.from?.first_name || 'Estudante'
            }
          });
          await sendMenu(chatId, 'lang');
          return;
        }

        // Comandos especiais
        if (message.text === '/start' || message.text === '/idioma') {
          await sendMenu(chatId, 'lang');
          return;
        }
        if (message.text === '/roleplay') {
          await sendMenu(chatId, 'rp');
          return;
        }
        if (message.text === '/sair') {
          await prisma.user.update({
            where: { id: userId },
            data: { activeRoleplay: null }
          });
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: "🚪 Você saiu do roleplay. Use /roleplay para começar outro!"
          });
          return;
        }

        // Processar interação normal
        await processInteraction(message, user);
      }
    } catch (err) {
      console.error("Erro no processamento em background:", err);
    }
  });
});

// ==========================================
// ENDPOINTS DE SAÚDE E KEEP-ALIVE
// ==========================================

app.get('/', (req, res) => res.send('🟢 prose.IA Online'));
app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});