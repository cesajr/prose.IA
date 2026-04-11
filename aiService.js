import Groq from 'groq-sdk';
import * as googleTTS from 'google-tts-api';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export class AIService {
  
  // ==========================================
  // 1. TRANSCREVER (Whisper V3)
  // ==========================================
  static async transcribeAudio(audioBuffer) {
    const tempFile = `./temp_${Date.now()}.ogg`;
    fs.writeFileSync(tempFile, audioBuffer);
    
    try {
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(tempFile),
        model: "whisper-large-v3",
      });
      return transcription.text;
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  // ==========================================
  // 2. PROCESSAR PEDAGOGIA (Cérebro Multidimensional)
  // ==========================================
  static async processPedagogy(userText, language, level, scenarioKey = null) {
    const personas = {
      english: "Inglês (EUA): Tutora americana moderna, usa phrasal verbs e contrações naturais.",
      spanish: "Espanhol (Latam): Tutor caloroso, expressivo e amigável.",
      french: "Francês (França): Tutor polido, focado na etiqueta e na liaison sonora."
    };

    // Mapeamento de Cenários (Roleplays)
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
      Você é o motor de IA do prose.IA. 
      ALUNO: Brasileiro, Nível ${level}, aprendendo ${language}.
      PERSONALIDADE: ${personas[language] || personas.english}
      CENÁRIO ATUAL: ${currentScenario}

      METODOLOGIA:
      - TBLT: Foque em fazer o aluno resolver a situação de comunicação.
      - Explain My Answer: Se houver erro, explique o "porquê" de forma simples em PT-BR.
      
      RETORNE APENAS JSON:
      {
        "evaluation": {
          "score": <0-100>,
          "praise": "<Elogio curto em PT-BR>"
        },
        "deep_correction": "<Explicação pedagógica do erro ou dica nativa em PT-BR.>",
        "spoken_response": "<Sua fala como NPC/Tutor. 100% em ${language}. Curta e natural.>"
      }
    `;

    try {
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userText }],
        response_format: { type: "json_object" }
      });
      return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
      console.error("Erro IA:", error);
      return { evaluation: { score: 0, praise: "Ops!" }, deep_correction: "Erro de conexão.", spoken_response: "Can you repeat?" };
    }
  }

  // ==========================================
  // 3. GERAR VOZ (Sotaques Nativos)
  // ==========================================
  static async generateBilingualVoice(targetText, language, ptText) {
    try {
      const langCodes = { english: 'en-US', spanish: 'es-MX', french: 'fr-FR', portuguese: 'pt-BR' };
      const targetCode = langCodes[language] || 'pt-BR';
      let audioBuffers = [];

      if (targetText) {
        const res = await googleTTS.getAllAudioBase64(targetText, { lang: targetCode, host: 'https://translate.google.com' });
        audioBuffers.push(...res.map(r => Buffer.from(r.base64, 'base64')));
      }

      if (ptText) {
        const res = await googleTTS.getAllAudioBase64(ptText, { lang: 'pt-BR', host: 'https://translate.google.com' });
        audioBuffers.push(...res.map(r => Buffer.from(r.base64, 'base64')));
      }

      return audioBuffers.length > 0 ? Buffer.concat(audioBuffers) : null;
    } catch (error) {
      console.error("Erro TTS:", error);
      return null;
    }
  }
}