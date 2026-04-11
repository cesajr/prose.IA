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

// Permite que o limitador confie no túnel do Render
app.set('trust proxy', 1);

// ==========================================
// 1. MIDDLEWARES DE SEGURANÇA E PARSER
// ==========================================
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: 'Rate limit excedido.'
});
app.use('/webhook/telegram', limiter);

// ==========================================
// 2. FUNÇÕES AUXILIARES (ONBOARDING)
// ==========================================
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

// ==========================================
// 3. ORQUESTRADOR ASSÍNCRONO (CÉREBRO)
// ==========================================
async function processTelegramMessage(message, userData) {
  const chatId = message.chat.id;

  try {
    // A. Avisa que o bot está "gravando áudio" no Telegram
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'record_voice' });

    let userText = '';

    // B. Roteamento: É Texto ou Áudio?
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

    // C. Cérebro: Llama 3.3 gera a resposta (Injetando idioma e nível do Supabase)
    const aiResponseText = await AIService.getChatResponse(userText, userData.targetLanguage, userData.cefrLevel);

    // D. Envia a correção/resposta em TEXTO
    await axios.post(`${TELEGRAM_API}/sendMessage`, { 
      chat_id: chatId, 
      text: aiResponseText,
      parse_mode: 'Markdown'
    });

    // E. TTS: Gera o áudio da IA e envia (Google TTS em MP3)
    try {
        const aiAudioBuffer = await AIService.textToSpeech(aiResponseText, userData.targetLanguage);
        
        const form = new FormData();
        form.append('chat_id', chatId);
        
        // AQUI ESTÁ O AJUSTE CIRÚRGICO: enviando como 'audio' e .mp3
        form.append('audio', aiAudioBuffer, { filename: 'tutor_response.mp3', contentType: 'audio/mpeg' });

        // Endpoint sendAudio em vez de sendVoice
        await axios.post(`${TELEGRAM_API}/sendAudio`, form, {
            headers: form.getHeaders()
        });
    } catch (ttsErr) {
        // Se a voz falhar, agora ele mostra o motivo real no log do Render
        console.warn("⚠️ Erro detalhado do TTS:", ttsErr.response ? ttsErr.response.data : ttsErr.message);
    }

  } catch (error) {
    console.error('❌ Erro no processamento:', error.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, { 
      chat_id: chatId, 
      text: "Ops! Tive um problema técnico ao processar sua mensagem. Tente novamente." 
    }).catch(() => {});
  }
}

// ==========================================
// 4. ROTA DO WEBHOOK
// ==========================================
app.post('/webhook/telegram', async (req, res) => {
  // Validação de Segurança
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (secretToken !== process.env.TELEGRAM_SECRET_TOKEN) return res.status(403).send('Acesso Negado');

  const { message, callback_query } = req.body;

  // A. Tratamento de Cliques nos Botões (Escolha de Idioma)
  if (callback_query) {
    const chatId = callback_query.message.chat.id;
    const chosenLang = callback_query.data.replace('lang_', '');

    // Salva a escolha no banco de dados
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

  // B. Tratamento de Mensagens de Texto/Áudio
  if (message) {
    const chatId = message.chat.id;

    // MEMÓRIA: Busca ou cria usuário no Supabase
    let user = await prisma.user.findUnique({ where: { id: BigInt(chatId) } });

    if (!user) {
      user = await prisma.user.create({
        data: { id: BigInt(chatId), name: message.from.first_name || "Estudante" }
      });
      await sendLanguageMenu(chatId);
      return res.sendStatus(200);
    }

    // Menu forçado caso o usuário digite /start
    if (message.text === '/start') {
      await sendLanguageMenu(chatId);
      return res.sendStatus(200);
    }

    // Processa a mensagem passando os dados do banco
    processTelegramMessage(message, user);
  }

  res.sendStatus(200);
});

// Página inicial para teste de saúde (Health Check)
app.get('/', (req, res) => res.send('🟢 prose.IA Online'));

// ==========================================
// 5. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));