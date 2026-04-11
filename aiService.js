import Groq from 'groq-sdk';
import * as googleTTS from 'google-tts-api';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export class AIService {
  
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

  static async getChatResponse(userText, language, level, isRoleplay = false) {
    const personas = {
      english: "Inglês (EUA/UK): Guia pragmático, entusiasta, focado em negócios, cultura pop e eficiência.",
      spanish: "Espanhol (ESP/MEX): Companheiro caloroso, expressivo, focado em relações sociais, comida e cultura vibrante.",
      french: "Francês (FRA): Intelectual, polido, focado na etiqueta (politesse) e a elegância do idioma."
    };

    const roleplayInstruction = isRoleplay 
      ? "ATIVIDADE: ROLEPLAY. O usuário quer treinar uma situação real. Assuma o papel do NPC." 
      : "ATIVIDADE: CONVERSA LIVRE E MICROLEARNING.";

    const systemPrompt = `
      Você é o Coordenador Pedagógico do prose.IA.
      PÚBLICO: Brasileiros aprendendo ${language}. Nível: ${level}.
      PERSONA: ${personas[language] || personas.english}
      ${roleplayInstruction}

      REGRA DE OURO (SEPARAÇÃO ESTRITA DE IDIOMAS NO JSON):
      "correction": "Seu Feedback Sanduíche explicando o erro de gramática/pronúncia. OBRIGATORIAMENTE 100% EM PORTUGUÊS (PT-BR). Se não houver erros, deixe vazio ''.",
      "spoken_response": "A continuação natural da conversa. OBRIGATORIAMENTE 100% NO IDIOMA ALVO (${language}). NUNCA coloque português nesta chave."
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
      console.error("Erro na Llama:", error);
      return { correction: "Tive um problema na conexão.", spoken_response: "Can you repeat, please?" };
    }
  }

  // --- O SEGREDO: CORDAS VOCAIS BILÍNGUES ---
  static async generateBilingualTTS(targetText, language, ptText) {
    try {
      const langCodes = { english: 'en', spanish: 'es', french: 'fr' };
      const targetCode = langCodes[language] || 'en';
      let audioBuffers = [];

      // 1. Gera a fala no idioma alvo (Sotaque Gringo Perfeito)
      if (targetText && targetText.trim() !== "") {
        const targetResults = await googleTTS.getAllAudioBase64(targetText, {
          lang: targetCode, slow: false, host: 'https://translate.google.com', splitPunct: ',.?'
        });
        audioBuffers.push(...targetResults.map(res => Buffer.from(res.base64, 'base64')));
      }

      // 2. Gera a explicação em Português (Sotaque BR Perfeito)
      if (ptText && ptText.trim() !== "") {
        const ptResults = await googleTTS.getAllAudioBase64(ptText, {
          lang: 'pt', slow: false, host: 'https://translate.google.com', splitPunct: ',.?'
        });
        audioBuffers.push(...ptResults.map(res => Buffer.from(res.base64, 'base64')));
      }

      // Junta os dois MP3 em um único arquivo de áudio perfeitamente fluido!
      return Buffer.concat(audioBuffers);
    } catch (error) {
      console.error("❌ Erro no TTS Bilíngue:", error.message);
      throw error;
    }
  }
}