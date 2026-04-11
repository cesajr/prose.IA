import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';
import { AIService } from './services/aiService.js'; // Ajuste este caminho de acordo com a sua estrutura!

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const levelQuestions = {
  1: "Como você se apresenta? (Diga seu nome e de onde é)",
  2: "O que você gosta de fazer no seu tempo livre?",
  3: "Conte-me sobre uma viagem interessante que você fez.",
  4: "Qual sua opinião sobre o uso de tecnologia na educação?",
  5: "Descreva uma situação hipotética: Se você pudesse mudar algo no mundo, o que seria e por quê?"
};

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 150 });
app.use('/webhook/telegram', limiter);

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
    chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
  }).catch(console.error);
}

async function sendTyping(chatId, isVoice) {
  await axios.post(`${TELEGRAM_API}/sendChatAction`, {
    chat_id: chatId, action: isVoice ? 'record_voice' : 'typing'
  }).catch(() => {});
}

async function handleLevelTest(message, user) {
  const chatId = message.chat.id;
  const step = user.levelTestStep;
  const isVoice = !!message.voice;

  let userText = message.text || '';
  if (isVoice) {
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${message.voice.file_id}`);
    const audioUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;
    const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    userText = await AIService.transcribeAudio(Buffer.from(audioRes.data));
  }
  
  if (!userText) {
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "Não entendi. Pode repetir?" });
    return;
  }

  const evaluation = await AIService.evaluateLevel(userText, user.targetLanguage, step);
  const newScore = user.levelTestScore + evaluation.score;

  let reply = '';
  let testFinished = false;
  let finalLevel = user.cefrLevel;

  if (step === 5 || evaluation.nextQuestion === "FIM") {
    testFinished = true;
    finalLevel = evaluation.level;
    reply = `✅ *Teste concluído!*\n\nSeu nível estimado é: *${finalLevel}*\nPontuação total: ${newScore}/100\n\nA partir de agora, eu serei mais exigente com base no seu nível.`;
    await prisma.user.update({
      where: { id: user.id },
      data: { cefrLevel: finalLevel, levelTestStep: 0, levelTestScore: 0 }
    });
  } else {
    const nextStep = step + 1;
    reply = `📝 *Pergunta ${nextStep}/5*\n\n${levelQuestions[nextStep]}\n\n(Score parcial: ${newScore})`;
    await prisma.user.update({
      where: { id: user.id },
      data: { levelTestStep: nextStep, levelTestScore: newScore }
    });
  }

  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: reply, parse_mode: 'Markdown' });
  if (testFinished) await sendMenu(chatId, 'lang');
}

async function processInteraction(message, userData, scenarioKey = null) {
  const chatId = message.chat.id;
  const isVoice = !!message.voice;

  if (userData.levelTestStep > 0 && userData.levelTestStep <= 5) {
    return handleLevelTest(message, userData);
  }

  try {
    await sendTyping(chatId, isVoice);

    let userText = message.text || '';
    if (isVoice) {
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${message.voice.file_id}`);
      const audioUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;
      const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
      userText = await AIService.transcribeAudio(Buffer.from(audioRes.data));
    }
    
    if (!userText) return;

    await prisma.interaction.create({
      data: { userId: BigInt(chatId), userMessage: userText, botResponse: {}, score: 0 }
    });

    const activeScenario = scenarioKey || userData.activeRoleplay;
    const result = await AIService.processPedagogy(userText, userData.targetLanguage, userData.cefrLevel, activeScenario);

    await prisma.interaction.updateMany({
      where: { userId: BigInt(chatId), userMessage: userText },
      data: { botResponse: result, score: result.evaluation.score }
    });

    const scoreEmoji = result.evaluation.score >= 80 ? "🔥" : result.evaluation.score >= 50 ? "👍" : "💪";
    let report = `🗣️ *Conversa:*\n${result.spoken_response}\n\n`;
    report += `📈 *Fluência & Precisão:* ${result.evaluation.score}/100 ${scoreEmoji}\n`;
    report += `✨ *Nota:* ${result.evaluation.praise}\n`;
    report += `💡 *Correção da Profª:* _${result.deep_correction}_`;

    const keyboard = {
      inline_keyboard: [
        [{ text: "🔊 Ouvir novamente", callback_data: "play_audio" }, { text: "🔁 Tentar falar melhor", callback_data: "retry_last" }],
        [{ text: "🎭 Trocar Cenário", callback_data: "menu_rp" }]
      ]
    };

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId, text: report, parse_mode: 'Markdown', reply_markup: keyboard
    });

    if (isVoice) {
      let voiceBuffer = await AIService.generateBilingualVoice(result.spoken_response, userData.targetLanguage, result.deep_correction);
      
      if (!voiceBuffer || voiceBuffer.length === 0) {
        voiceBuffer = await AIService.generateBilingualVoice(result.spoken_response, userData.targetLanguage, '');
      }
      
      if (voiceBuffer && voiceBuffer.length > 0) {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('audio', voiceBuffer, { filename: 'prose_ia.mp3', contentType: 'audio/mpeg' });
        await axios.post(`${TELEGRAM_API}/sendAudio`, form, { headers: form.getHeaders() });
      }
    }
  } catch (err) {
    console.error("❌ Erro no processamento:", err);
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "❌ Ops! Tive um problema técnico. Tente novamente." }).catch(() => {});
  }
}

