#!/usr/bin/env node

import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Estrutura de diretórios e arquivos
const files = {
  '.env.example': `# Telegram
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_SECRET_TOKEN=uma_senha_secreta_para_webhook

# Groq (LLM + STT)
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Supabase PostgreSQL (Transaction Pooler)
# Adicionar ?pgbouncer=true&pg_prepared_statements=false
DATABASE_URL="postgresql://postgres.xxxxxxxx:password@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&pg_prepared_statements=false"

# Porta do servidor
PORT=3000`,

  '.gitignore': `node_modules/
.env
temp_*
*.log
.DS_Store
dist/
`,

  'package.json': JSON.stringify({
    name: "prose.ia",
    version: "1.0.0",
    description: "Bot de Telegram imersivo para ensino de idiomas com IA generativa",
    main: "server.js",
    type: "module",
    scripts: {
      start: "node server.js",
      dev: "nodemon server.js",
      postinstall: "prisma generate"
    },
    dependencies: {
      "@ffprobe-installer/ffprobe": "^2.1.2",
      "@prisma/client": "^5.17.0",
      "axios": "^1.7.2",
      "cors": "^2.8.5",
      "dotenv": "^16.4.5",
      "express": "^4.19.2",
      "express-rate-limit": "^7.3.1",
      "ffmpeg-static": "^5.2.0",
      "fluent-ffmpeg": "^2.1.3",
      "form-data": "^4.0.0",
      "google-tts-api": "^2.0.2",
      "groq-sdk": "^0.5.0",
      "helmet": "^7.1.0",
      "jsonrepair": "^3.8.0",
      "node-cache": "^5.1.2",
      "prisma": "^5.17.0",
      "uuid": "^10.0.0"
    },
    devDependencies: {
      "nodemon": "^3.1.4"
    },
    engines: {
      node: ">=18"
    }
  }, null, 2),

  'prisma/schema.prisma': `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id                 BigInt   @id
  name               String
  targetLanguage     String   @default("english")
  cefrLevel          String   @default("A1")
  activeRoleplay     String?  // Ex: "rp_airport" ou null
  activeRoleplayStep Int      @default(0)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  interactions Interaction[]
}

model Interaction {
  id          String   @id @default(cuid())
  user        User     @relation(fields: [userId], references: [id])
  userId      BigInt
  userMessage String
  botResponse Json     // Armazena o JSON completo da resposta da IA
  score       Int
  createdAt   DateTime @default(now())
}`,

  'utils/fileHelper.js': `import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';

/**
 * Executa uma função com um arquivo temporário criado a partir de um buffer.
 * O arquivo é automaticamente removido após a execução (sucesso ou erro).
 */
export async function withTempFile(buffer, extension, callback) {
  const tempPath = \`./temp_\${uuidv4()}.\${extension}\`;
  try {
    await fs.writeFile(tempPath, buffer);
    return await callback(tempPath);
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch (cleanupError) {
      console.warn(\`Falha ao limpar arquivo temporário \${tempPath}:\`, cleanupError);
    }
  }
}`,

  'services/aiService.js': `import Groq from 'groq-sdk';
import * as googleTTS from 'google-tts-api';
import dotenv from 'dotenv';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import NodeCache from 'node-cache';
import { jsonrepair } from 'jsonrepair';
import { withTempFile } from '../utils/fileHelper.js';
import { Readable } from 'stream';

dotenv.config();

// Configuração do FFmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobePath);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Cache de TTS (24 horas)
const ttsCache = new NodeCache({ stdTTL: 86400 });

export class AIService {
  /**
   * 1. Transcrição de áudio com Whisper Large V3
   *    - Converte OGG (Telegram) para WAV 16kHz mono
   *    - Usa gerenciamento seguro de arquivos temporários
   */
  static async transcribeAudio(oggBuffer) {
    return withTempFile(oggBuffer, 'ogg', (inputPath) => {
      return new Promise((resolve, reject) => {
        const outputPath = inputPath.replace('.ogg', '.wav');

        ffmpeg(inputPath)
          .toFormat('wav')
          .audioFrequency(16000)
          .audioChannels(1)
          .on('end', async () => {
            try {
              const transcription = await groq.audio.transcriptions.create({
                file: await import('fs').then(fs => fs.createReadStream(outputPath)),
                model: 'whisper-large-v3',
              });
              resolve(transcription.text);
            } catch (err) {
              reject(err);
            } finally {
              // Limpeza do WAV gerado
              const fs = await import('fs/promises');
              try { await fs.unlink(outputPath); } catch (_) {}
            }
          })
          .on('error', reject)
          .save(outputPath);
      });
    });
  }

  /**
   * 2. Processamento Pedagógico com Llama 3.3 70B
   *    - Inclui prompt robusto, few-shot e reparo de JSON
   */
  static async processPedagogy(userText, language, level, scenarioKey = null) {
    const personas = {
      english: "Inglês (EUA): Tutora americana moderna, usa phrasal verbs e contrações naturais.",
      spanish: "Espanhol (Latam): Tutor caloroso, expressivo e amigável.",
      french: "Francês (França): Tutor polido, focado na etiqueta e na liaison sonora."
    };

    const scenarios = {
      rp_airport: "Oficial de imigração rigoroso no aeroporto.",
      rp_cafe: "Atendente de uma cafeteria movimentada.",
      rp_job: "Recrutador de RH em uma entrevista de emprego.",
      rp_school: "Professor(a) corrigindo uma tarefa de casa.",
      rp_university: "Colega veterano ajudando no campus universitário.",
      rp_cinema: "Funcionário da bilheteria do cinema.",
      rp_park: "Pessoa passeando com cachorro que puxa conversa no parque.",
      rp_travel: "Recepcionista de um hotel de luxo ou guia turístico em um ponto histórico.",
      rp_church: "Membro acolhedor de uma comunidade religiosa após o culto/missa.",
      rp_meeting: "Líder de uma reunião corporativa via Zoom discutindo metas trimestrais."
    };

    const currentScenario = scenarioKey ? scenarios[scenarioKey] : "Tutor em uma conversa casual de microlearning.";

    const systemPrompt = \`
      Você é a **Professora Clara**, uma tutora brasileira de \${language} do prose.IA.
      ALUNO: Brasileiro, Nível \${level}.
      CENÁRIO: \${currentScenario}

      PERSONALIDADE: \${personas[language] || personas.english}

      REGRAS DE OURO:
      1. Se o aluno disser algo genérico como "oi", "tudo bem", você DEVE responder com um cumprimento em \${language} e depois sugerir um tópico em PT-BR.
      2. SEMPRE retorne JSON válido. Não use vírgulas extras ou quebras de linha incorretas.
      3. O campo "spoken_response" deve estar 100% no idioma \${language}.
      
      EXEMPLO DE SAÍDA:
      {
        "evaluation": {
          "score": 90,
          "praise": "Pronúncia excelente, muito natural!"
        },
        "deep_correction": "Cuidado com a preposição 'in' vs 'on'. Lembre-se: 'on the bus'.",
        "spoken_response": "That sounds great! So, what do you like to do in your free time?"
      }

      Agora, processe a fala do aluno: "\${userText}"
    \`;

    try {
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ],
        temperature: 0.7,
        response_format: { type: "json_object" }
      });

      let rawJson = completion.choices[0].message.content;
      
      try {
        return JSON.parse(rawJson);
      } catch (parseError) {
        console.warn("JSON malformado detectado. Tentando reparar...", rawJson);
        const repaired = jsonrepair(rawJson);
        return JSON.parse(repaired);
      }
    } catch (error) {
      console.error("Erro IA:", error);
      return {
        evaluation: { score: 0, praise: "Ops! O sinal caiu." },
        deep_correction: "Tive um problema técnico. Tente novamente em instantes.",
        spoken_response: "Sorry, can you repeat?"
      };
    }
  }

  /**
   * 3. Geração de áudio bilíngue com silêncio entre idiomas e cache
   */
  static async generateBilingualVoice(targetText, language, ptText) {
    try {
      const langCodes = {
        english: 'en-US',
        spanish: 'es-MX',
        french: 'fr-FR',
        portuguese: 'pt-BR'
      };
      const targetCode = langCodes[language] || 'pt-BR';
      let audioBuffers = [];

      const getAudioWithCache = async (text, lang) => {
        const cacheKey = \`\${lang}:\${text}\`;
        let cached = ttsCache.get(cacheKey);
        if (cached) return cached;

        const chunks = await googleTTS.getAllAudioBase64(text, {
          lang,
          slow: false,
          host: 'https://translate.google.com'
        });
        const buffers = chunks.map(c => Buffer.from(c.base64, 'base64'));
        const fullBuffer = Buffer.concat(buffers);
        ttsCache.set(cacheKey, fullBuffer);
        return fullBuffer;
      };

      // Áudio no idioma alvo
      if (targetText) {
        audioBuffers.push(await getAudioWithCache(targetText, targetCode));
      }

      // Silêncio de 250ms (16kHz, 16-bit)
      const silence = Buffer.alloc(16000 * 2 * 0.25);
      audioBuffers.push(silence);

      // Áudio do feedback em PT-BR
      if (ptText) {
        audioBuffers.push(await getAudioWithCache(ptText, 'pt-BR'));
      }

      return audioBuffers.length > 0 ? Buffer.concat(audioBuffers) : null;
    } catch (error) {
      console.error("Erro TTS:", error);
      return null;
    }
  }
}`,

  'server.js': `import express from 'express';
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
const TELEGRAM_API = \`https://api.telegram.org/bot\${TELEGRAM_TOKEN}\`;

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
    text = "🌍 **Configuração de Idioma**\\nEscolha qual idioma deseja praticar:";
    keyboard = [
      [{ text: "🇺🇸 Inglês", callback_data: "lang_english" }, { text: "🇪🇸 Espanhol", callback_data: "lang_spanish" }],
      [{ text: "🇫🇷 Francês", callback_data: "lang_french" }]
    ];
  } else if (type === 'rp') {
    text = "🎭 **Cenários de Roleplay**\\nEscolha uma situação real para treinar:";
    keyboard = [
      [{ text: "✈️ Imigração", callback_data: "rp_airport" }, { text: "☕ Café", callback_data: "rp_cafe" }],
      [{ text: "💼 Entrevista", callback_data: "rp_job" }, { text: "🏫 Escola", callback_data: "rp_school" }],
      [{ text: "🎓 Universidade", callback_data: "rp_university" }, { text: "🎬 Cinema", callback_data: "rp_cinema" }],
      [{ text: "🌳 Parque", callback_data: "rp_park" }, { text: "🏨 Viagem/Hotel", callback_data: "rp_travel" }],
      [{ text: "⛪ Igreja/Comunidade", callback_data: "rp_church" }, { text: "👔 Reunião Empresa", callback_data: "rp_meeting" }]
    ];
  }

  await axios.post(\`\${TELEGRAM_API}/sendMessage\`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendTypingIndicator(chatId, isVoice) {
  await axios.post(\`\${TELEGRAM_API}/sendChatAction\`, {
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
      const fileRes = await axios.get(\`\${TELEGRAM_API}/getFile?file_id=\${message.voice.file_id}\`);
      const audioUrl = \`https://api.telegram.org/file/bot\${TELEGRAM_TOKEN}/\${fileRes.data.result.file_path}\`;
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
    let report = \`🗣️ *Resposta:*\\n\${result.spoken_response}\\n\\n\`;
    report += \`📈 *Fluência:* \${result.evaluation.score}/100 \${scoreEmoji}\\n\`;
    report += \`✨ *Análise:* \${result.evaluation.praise}\\n\`;
    report += \`💡 *Dica:* _\${result.deep_correction}_\`;

    const keyboard = {
      inline_keyboard: [
        [{ text: "🔁 Tentar de novo", callback_data: "retry_last" }],
        [{ text: "🎭 Novo Roleplay", callback_data: "menu_rp" }, { text: "🌍 Mudar Idioma", callback_data: "menu_lang" }]
      ]
    };

    await axios.post(\`\${TELEGRAM_API}/sendMessage\`, {
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
        await axios.post(\`\${TELEGRAM_API}/sendAudio\`, form, { headers: form.getHeaders() });
      }
    }
  } catch (err) {
    console.error("Erro no processamento:", err);
    // Notificar usuário sobre erro
    await axios.post(\`\${TELEGRAM_API}/sendMessage\`, {
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
          await axios.post(\`\${TELEGRAM_API}/sendMessage\`, {
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

        await axios.post(\`\${TELEGRAM_API}/answerCallbackQuery\`, {
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
          await axios.post(\`\${TELEGRAM_API}/sendMessage\`, {
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
  console.log(\`🚀 Servidor rodando na porta \${PORT}\`);
});`
};

