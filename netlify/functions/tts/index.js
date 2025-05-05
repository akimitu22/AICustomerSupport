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

// 元コードからの流用: 認証情報処理
function loadGoogleCredentials() {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  if (!env) return null;

  // 1) そのまま JSON
  if (env.trim().startsWith('{')) {
    console.log("JSON形式の認証情報を使用");
    return JSON.parse(env);
  }

  // 2) Base64-encoded JSON
  try {
    console.log("Base64デコードを試行");
    const decoded = Buffer.from(env, 'base64').toString('utf8');
    if (decoded.trim().startsWith('{')) {
      console.log("Base64デコード成功、JSON解析");
      return JSON.parse(decoded);
    }
  } catch (e) {
    console.log("Base64デコード失敗", e.message);
  }

  // 3) ファイルパスの場合
  console.log("ファイルパスと見なされる可能性があります:", env.substring(0, 20) + "...");
  return null;
}

function getClient() {
  try {
    // 環境変数を一時退避
    const originalValue = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    // 認証情報の取得
    const credentials = loadGoogleCredentials();
    
    // クライアント初期化
    const client = credentials
      ? new textToSpeech.TextToSpeechClient({ credentials })
      : new textToSpeech.TextToSpeechClient();
    
    console.log("TTSクライアント初期化成功");
    return client;
  } catch (error) {
    console.error("TTSクライアント初期化エラー:", error.message);
    throw error;
  }
}

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
      console.error("JSONパースエラー:", parseError.message);
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
      console.error('TTS API呼び出しエラー:', ttsError.message);
      
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
    console.error('TTS一般エラー:', e.message);
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