app.post('/webhook/telegram', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_SECRET_TOKEN) return res.status(403).send('Negado');

  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const { message, callback_query } = req.body;

      if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const data = callback_query.data;
        const userId = BigInt(chatId);
        const user = await prisma.user.findUnique({ where: { id: userId } });

        if (data.startsWith('lang_')) {
          const langCode = data.replace('lang_', '');
          await prisma.user.update({ where: { id: userId }, data: { targetLanguage: langCode } });
          await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `✅ Idioma ajustado! Vamos focar na pronúncia e gramática.`, parse_mode: 'Markdown' });
        } else if (data.startsWith('rp_')) {
          await prisma.user.update({ where: { id: userId }, data: { activeRoleplay: data } });
          await processInteraction({ chat: { id: chatId }, text: '[Início do Roleplay]' }, user, data);
        } else if (data === 'menu_rp') {
          await sendMenu(chatId, 'rp');
        } else if (data === 'menu_lang') {
          await sendMenu(chatId, 'lang');
        } else if (data === 'retry_last') {
          const last = await prisma.interaction.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
          if (last) await processInteraction({ chat: { id: chatId }, text: last.userMessage }, user);
        } else if (data === 'play_audio') {
          const last = await prisma.interaction.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
          if (last && last.botResponse) {
            const resp = last.botResponse;
            let voiceBuffer = await AIService.generateBilingualVoice(resp.spoken_response, user.targetLanguage, resp.deep_correction);
            if (voiceBuffer) {
              const form = new FormData();
              form.append('chat_id', chatId);
              form.append('audio', voiceBuffer, { filename: 'prose_ia.mp3', contentType: 'audio/mpeg' });
              await axios.post(`${TELEGRAM_API}/sendAudio`, form, { headers: form.getHeaders() });
            }
          }
        }
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback_query.id }).catch(() => {});
      }

      if (message) {
        const chatId = message.chat.id;
        const userId = BigInt(chatId);

        let user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
          user = await prisma.user.create({ data: { id: userId, name: message.from?.first_name || 'Estudante' } });
          await sendMenu(chatId, 'lang');
          return;
        }

        if (message.text === '/start' || message.text === '/idioma') return sendMenu(chatId, 'lang');
        if (message.text === '/roleplay') return sendMenu(chatId, 'rp');
        if (message.text === '/nivel') {
          await prisma.user.update({ where: { id: userId }, data: { levelTestStep: 1, levelTestScore: 0 } });
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId, text: `📝 *Teste de Nivelamento - Pergunta 1/5*\n\n${levelQuestions[1]}`, parse_mode: 'Markdown'
          });
          return;
        }
        if (message.text === '/sair') {
          await prisma.user.update({ where: { id: userId }, data: { activeRoleplay: null } });
          return axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "🚪 Modo conversa livre ativado." });
        }

        await processInteraction(message, user);
      }
    } catch (err) {
      console.error("❌ Erro geral:", err);
    }
  });
});

app.get('/', (req, res) => res.send('🟢 prose.IA Online'));
app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));