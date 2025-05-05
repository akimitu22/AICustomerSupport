const textToSpeech = require('@google-cloud/text-to-speech');
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function getClient() {
  try {
    console.log("TTSクライアント初期化 - Base64認証情報を使用");

    const b64 = process.env.GOOGLE_CREDENTIALS_B64;
    if (!b64) throw new Error('GOOGLE_CREDENTIALS_B64 is not set');

    const credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const client = new textToSpeech.TextToSpeechClient({ credentials });

    console.log("TTSクライアント初期化成功");
    return client;
  } catch (error) {
    console.error("TTSクライアント初期化エラー:", error.message);
    throw error;
  }
}

exports.handler = async function (event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const body = JSON.parse(event.body);
    const text = body.text;
    console.log("TTSリクエスト受信:", text);

    const client = getClient();

    const [response] = await client.synthesizeSpeech({
      input: { text },
      voice: {
        languageCode: 'ja-JP',
        ssmlGender: 'NEUTRAL'
      },
      audioConfig: {
        audioEncoding: 'MP3'
      }
    });

    const audioContent = response.audioContent;
    const base64Audio = audioContent.toString('base64');

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audioContent: base64Audio,
        text
      })
    };
  } catch (error) {
    console.error("TTS エラー:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "音声合成できませんでした",
        errorDetail: error.message || '未知のエラー'
      })
    };
  }
};
