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

// サービスアカウント初期化
function initServiceAccount() {
  try {
    // 環境変数から認証情報を直接取得
    return require('./service-account.json');
  } catch (error) {
    console.error("サービスアカウント読み込みエラー:", error);
    throw new Error("サービスアカウント設定エラー: " + error.message);
  }
}

// TTSクライアント初期化
function getClient() {
  // 環境変数を一時的に退避
  const origValue = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  
  try {
    // サービスアカウント情報を取得
    const credentials = initServiceAccount();
    
    // クライアント初期化
    const client = new textToSpeech.TextToSpeechClient({ credentials });
    
    // 環境変数を復元
    if (origValue) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = origValue;
    }
    
    return client;
  } catch (error) {
    // 環境変数を復元
    if (origValue) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = origValue;
    }
    
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
  
  try {
    // リクエストのパース
    let requestBody;
    try {
      requestBody = JSON.parse(event.body || '{}');
    } catch (parseError) {
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
          error: "テキストが空です"
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
        headers,
        body: JSON.stringify({ audioUrl })
      };
    } catch (ttsError) {
      // テキストのみを返す
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