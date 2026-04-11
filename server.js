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

// --- MIDDLEWARES ---
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: 'Rate limit excedido.'
});
app.use('/webhook/telegram', limiter);

// --- FUNÇÕES AUXILIARES (ONBOARDING) ---

async function sendLanguageMenu(chatId) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: "🎉 Bem-vindo ao prose.IA! Qual idioma você quer destravar hoje?",
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

async function answerCallback(callbackId) {
  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackId });
}

// --- PROCESSAMENTO EM BACKGROUND ---

async function processTelegramMessage(message, userData) {
  const chatId = message.chat.id;

  try {
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'record_voice' });

    let userText = '';

    if (message.text) {
      userText = message.text;
    } 
    else if (message.voice) {
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${message.voice.file_id}`);
      const filePath = fileRes.data.result.file_path;
      
      const audioRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`, {
        responseType: 'arraybuffer'
      });
      
      const audioBuffer = Buffer.from(audioRes.data);
      audioBuffer.name = 'audio.ogg'; 

      userText = await AIService.transcribeAudio(audioBuffer);
      console.log(`🎙️ Transcrição (${userData.targetLanguage}): "${userText}"`);
    }

    if (!userText) return;

    // Cérebro: Injetando IDIOMA e NÍVEL do banco de dados
    const aiResponseText = await AIService.getChatResponse(userText, userData.targetLanguage, userData.cefrLevel);

    // Envia texto
    await axios.post(`${TELEGRAM_API}/sendMessage`, { 
      chat_id: chatId, 
      text: aiResponseText,
      parse_mode: 'Markdown'
    });

    // TTS e Envio de Voz (Opcional, se sua conta Groq/OpenAI suportar)
    try {
        const aiAudioBuffer = await AIService.textToSpeech(aiResponseText);
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('voice', aiAudioBuffer, { filename: 'tutor_response.ogg', contentType: 'audio/ogg' });

        await axios.post(`${TELEGRAM_API}/sendVoice`, form, {
            headers: form.getHeaders()
        });
    } catch (ttsErr) {
        console.warn("⚠️ TTS não disponível ou falhou.");
    }

  } catch (error) {
    console.error('❌ Erro no processamento:', error.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, { 
      chat_id: chatId, 
      text: "Ops! Tive um problema técnico. Tente novamente." 
    }).catch(() => {});
  }
}

// --- ROTAS ---

app.post('/webhook/telegram', async (req, res) => {
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (secretToken !== process.env.TELEGRAM_SECRET_TOKEN) return res.status(403).send('Acesso Negado');

  const { message, callback_query } = req.body;

  // A. Tratamento de Cliques nos Botões
  if (callback_query) {
    const chatId = callback_query.message.chat.id;
    const chosenLang = callback_query.data.replace('lang_', '');

    await prisma.user.update({
      where: { id: BigInt(chatId) },
      data: { targetLanguage: chosenLang }
    });

    await answerCallback(callback_query.id);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `Perfeito! Definido para **${chosenLang}**. Vamos começar? Pode falar ou escrever!`,
      parse_mode: 'Markdown'
    });
    return res.sendStatus(200);
  }

  // B. Tratamento de Mensagens
  if (message) {
    const chatId = message.chat.id;

    // MEMÓRIA: Busca ou cria usuário
    let user = await prisma.user.findUnique({ where: { id: BigInt(chatId) } });

    if (!user) {
      user = await prisma.user.create({
        data: { id: BigInt(chatId), name: message.from.first_name || "Estudante" }
      });
      await sendLanguageMenu(chatId);
      return res.sendStatus(200);
    }

    if (message.text === '/start') {
      await sendLanguageMenu(chatId);
      return res.sendStatus(200);
    }

    // Dispara processamento com os dados do usuário vindos do banco
    processTelegramMessage(message, user);
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('🟢 DestravIA Online'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor na porta ${PORT}`));