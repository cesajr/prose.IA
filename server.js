import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';
import { AIService } from './aiService.js'; 
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 150 });
app.use('/webhook/telegram', limiter);

// ==========================================
// FUNÇÕES DE UX NO TELEGRAM
// ==========================================
async function sendMenu(chatId, type) {
  let text = "";
  let keyboard = [];

  if (type === 'lang') {
    text = "🎉 Bem-vindo ao **prose.IA**! Qual idioma você quer destravar hoje?";
    keyboard = [
      [{ text: "🇺🇸 Inglês", callback_data: "lang_english" }, { text: "🇪🇸 Espanhol", callback_data: "lang_spanish" }],
      [{ text: "🇫🇷 Francês", callback_data: "lang_french" }]
    ];
  } else if (type === 'rp') {
    text = "🎭 **Modo Roleplay Ativado!** Escolha sua missão:";
    keyboard = [
      [{ text: "✈️ Imigração no Aeroporto", callback_data: "rp_airport" }],
      [{ text: "☕ Pedindo no Café", callback_data: "rp_cafe" }]
    ];
  }

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
  });
}

// ==========================================
// A LINHA DE MONTAGEM (PIPELINE)
// ==========================================
async function processTelegramMessage(message, userData, isRoleplay = false) {
  const chatId = message.chat.id;

  try {
    const isVoice = !!message.voice;
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: isVoice ? 'record_voice' : 'typing' });

    // ETAPA 1: CAPTAR E TRANSCREVER
    let userText = message.text || '';
    if (isVoice) {
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${message.voice.file_id}`);
      const audioRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`, { responseType: 'arraybuffer' });
      const audioBuffer = Buffer.from(audioRes.data);
      audioBuffer.name = 'audio.ogg'; 
      userText = await AIService.transcribeAudio(audioBuffer);
      console.log(`🎙️ Aluno disse: "${userText}"`);
    }
    if (!userText) return;

    // ETAPA 2: ANALISAR, CORRIGIR E SUGERIR
    const pedagogy = await AIService.processPedagogy(userText, userData.targetLanguage, userData.cefrLevel, isRoleplay);

    // ETAPA 3: RELATÓRIO VISUAL DE AVALIAÇÃO (Apenas em Texto)
    let visualReport = `🗣️ *Eu disse:*\n${pedagogy.spoken_response}\n\n`;
    visualReport += `📊 *Análise:* ${pedagogy.analysis}\n`;
    visualReport += `💡 *Correção:* _${pedagogy.correction}_\n`;
    visualReport += `🎯 *Dica:* ${pedagogy.suggestion}`;

    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: visualReport, parse_mode: 'Markdown' });

    // ETAPA 4: GERAR E ENVIAR ÁUDIO BILÍNGUE
    if (isVoice && pedagogy.spoken_response) {
      try {
        // Gera a resposta nativa + a correção em PT-BR
        const finalAudio = await AIService.generateBilingualVoice(pedagogy.spoken_response, userData.targetLanguage, pedagogy.correction);
        
        if (finalAudio) {
          const form = new FormData();
          form.append('chat_id', chatId);
          form.append('audio', finalAudio, { filename: 'prose_ia_tutor.mp3', contentType: 'audio/mpeg' });
          await axios.post(`${TELEGRAM_API}/sendAudio`, form, { headers: form.getHeaders() });
        }
      } catch (e) {
        console.warn("⚠️ Erro na geração de áudio:", e.message);
      }
    }

  } catch (error) {
    console.error('❌ Erro no Pipeline:', error);
  }
}

// ==========================================
// ROTA PRINCIPAL
// ==========================================
app.post('/webhook/telegram', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_SECRET_TOKEN) return res.status(403).send('Negado');

  const { message, callback_query } = req.body;

  if (callback_query) {
    const chatId = callback_query.message.chat.id;
    const data = callback_query.data;

    if (data.startsWith('lang_')) {
      const lang = data.replace('lang_', '');
      await prisma.user.update({ where: { id: BigInt(chatId) }, data: { targetLanguage: lang } });
      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `Idioma atualizado para **${lang}**.` });
    } else if (data.startsWith('rp_')) {
      let user = await prisma.user.findUnique({ where: { id: BigInt(chatId) } });
      processTelegramMessage({ chat: { id: chatId }, text: `[Inicie o roleplay: ${data}]` }, user, true);
    }
    
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback_query.id });
    return res.sendStatus(200);
  }

  if (message) {
    const chatId = message.chat.id;
    let user = await prisma.user.findUnique({ where: { id: BigInt(chatId) } });

    if (!user) {
      user = await prisma.user.create({ data: { id: BigInt(chatId), name: message.from.first_name || "Estudante" } });
      await sendMenu(chatId, 'lang');
      return res.sendStatus(200);
    }

    if (message.text === '/start' || message.text === '/idioma') return await sendMenu(chatId, 'lang'), res.sendStatus(200);
    if (message.text === '/roleplay') return await sendMenu(chatId, 'rp'), res.sendStatus(200);

    processTelegramMessage(message, user, false);
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('🟢 prose.IA Online!'));
app.listen(process.env.PORT || 3000, () => console.log('🚀 prose.IA rodando na porta 3000'));