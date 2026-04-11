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
// FUNÇÕES AUXILIARES
// ==========================================
async function sendLanguageMenu(chatId) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: "🎉 Bem-vindo ao **prose.IA**! Qual idioma você quer destravar hoje?",
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🇺🇸 Inglês", callback_data: "lang_english" },
          { text: "🇪🇸 Espanhol", callback_data: "lang_spanish" },
          { text: "🇫🇷 Francês", callback_data: "lang_french" }
        ]
      ]
    }
  });
}

async function sendRoleplayMenu(chatId) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: "🎭 **Modo Roleplay Ativado!** Escolha sua missão situacional:",
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "✈️ Imigração no Aeroporto", callback_data: "rp_airport" }],
        [{ text: "☕ Pedindo no Café", callback_data: "rp_cafe" }],
        [{ text: "💼 Entrevista de Emprego", callback_data: "rp_job" }]
      ]
    }
  });
}

// ==========================================
// ORQUESTRADOR ASSÍNCRONO (CÉREBRO UX)
// ==========================================
async function processTelegramMessage(message, userData, isRoleplay = false) {
  const chatId = message.chat.id;

  try {
    let userText = '';
    const isVoiceMessage = !!message.voice;

    // Mostra "Digitando..." ou "Gravando Áudio..." dependendo de como o usuário falou
    const action = isVoiceMessage ? 'record_voice' : 'typing';
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action });

    // Extrai o texto (via teclado ou Whisper)
    if (message.text) {
      userText = message.text;
    } else if (isVoiceMessage) {
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${message.voice.file_id}`);
      const filePath = fileRes.data.result.file_path;
      const audioRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`, { responseType: 'arraybuffer' });
      
      const audioBuffer = Buffer.from(audioRes.data);
      audioBuffer.name = 'audio.ogg'; 

      userText = await AIService.transcribeAudio(audioBuffer);
      console.log(`🎙️ Aluno disse: "${userText}"`);
    }

    if (!userText) return;

    // 1. Processamento via Llama 3.3 (Retorna o JSON { correction, spoken_response })
    const aiResponse = await AIService.getChatResponse(userText, userData.targetLanguage, userData.cefrLevel, isRoleplay);

    // 2. UX FLUIDA: Envio da Correção Pedagógica (Somente Texto)
    if (aiResponse.correction && aiResponse.correction.trim() !== "") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, { 
        chat_id: chatId, 
        text: `💡 *Feedback:* ${aiResponse.correction}`,
        parse_mode: 'Markdown'
      });
    }

    // 3. UX FLUIDA: Envio da Conversa
    if (isVoiceMessage && aiResponse.spoken_response) {
      // Se o aluno mandou áudio, respondemos COM ÁUDIO
      try {
        const aiAudioBuffer = await AIService.textToSpeech(aiResponse.spoken_response, userData.targetLanguage);
        if (aiAudioBuffer) {
          const form = new FormData();
          form.append('chat_id', chatId);
          form.append('audio', aiAudioBuffer, { filename: 'prose_ia.mp3', contentType: 'audio/mpeg' });
          
          await axios.post(`${TELEGRAM_API}/sendAudio`, form, { headers: form.getHeaders() });
        }
      } catch (ttsErr) {
        console.warn("⚠️ Falha no TTS, enviando texto como fallback.");
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: aiResponse.spoken_response });
      }
    } else if (aiResponse.spoken_response) {
      // Se o aluno mandou texto, respondemos COM TEXTO
      await axios.post(`${TELEGRAM_API}/sendMessage`, { 
        chat_id: chatId, 
        text: aiResponse.spoken_response 
      });
    }

  } catch (error) {
    console.error('❌ Erro no fluxo de conversa:', error);
  }
}

// ==========================================
// ROTA DO WEBHOOK
// ==========================================
app.post('/webhook/telegram', async (req, res) => {
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (secretToken !== process.env.TELEGRAM_SECRET_TOKEN) return res.status(403).send('Acesso Negado');

  const { message, callback_query } = req.body;

  // A. Tratamento de Botões (Callbacks)
  if (callback_query) {
    const chatId = callback_query.message.chat.id;
    const data = callback_query.data;

    // Botões de Idioma
    if (data.startsWith('lang_')) {
      const chosenLang = data.replace('lang_', '');
      await prisma.user.update({ where: { id: BigInt(chatId) }, data: { targetLanguage: chosenLang } });
      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `Perfeito! Idioma atualizado para **${chosenLang}**.` });
    } 
    // Botões de Roleplay
    else if (data.startsWith('rp_')) {
      let user = await prisma.user.findUnique({ where: { id: BigInt(chatId) } });
      const promptInit = `[O aluno iniciou o cenário de roleplay: ${data}. Inicie a simulação dando as boas-vindas no contexto do cenário.]`;
      // Dispara o cérebro dizendo que é roleplay
      processTelegramMessage({ chat: { id: chatId }, text: promptInit }, user, true);
    }
    
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback_query.id });
    return res.sendStatus(200);
  }

  // B. Tratamento de Mensagens
  if (message) {
    const chatId = message.chat.id;
    let user = await prisma.user.findUnique({ where: { id: BigInt(chatId) } });

    if (!user) {
      user = await prisma.user.create({ data: { id: BigInt(chatId), name: message.from.first_name || "Estudante" } });
      await sendLanguageMenu(chatId);
      return res.sendStatus(200);
    }

    // Comandos de Menu
    if (message.text === '/start' || message.text === '/idioma') {
      await sendLanguageMenu(chatId);
      return res.sendStatus(200);
    }
    if (message.text === '/roleplay') {
      await sendRoleplayMenu(chatId);
      return res.sendStatus(200);
    }

    // Conversa Normal
    processTelegramMessage(message, user, false);
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('🟢 prose.IA Online'));
app.listen(process.env.PORT || 3000, () => console.log('🚀 prose.IA na porta 3000'));