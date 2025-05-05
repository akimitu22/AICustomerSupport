const textToSpeech = require('@google-cloud/text-to-speech');
const util = require('util');

let client;
try {
  client = new textToSpeech.TextToSpeechClient();
} catch (error) {
  console.error('Failed to initialize TTS client:', error);
}

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const { text } = JSON.parse(event.body);
    if (!text?.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'empty' })
      };
    }

    // テキストを修正
    const fixed = text
      .replace(/副園長/g, 'ふくえんちょう')
      .replace(/入園/g, 'にゅうえん')
      .replace(/園長/g, 'えんちょう')
      .replace(/幼稚園/g, 'ようちえん')
      .replace(/園庭/g, 'えんてい')
      .replace(/園児/g, 'えんじ')
      .replace(/他園/g, 'たえん')
      .replace(/園/g, 'えん');

    // SSML形式に変換
    const ssmlText = `<speak>${fixed}</speak>`;

    // Google TTSにリクエスト
    const [response] = await client.synthesizeSpeech({
      input: { ssml: ssmlText },
      voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.15 }
    });

    // Base64エンコード
    const audioContent = Buffer.from(response.audioContent).toString('base64');
    const audioUrl = `data:audio/mpeg;base64,${audioContent}`;

    return {
      statusCode: 200,
      body: JSON.stringify({ audioUrl })
    };
  } catch (e) {
    console.error('TTS error:', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'TTS失敗' })
    };
  }
};