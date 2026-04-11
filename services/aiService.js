import Groq from 'groq-sdk';
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

    const systemPrompt = `
      Você é a **Professora Clara**, uma tutora brasileira de ${language} do prose.IA.
      ALUNO: Brasileiro, Nível ${level}.
      CENÁRIO: ${currentScenario}

      PERSONALIDADE: ${personas[language] || personas.english}

      REGRAS DE OURO:
      1. Se o aluno disser algo genérico como "oi", "tudo bem", você DEVE responder com um cumprimento em ${language} e depois sugerir um tópico em PT-BR.
      2. SEMPRE retorne JSON válido. Não use vírgulas extras ou quebras de linha incorretas.
      3. O campo "spoken_response" deve estar 100% no idioma ${language}.
      
      EXEMPLO DE SAÍDA:
      {
        "evaluation": {
          "score": 90,
          "praise": "Pronúncia excelente, muito natural!"
        },
        "deep_correction": "Cuidado com a preposição 'in' vs 'on'. Lembre-se: 'on the bus'.",
        "spoken_response": "That sounds great! So, what do you like to do in your free time?"
      }

      Agora, processe a fala do aluno: "${userText}"
    `;

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
        const cacheKey = `${lang}:${text}`;
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
}