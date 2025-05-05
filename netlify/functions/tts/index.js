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

// 単純化したTTSクライアント初期化
function getClient() {
  try {
    console.log("TTSクライアント初期化 - 単純化アプローチ");
    
    // 重要: 既存の環境変数を削除（他のライブラリの干渉を防ぐ）
    const originalValue = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    // コンフィグをログ（機密情報を含まないように注意）
    console.log("環境変数の存在確認:");
    console.log("- GOOGLE_CREDENTIALS_JSON:", !!process.env.GOOGLE_CREDENTIALS_JSON);
    console.log("- GOOGLE_APPLICATION_CREDENTIALS (削除前):", !!originalValue);
    
    // 認証情報JSONの解析を試みる
    let credentials;
    
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
      try {
        credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        console.log("JSON直接解析成功");
      } catch (e) {
        console.log("直接解析エラー、プレーンテキスト解析に移行");
        try {
          // Base64解析を試みる（try/catchではなく条件分岐）
          if (/^eyJ/.test(process.env.GOOGLE_CREDENTIALS_JSON)) {
            console.log("JSONらしき形式を検出、直接使用");
            credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
          } else {
            // Base64デコードを試みる
            const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_JSON, 'base64').toString('utf8');
            console.log("Base64デコード完了、JSON解析を試みる");
            credentials = JSON.parse(decoded);
          }
        } catch (e2) {
          console.error("解析エラー:", e2.message);
          throw new Error("認証情報の解析に失敗しました: " + e2.message);
        }
      }
    } else if (originalValue) {
      // バックアップとして元の環境変数を使用（JSONのみ）
      if (originalValue.trim().startsWith('{')) {
        try {
          credentials = JSON.parse(originalValue);
        } catch (e) {
          throw new Error("GOOGLE_APPLICATION_CREDENTIALSのJSON解析に失敗: " + e.message);
        }
      } else {
        throw new Error("ファイルパスではなくJSON文字列が必要です");
      }
    } else {
      throw new Error("Google Cloud認証情報が見つかりません");
    }
    
    // クライアント初期化（環境変数依存なし）
    const client = new textToSpeech.TextToSpeechClient({ credentials });
    
    // 環境変数を復元（他のライブラリへの影響を防ぐ）
    if (originalValue) {
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
    console.log("テキスト処理完了 (長さ:", fixed.length, "文字)");

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
      console.log("音声データエンコード完了 (サイズ:", Math.round(audioContent.length / 1024), "KB)");

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ audioUrl })
      };
    } catch (ttsError) {
      console.error('TTS API呼び出しエラー:', ttsError.message);
      
      if (ttsError.message.includes('Authentication')) {
        console.error('認証エラーの可能性があります。環境変数を確認してください');
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ 
            text: fixed,
            error: "Google Cloud認証エラー",
            errorDetail: ttsError.message 
          })
        };
      }
      
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