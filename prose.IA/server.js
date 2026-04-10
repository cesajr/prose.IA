import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';
import { AIService } from './aiService.js'; // Nosso cérebro isolado

dotenv.config();

const app = express();
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Adicione esta linha para o Express confiar no túnel do Ngrok
app.set('trust proxy', 1);

// ==========================================
// 1. APPSEC: BLINDAGEM DO SERVIDOR HTTP
// ==========================================
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' })); // Limite maior para suportar payloads com links de áudio

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: 'Rate limit excedido.'
});
app.use('/webhook', limiter);

// ==========================================
// 2. ORQUESTRADOR ASSÍNCRONO (EVENT LOOP SAFE)
// ==========================================
// Esta função roda em background. O Node não bloqueia a thread principal.
async function processTelegramMessage(message) {
  const chatId = message.chat.id;

  try {
    // A. Notifica o usuário que a IA está "digitando/gravando"
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'record_voice' });

    let userText = '';

    // B. Roteamento: É Texto ou Áudio?
    if (message.text) {
      userText = message.text;
    } 
    else if (message.voice) {
      // 1. Pega o caminho do arquivo no servidor do Telegram
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${message.voice.file_id}`);
      const filePath = fileRes.data.result.file_path;
      
      // 2. Baixa o arquivo binário (ArrayBuffer)
      const audioRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`, {
        responseType: 'arraybuffer'
      });
      
      // 3. Envia para o Whisper transcrever (Transforma em Buffer nativo do Node)
      const audioBuffer = Buffer.from(audioRes.data);
      // Nota: o arquivo gerado pelo Telegram é um .ogg
      audioBuffer.name = 'audio.ogg'; 

      userText = await AIService.transcribeAudio(audioBuffer);
      console.log(`🎙️ Transcrição do Whisper: "${userText}"`);
    } else {
      return; // Ignora stickers, imagens, etc.
    }

    // C. Cérebro: GPT-4o gera a resposta pedagógica e a correção
    const aiResponseText = await AIService.getChatResponse(userText);

    // D. Envia a correção em TEXTO para o aluno ler
    await axios.post(`${TELEGRAM_API}/sendMessage`, { 
      chat_id: chatId, 
      text: aiResponseText 
    });

    // E. TTS: Gera o áudio da IA falando fluentemente
    const aiAudioBuffer = await AIService.textToSpeech(aiResponseText);

    // F. Prepara o envio do áudio (Multipart Form-Data)
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('voice', aiAudioBuffer, { filename: 'tutor_response.ogg', contentType: 'audio/ogg' });

    // G. Envia o áudio de volta para o Telegram
    await axios.post(`${TELEGRAM_API}/sendVoice`, form, {
      headers: form.getHeaders()
    });

  } catch (error) {
    console.error('❌ Erro no processamento em background:', error.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, { 
      chat_id: chatId, 
      text: "Ops! Tive um problema técnico ao processar sua mensagem. Tente novamente." 
    }).catch(() => {}); // Catch silencioso para não derrubar o app se o Telegram cair
  }
}

// ==========================================
// ROTA DE HEALTH CHECK (Página Inicial)
// ==========================================
app.get('/', (req, res) => {
  res.status(200).send('🟢 API DestravIA está online e aguardando webhooks.');
});

// ==========================================
// 3. ROTA DO WEBHOOK (TELEGRAM)
// ==========================================
app.post('/webhook/telegram', (req, res) => {
  // 1. Validação de Assinatura (Hard Constraint)
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (secretToken !== process.env.TELEGRAM_SECRET_TOKEN) {
    console.warn('⚠️ Tentativa de acesso negada (Token Inválido).');
    return res.status(403).send('Acesso Negado');
  }

  const message = req.body.message;
  
  if (message) {
    console.log(`📩 Recebido de ${message.from.first_name}`);
    
    // 2. Dispara o processamento em background (Fire-and-forget)
    // NÃO usamos 'await' aqui. Se usarmos, o Telegram fica aguardando e dá timeout.
    processTelegramMessage(message);
  }

  // 3. Responde imediatamente ao Telegram (Libera a conexão HTTP)
  res.sendStatus(200);
});

// ==========================================
// 4. INICIALIZAÇÃO
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 DestravIA Omnichannel rodando blindado na porta ${PORT}`);
});