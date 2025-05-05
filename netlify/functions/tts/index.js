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

// Google Cloud認証情報を環境変数から取得する
function getCredentials() {
  console.log("認証情報を取得中...");
  
  // 環境変数からJSONを取得
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log("GOOGLE_CREDENTIALS_JSON環境変数を使用");
    
    try {
      const content = process.env.GOOGLE_CREDENTIALS_JSON;
      
      // Base64かどうかをチェック
      // Base64の特徴: 基本的に英数字と+/=だけで構成される
      const isBase64 = /^[A-Za-z0-9+/=]+$/.test(content);
      
      if (isBase64) {
        console.log("Base64形式として処理");
        try {
          // Base64をデコード
          const decodedContent = Buffer.from(content, 'base64').toString('utf8');
          
          // JSONとして解析
          return JSON.parse(decodedContent);
        } catch (e) {
          console.error("Base64デコードまたはJSON解析エラー:", e.message);
          throw new Error("Base64デコードまたはJSON解析に失敗しました");
        }
      } else {
        // 通常のJSONとして解析
        console.log("通常のJSON形式として処理");
        return JSON.parse(content);
      }
    } catch (e) {
      console.error("認証情報の解析エラー:", e.message);
      throw new Error("認証情報のJSON解析に失敗: " + e.message);
    }
  }
  
  // 他の環境変数をチェック
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log("GOOGLE_APPLICATION_CREDENTIALS環境変数を検出");
    const content = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    // JSONらしき形式かチェック
    if (content.startsWith('{') && content.includes('"type"')) {
      try {
        // JSONとして解析
        return JSON.parse(content);
      } catch (e) {
        console.error("JSON解析エラー:", e.message);
      }
    }
    
    // ファイルパスと判断
    throw new Error("ファイルパスではなくJSON文字列が必要です");
  }
  
  // どの環境変数も見つからない
  throw new Error("認証情報が見つかりません。GOOGLE_CREDENTIALS_JSON環境変数を設定してください");
}

// TTSクライアントの初期化
function getClient() {
  try {
    console.log("TTSクライアント初期化開始");
    
    // 認証情報を取得
    const credentials = getCredentials();
    
    // 既存の環境変数をバックアップして削除（副作用防止）
    const originalValue = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    // クライアント初期化
    const client = new textToSpeech.TextToSpeechClient({ credentials });
    
    // 環境変数を復元
    if (originalValue !== undefined) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = originalValue;
    }
    
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
    console.log("テキスト処理完了:", fixed.substring(0, 30) + "...");

    // SSML形式に変換
    const ssmlText = `<speak>${fixed}</speak>`;

    try {
      // TTSクライアント取得
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
      console.log("音声データエンコード完了:", audioContent.length, "バイト");

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ audioUrl })
      };
    } catch (ttsError) {
      console.error("TTS API呼び出しエラー:", ttsError.message);
      
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
    console.error("TTS処理エラー:", e.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "TTS処理失敗", 
        details: e.message 
      })
    };
  }
};