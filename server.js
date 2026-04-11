// C. Cérebro: Llama 3.3 gera a resposta (Injetando idioma e nível)
    const aiResponse = await AIService.getChatResponse(userText, userData.targetLanguage, userData.cefrLevel, isRoleplay);

    // D. Envia a TRADUÇÃO/CORREÇÃO em TEXTO (Como um bloco de notas visual)
    let textMessage = "";
    if (aiResponse.correction) textMessage += `💡 *Feedback do Professor:*\n_${aiResponse.correction}_\n\n`;
    if (aiResponse.spoken_response) textMessage += `🗣️ *O que eu disse:*\n${aiResponse.spoken_response}`;

    if (textMessage) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, { 
        chat_id: chatId, text: textMessage, parse_mode: 'Markdown'
      });
    }

    // E. TTS BILÍNGUE: Envia o áudio fundindo os dois sotaques
    if (isVoiceMessage && (aiResponse.spoken_response || aiResponse.correction)) {
      try {
          // Chama a nossa nova função bilíngue enviando os dois textos
          const aiAudioBuffer = await AIService.generateBilingualTTS(
              aiResponse.spoken_response, 
              userData.targetLanguage, 
              aiResponse.correction
          );
          
          if (aiAudioBuffer) {
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('audio', aiAudioBuffer, { filename: 'prose_ia.mp3', contentType: 'audio/mpeg' });

            await axios.post(`${TELEGRAM_API}/sendAudio`, form, { headers: form.getHeaders() });
          }
      } catch (ttsErr) {
          console.warn("⚠️ Erro detalhado do TTS:", ttsErr.response ? ttsErr.response.data : ttsErr.message);
      }
    }