import Groq from 'groq-sdk';
import { getAllAudioBase64 } from 'google-tts-api';
import dotenv from 'dotenv';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import NodeCache from 'node-cache';
import { jsonrepair } from 'jsonrepair';
import { withTempFile } from '../utils/fileHelper.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobePath);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ttsCache = new NodeCache({ stdTTL: 86400 });

let scenariosData = {};
try {
  const scenariosPath = path.join(process.cwd(), 'scenarios.json');
  import('fs').then(fsSync => {
      if(fsSync.existsSync(scenariosPath)) {
          const data = fsSync.readFileSync(scenariosPath, 'utf-8');
          scenariosData = JSON.parse(data);
          console.log('✅ Roteiros carregados com sucesso.');
      }
  });
} catch (error) {
  console.warn('⚠️ Arquivo scenarios.json não encontrado. Usando descrições padrão.');
}

export class AIService {
  
  // ==========================================
  // 1. TRANSCRIÇÃO DE ÁUDIO
  // ==========================================
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
              const fsSync = await import('fs');
              const transcription = await groq.audio.transcriptions.create({
                file: fsSync.createReadStream(outputPath),
                model: 'whisper-large-v3',
              });
              resolve(transcription.text);
            } catch (err) {
              reject(err);
            } finally {
              try { await fs.unlink(outputPath); } catch (_) {}
            }
          })
          .on('error', reject)
          .save(outputPath);
      });
    });
  }

  // ==========================================
  // 2. MOTOR PEDAGÓGICO
  // ==========================================
  static async processPedagogy(userText, language, level, scenarioKey = null) {
    const personas = {
      english: "Inglês (EUA): Tutora americana moderna, usa phrasal verbs e contrações.",
      spanish: "Espanhol (Latam): Tutor caloroso, expressivo e amigável.",
      french: "Francês (França): Tutor polido, focado na etiqueta e liaison sonora.",
      portuguese: "Português (Brasil): Tutora nativa, paciente e detalhista na gramática."
    };

    const scenariosFallback = {
      rp_airport: "Oficial de imigração rigoroso no aeroporto.",
      rp_cafe: "Atendente de uma cafeteria movimentada.",
      rp_job: "Recrutador de RH em uma entrevista de emprego.",
      rp_school: "Professor(a) corrigindo uma tarefa de casa."
    };

    let currentScenarioDescription = "Conversa casual de microlearning.";
    if (scenarioKey && scenariosData[scenarioKey]) {
      currentScenarioDescription = `${scenariosData[scenarioKey].title}: ${scenariosData[scenarioKey].description}`;
    } else if (scenarioKey) {
      currentScenarioDescription = scenariosFallback[scenarioKey] || currentScenarioDescription;
    }

    const systemPrompt = `
      Você é a **Professora Clara**, tutora implacável (porém gentil) de ${language} do prose.IA.
      ALUNO: Brasileiro, Nível ${level}.
      CENÁRIO: ${currentScenarioDescription}
      PERSONALIDADE: ${personas[language] || personas.english}

      🎯 FOCO EM CORREÇÃO:
      Procure ativamente por erros na fala/escrita do aluno (Pronúncia, Gramática ou Traduções literais).

      ⚠️ REGRAS DE ISOLAMENTO POLIGLOTA (CRÍTICO):
      1. "spoken_response": 100% em ${language}. NENHUMA palavra em português.
      2. "deep_correction": Em Português (PT-BR). MAS, TODA VEZ que você escrever uma palavra no idioma ${language} aqui dentro, VOCÊ DEVE envolvê-la com um único asterisco (*). O nosso sistema usará esse asterisco para mudar a voz da professora para sotaque nativo.

      RETORNE OBRIGATORIAMENTE JSON. EXEMPLO:
      {
        "evaluation": { "score": 65, "praise": "Boa tentativa!" },
        "deep_correction": "Cuidado com a pronúncia! Parece que você disse *tree* em vez de *three*. O som do *TH* é muito importante.",
        "spoken_response": "I see! Being 20 is a great age. Do you work or study?"
      }

      Mensagem do aluno: "${userText}"
    `;

    try {
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      });

      let rawJson = completion.choices[0].message.content;
      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        const repaired = jsonrepair(rawJson);
        parsed = JSON.parse(repaired);
      }

      return {
        evaluation: { score: parsed.evaluation?.score ?? 70, praise: parsed.evaluation?.praise || "Bom esforço!" },
        deep_correction: parsed.deep_correction || "Frase perfeita! Continue assim.",
        spoken_response: parsed.spoken_response || "Could you repeat that, please?"
      };
    } catch (error) {
      console.error("❌ Erro IA:", error);
      return {
        evaluation: { score: 0, praise: "Ops! Sinal caiu." },
        deep_correction: "Problema técnico.", spoken_response: "Sorry, can you repeat?"
      };
    }
  }

  // ==========================================
  // 3. AVALIAÇÃO DE NÍVEL
  // ==========================================
  static async evaluateLevel(userText, language, step) {
    const systemPrompt = `
      Você é um avaliador rigoroso. Aluno de ${language}, passo ${step}/5.
      RETORNE JSON: { "level": "CEFR", "score": 0-20, "nextQuestion": "Próxima ou FIM" }
    `;
    try {
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Resposta: "${userText}"` }],
        temperature: 0.1, response_format: { type: "json_object" }
      });
      return JSON.parse(completion.choices[0].message.content);
    } catch {
      return { level: "A1", score: 10, nextQuestion: "FIM" };
    }
  }

  // ==========================================
  // 4. GERAÇÃO DE ÁUDIO POLIGLOTA (Sotaque Dinâmico)
  // ==========================================
  static async generateBilingualVoice(targetText, language, ptText) {
    try {
      const langCodes = { english: 'en', spanish: 'es', french: 'fr', portuguese: 'pt' };
      const targetLang = langCodes[language] || 'en';
      const ptLang = 'pt'; 
      
      let audioBuffers = [];

      const getAudioWithCache = async (text, lang) => {
        const cleanText = text.trim();
        if (!cleanText || cleanText.length === 0) return Buffer.alloc(0);
        
        const cacheKey = `${lang}:${cleanText}`;
        let cached = ttsCache.get(cacheKey);
        if (cached && cached.length > 0) return cached;

        try {
          const results = await getAllAudioBase64(cleanText, {
            lang, slow: false, host: 'https://translate.google.com', splitPunct: ',.?'
          });
          if (!results || results.length === 0) throw new Error('Dados vazios');
          const audioBuffer = Buffer.concat(results.map((res) => Buffer.from(res.base64, 'base64')));
          ttsCache.set(cacheKey, audioBuffer);
          return audioBuffer;
        } catch (error) {
          console.error(`❌ Erro TTS para "${cleanText}":`, error.message);
          return Buffer.alloc(0);
        }
      };

      // 1. Áudio da Conversa (Sempre no sotaque alvo)
      if (targetText) {
        const targetAudio = await getAudioWithCache(targetText, targetLang);
        if (targetAudio.length > 0) audioBuffers.push(targetAudio);
      }

      // 2. Áudio da Correção (Motor Poliglota)
      if (ptText) {
        // Fatiamos a frase onde houver asterisco (*)
        const parts = ptText.split('*');
        
        for (let i = 0; i < parts.length; i++) {
          const textChunk = parts[i];
          if (textChunk.trim().length === 0) continue;

          // Se o índice for ímpar, significa que a palavra estava DENTRO dos asteriscos
          if (i % 2 !== 0) {
            console.log(`✨ Troca de Sotaque (Nativo): "${textChunk}"`);
            const chunkAudio = await getAudioWithCache(textChunk, targetLang);
            if (chunkAudio.length > 0) audioBuffers.push(chunkAudio);
          } else {
            // Se for par, é o português normal fora dos asteriscos
            console.log(`🗣️ Falando Português: "${textChunk}"`);
            const chunkAudio = await getAudioWithCache(textChunk, ptLang);
            if (chunkAudio.length > 0) audioBuffers.push(chunkAudio);
          }
        }
      }

      return audioBuffers.length > 0 ? Buffer.concat(audioBuffers) : null;
    } catch (error) {
      console.error("❌ Erro crítico TTS:", error);
      return null;
    }
  }
}