// Criação de pastas e arquivos
async function setup() {
  console.log('🚀 Configurando projeto prose.IA...\n');

  // Criar diretórios
  const dirs = ['prisma', 'utils', 'services'];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
    console.log(`✅ Diretório criado: ${dir}`);
  }

  // Criar arquivos
  for (const [filePath, content] of Object.entries(files)) {
    await fs.writeFile(filePath, content, 'utf8');
    console.log(`✅ Arquivo criado: ${filePath}`);
  }

  // Criar arquivo .env vazio
  await fs.writeFile('.env', '# Preencha com suas chaves conforme .env.example\n', 'utf8');
  console.log('✅ Arquivo .env criado (vazio)');

  console.log('\n📦 Instalando dependências...');
  try {
    execSync('npm install', { stdio: 'inherit' });
    console.log('✅ Dependências instaladas com sucesso.');
  } catch (error) {
    console.error('❌ Erro ao instalar dependências. Execute "npm install" manualmente.');
  }

  console.log('\n📋 Próximos passos:');
  console.log('1. Preencha o arquivo .env com suas credenciais (veja .env.example).');
  console.log('2. Configure o banco de dados no Supabase e execute:');
  console.log('   npx prisma migrate dev --name init');
  console.log('3. Configure o webhook do Telegram (substitua <URL> pela URL pública):');
  console.log('   curl -X POST "https://api.telegram.org/bot<SEU_TOKEN>/setWebhook?url=<URL>/webhook/telegram&secret_token=<SECRET>"');
  console.log('4. Inicie o servidor: npm start');
  console.log('\n🎉 prose.IA está pronto para decolar!');
}

setup().catch(console.error);