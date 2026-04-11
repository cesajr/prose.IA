import Groq from 'groq-sdk';
import * as googleTTS from 'google-tts-api';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

// Groq cuida do Cérebro (Llama) e do Ouvido (Whisper)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export class AIService {
  
  // --- OUVIDO: Whisper transcreve o áudio gratuitamente ---
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

  // --- CÉREBRO: Llama 3.3 gera a resposta ---
  static async getChatResponse(userText, language, level) {
    const prompts = {
      english: "Você é um tutor de inglês pragmático e animado. Use o método Feedback Sanduíche (Elogio + Correção + Pergunta).",
      spanish: "Você é um tutor de espanhol caloroso e expressivo. Usa el método Feedback Sándwich.",
      french: "Você é um tutor de francês elegante e polido. Use o método Feedback Sanduíche."
    };

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `
            ${prompts[language] || prompts.english}
            - Nível do aluno: ${level}.
            - Idioma: ${language}.
            - Responda de forma curta (máximo 3 frases) para que o áudio não fique cansativo.
            - Responda em ${language}, mas use Português para corrigir gramática se for nível A1/A2.
          `
        },
        { role: "user", content: userText }
      ]
    });

    return completion.choices[0].message.content;
  }

  // --- BOCA: Google TTS (100% Gratuito e sem chave) ---
  static async textToSpeech(text, language) {
    try {
      // Define o sotaque correto com base no idioma escolhido
      const langCodes = {
        english: 'en',
        spanish: 'es',
        french: 'fr'
      };
      const code = langCodes[language] || 'en';

      // O Google TTS tem limite de 200 caracteres por vez. 
      // O 'getAllAudioBase64' corta o texto em partes, gera tudo e junta pra nós.
      const results = await googleTTS.getAllAudioBase64(text, {
        lang: code,
        slow: false,
        host: 'https://translate.google.com',
        splitPunct: ',.?', // Quebra o áudio nas pontuações para soar mais natural
      });

      // Transforma os pedaços (Base64) em um único arquivo de Áudio (Buffer) para o Telegram
      const audioBuffer = Buffer.concat(
        results.map((res) => Buffer.from(res.base64, 'base64'))
      );

      return audioBuffer;
    } catch (error) {
      console.error("❌ Erro no Google TTS:", error.message);
      throw error;
    }
  }
}