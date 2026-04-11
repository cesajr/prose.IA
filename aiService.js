import Groq from 'groq-sdk';
import * as googleTTS from 'google-tts-api';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export class AIService {
  
  // --- OUVIDO: Whisper transcreve o áudio ---
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

  // --- CÉREBRO: Metodologia prose.IA (JSON Output) ---
  static async getChatResponse(userText, language, level, isRoleplay = false) {
    const personas = {
      english: "Inglês (EUA/UK): Guia pragmático, entusiasta, focado em negócios, cultura pop e eficiência.",
      spanish: "Espanhol (ESP/MEX): Companheiro caloroso, expressivo, focado em relações sociais, comida e cultura vibrante.",
      french: "Francês (FRA): Intelectual, polido, focado na etiqueta (politesse) e na elegância do idioma."
    };

    const roleplayInstruction = isRoleplay 
      ? "ATIVIDADE ATUAL: MODO ROLEPLAY. O usuário quer treinar uma situação real (ex: imigração, restaurante). Assuma o papel do NPC (atendente, policial, garçom). Faça perguntas diretas e espere a resposta." 
      : "ATIVIDADE ATUAL: CONVERSA LIVRE E MICROLEARNING.";

    const systemPrompt = `
      Você é o Coordenador Pedagógico do prose.IA, um Sistema Multilíngue de Ensino Imersivo.
      
      PÚBLICO: Brasileiros aprendendo ${language}. Nível: ${level}.
      PERSONA: ${personas[language] || personas.english}
      ${roleplayInstruction}

      PILARES METODOLÓGICOS:
      1. TBLT (Task-Based Language Teaching): Foco na comunicação e resolução de problemas.
      2. Filtro Afetivo Baixo: Seja extremamente empático. Ninguém gosta de ser julgado.
      3. Feedback Sanduíche: Elogio + Correção + Pergunta para continuar a fluidez.
      4. Foco em Pronúncia: O aluno usa áudio. Se ele escreveu 'worki' em vez de 'work', corrija a palatalização típica de brasileiros.

      REGRA DE OURO (FORMATO DE SAÍDA):
      Você DEVE, obrigatoriamente, responder APENAS em formato JSON válido, contendo duas chaves:
      "correction": "O Feedback Sanduíche em texto (Use português se o nível for A1/A2, senão no idioma alvo). Deixe vazio '' se não houver erros.",
      "spoken_response": "A resposta natural da conversa no idioma alvo. Curta, fluida, como uma mensagem de voz de WhatsApp (sem emojis, sem hashtags, pronta para ser lida por um TTS)."
    `;

    try {
      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ],
        response_format: { type: "json_object" } // Força a saída estruturada
      });

      // Extrai o JSON gerado
      const rawContent = completion.choices[0].message.content;
      return JSON.parse(rawContent);

    } catch (error) {
      console.error("Erro na geração da resposta:", error);
      return { 
        correction: "⚠️ Tive um pequeno lapso de memória.", 
        spoken_response: "Sorry, can you say that again?" 
      };
    }
  }

  // --- BOCA: Google TTS (100% Gratuito) ---
  static async textToSpeech(text, language) {
    if (!text || text.trim() === "") return null;

    try {
      const langCodes = { english: 'en', spanish: 'es', french: 'fr' };
      const code = langCodes[language] || 'en';

      const results = await googleTTS.getAllAudioBase64(text, {
        lang: code,
        slow: false,
        host: 'https://translate.google.com',
        splitPunct: ',.?',
      });

      return Buffer.concat(results.map((res) => Buffer.from(res.base64, 'base64')));
    } catch (error) {
      console.error("❌ Erro no Google TTS:", error.message);
      throw error;
    }
  }
}