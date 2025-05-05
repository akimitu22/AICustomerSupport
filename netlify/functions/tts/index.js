// netlify/functions/tts/index.js
const textToSpeech = require('@google-cloud/text-to-speech');

// 日本語読み方の置換辞書
const pronunciationDictionary = {
  '副園長': 'ふくえんちょう',
  '入園': 'にゅうえん',
  '園長': 'えんちょう',
  '幼稚園': 'ようちえん',
  '園庭': 'えんてい',
  '園児': 'えんじ',
  '他園': 'たえん',
  '園': 'えん'
};

// テキストの読み方を修正する関数
function fixPronunciation(text) {
  let fixed = text;
  for (const [word, pronunciation] of Object.entries(pronunciationDictionary)) {
    const regex = new RegExp(word, 'g');
    fixed = fixed.replace(regex, pronunciation);
  }
  return fixed;
}

// Google Cloud認証情報の設定
const getClient = () => {
  try {
    // 環境変数に設定されたJSONを直接使用
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      console.log("GOOGLE_APPLICATION_CREDENTIALS_JSONから認証情報を取得");
      const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      return new textToSpeech.TextToSpeechClient({ credentials });
    }
    
    // 認証情報が見つからない場合
    console.error("認証情報がありません。環境変数を確認してください。");
    throw new Error("Google Cloud認証情報が見つかりません");
  } catch (error) {
    console.error('TTS Client初期化エラー:', error);
    throw error;
  }
};

exports.handler = async function(event, context) {
  // CORSヘッダー
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  
  // OPTIONSリクエスト
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: "" };
  }
  
  console.log("TTS関数が呼び出されました");
  
  try {
    // リクエストのパース
    let requestBody;
    try {
      requestBody = JSON.parse(event.body || '{}');
    } catch (parseError) {
      console.error("JSONパースエラー:", parseError);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "JSONパースエラー",
          details: parseError.message
        })
      };
    }
    
    const { text } = requestBody;
    if (!text?.trim()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: "テキストが空です",
          details: "音声合成するテキストを入力してください"
        })
      };
    }

    // テキストを修正
    const fixed = fixPronunciation(text);
    console.log("変換後テキスト:", fixed.substring(0, 50) + "...");

    // SSML形式に変換
    const ssmlText = `<speak>${fixed}</speak>`;

    try {
      // クライアントの初期化
      const client = getClient();

      // Google TTSにリクエスト
      console.log("TTS APIリクエスト送信");
      const [response] = await client.synthesizeSpeech({
        input: { ssml: ssmlText },
        voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.15 }
      });
      console.log("TTS API応答受信成功");

      // Base64エンコード
      const audioContent = Buffer.from(response.audioContent).toString('base64');
      const audioUrl = `data:audio/mpeg;base64,${audioContent}`;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ audioUrl })
      };
    } catch (ttsError) {
      console.error('TTS固有エラー:', ttsError);
      console.error('スタックトレース:', ttsError.stack);
      
      // フォールバック：テキストのみを返す
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          text: fixed,
          error: "音声合成できませんでした",
          errorDetail: ttsError.message 
        })
      };
    }
  } catch (e) {
    console.error('TTS一般エラー:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'TTS処理失敗', 
        details: e.message 
      })
    };
  }
};