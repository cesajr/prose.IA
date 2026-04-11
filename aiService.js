import Groq from 'groq-sdk';
import * as googleTTS from 'google-tts-api';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export class AIService {
  
  // ==========================================
  // 1. CAPTAR E TRANSCREVER (Ouvido)
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
  // 2. AVALIAR, CORRIGIR, SUGERIR E RESPONDER (Cérebro)
  // ==========================================
  static async processPedagogy(userText, language, level, isRoleplay = false) {
    const personas = {
      english: "Inglês (EUA): Guia pragmático, entusiasta, focado em comunicação real.",
      spanish: "Espanhol (Latino): Companheiro caloroso, expressivo, focado em cultura.",
      french: "Francês (França): Intelectual, polido, focado na etiqueta e fluidez."
    };

    const roleplayInstruction = isRoleplay 
      ? "MODO ATUAL: ROLEPLAY. Assuma o papel de um NPC. Faça perguntas no contexto." 
      : "MODO ATUAL: CONVERSA LIVRE E MICROLEARNING.";

    const systemPrompt = `
      Você é o Coordenador Pedagógico e Tutor do prose.IA.
      PÚBLICO: Brasileiros aprendendo ${language}. Nível: ${level}.
      PERSONA: ${personas[language] || personas.english}
      ${roleplayInstruction}

      Siga rigorosamente a metodologia TBLT e o Feedback Sanduíche.
      VOCÊ DEVE RESPONDER OBRIGATORIAMENTE NESTE FORMATO JSON:
      {
        "analysis": "Avalie brevemente se o aluno usou bem o vocabulário ou se cometeu vícios brasileiros (Ex: 'A pronúncia do TH foi trocada por F'). Apenas em PT-BR.",
        "correction": "O Feedback Sanduíche detalhado (Elogio + Correção). Apenas em PT-BR. Se não houver erro, elogie.",
        "suggestion": "Uma dica rápida e prática de estudo ou vocabulário extra. Apenas em PT-BR.",
        "spoken_response": "A resposta natural da conversa como Tutor/NPC. 100% em ${language}. NUNCA use português aqui."
      }
    `;

    try {
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ],
        response_format: { type: "json_object" }
      });

      return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
      console.error("❌ Erro na IA Pedagógica:", error);
      return { 
        analysis: "Erro de processamento.",
        correction: "Tivemos um pequeno lapso de conexão.", 
        suggestion: "Tente enviar a mensagem novamente.",
        spoken_response: "Can you repeat, please?" 
      };
    }
  }

  // ==========================================
  // 3. FALAR (Boca Bilíngue com Sotaques Nativos)
  // ==========================================
  static async generateBilingualVoice(targetText, language, ptText) {
    try {
      const langCodes = { english: 'en-US', spanish: 'es-MX', french: 'fr-FR', portuguese: 'pt-BR' };
      const targetCode = langCodes[language] || 'en-US';
      let audioBuffers = [];

      // A. Áudio do Idioma Alvo (A Conversa)
      if (targetText && targetText.trim() !== "") {
        const targetResults = await googleTTS.getAllAudioBase64(targetText, {
          lang: targetCode, slow: false, host: 'https://translate.google.com', splitPunct: ',.?'
        });
        audioBuffers.push(...targetResults.map(res => Buffer.from(res.base64, 'base64')));
      }

      // B. Áudio em Português (O Feedback)
      if (ptText && ptText.trim() !== "") {
        const ptResults = await googleTTS.getAllAudioBase64(ptText, {
          lang: 'pt-BR', slow: false, host: 'https://translate.google.com', splitPunct: ',.?'
        });
        audioBuffers.push(...ptResults.map(res => Buffer.from(res.base64, 'base64')));
      }

      return audioBuffers.length > 0 ? Buffer.concat(audioBuffers) : null;
    } catch (error) {
      console.error("❌ Erro no TTS Bilíngue:", error.message);
      throw error;
    }
  }
}