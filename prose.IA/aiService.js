import Groq from 'groq-sdk';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export class AIService {
  // 1. OUVIR (Whisper Large V3 na Groq)
  static async transcribeAudio(audioBuffer) {
    const file = new File([audioBuffer], 'audio.ogg', { type: 'audio/ogg' });
    
    const transcription = await groq.audio.transcriptions.create({
      file: file,
      model: "whisper-large-v3", 
    });
    return transcription.text;
  }

  // 2. PENSAR (Llama 3 70B na Groq)
  static async getChatResponse(userText) {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile", 
      messages: [
        { 
          role: "system", 
          content: `Você é um tutor de idiomas paciente. Seu aluno é brasileiro.
          Regras:
          1. Responda de forma MUITO curta e natural em inglês.
          2. Se houver erro de gramática no que o aluno disse, responda à conversa normalmente em inglês e adicione 'Correção:' em português no final.
          3. Faça uma pergunta fácil em inglês no final.` 
        },
        { role: "user", content: userText }
      ],
      temperature: 0.7,
    });
    return response.choices[0].message.content;
  }

  // 3. FALAR (Integração Direta e Segura - Zero CVEs)
  static async textToSpeech(text) {
    // Limpa a "Correção" para a IA não ler a regra em voz alta
    let textToSpeak = text.split('Correção:')[0].trim();
    if (!textToSpeak) textToSpeak = "I couldn't generate a proper response.";

    try {
      // Monta a URL direta do Google Translate (Engenharia Reversa)
      // client=tw-ob é o cliente web não oficial que retorna o áudio limpo
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(textToSpeak)}&tl=en&client=tw-ob`;

      // Baixa o áudio de forma segura com o nosso Axios atualizado
      const response = await axios.get(url, { 
        responseType: 'arraybuffer',
        // Headers simulando um navegador para evitar bloqueio do Google
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      return Buffer.from(response.data);
      
    } catch (error) {
      console.error("❌ Erro no TTS Direto:", error.message);
      throw error;
    }
  }
}