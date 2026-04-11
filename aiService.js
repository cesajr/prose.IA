import Groq from 'groq-sdk';
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

  static async getChatResponse(userText, language, level) {
    const prompts = {
      english: "Você é um tutor de inglês pragmático e animado.",
      spanish: "Você é um tutor de espanhol caloroso e expressivo.",
      french: "Você é um tutor de francês elegante e polido."
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
            - Método: FEEDBACK SANDUÍCHE (Elogio + Correção + Pergunta).
            - Corrija vícios de pronúncia de brasileiros (ex: 'worki').
            - Responda em ${language}, mas use Português para explicar gramática se for nível A1/A2.
          `
        },
        { role: "user", content: userText }
      ]
    });

    return completion.choices[0].message.content;
  }

  // Placeholder para o seu TTS (Pode usar Google, OpenAI ou ElevenLabs)
  static async textToSpeech(text) {
     // Aqui você deve implementar sua lógica de geração de áudio
     // Se não tiver uma agora, o bot enviará apenas texto.
     throw new Error("TTS não implementado");
  }
}