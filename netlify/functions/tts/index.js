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

// Base64文字列かどうかを厳密に判定する関数
function isBase64(str) {
  // Base64は4の倍数の長さで、特定の文字のみを含む
  if (str.length % 4 !== 0) return false;
  // 正規表現パターン（Base64文字セット + 適切なパディング）
  return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
}

// Google Cloud認証情報の設定 - 環境変数から直接取得
function getCredentials() {
  // まず新しい環境変数名をチェック
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log("GOOGLE_CREDENTIALS_JSON環境変数を使用");
    
    // 内容を解析
    try {
      const content = process.env.GOOGLE_CREDENTIALS_JSON;
      
      // Base64エンコードされているか確認
      if (isBase64(content)) {
        try {
          const decoded = Buffer.from(content, 'base64').toString('utf8');
          return JSON.parse(decoded);
        } catch (e) {
          console.error("Base64デコードまたはJSON解析エラー");
          throw new Error("認証情報のBase64デコードまたはJSON解析に失敗: " + e.message);
        }
      } else {
        // プレーンJSONとして解析
        return JSON.parse(content);
      }
    } catch (e) {
      console.error("認証情報JSON解析エラー");
      throw new Error("認証情報のJSON解析に失敗: " + e.message);
    }
  }
  
  // 古い環境変数名も一応チェック
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log("GOOGLE_APPLICATION_CREDENTIALS環境変数を検出 - 警告: この変数名は非推奨");
    
    const content = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    // JSONっぽい文字列かチェック
    if (content.trim().startsWith('{') && content.trim().endsWith('}')) {
      try {
        return JSON.parse(content);
      } catch (e) {
        console.error("JSON解析エラー");
        throw new Error("GOOGLE_APPLICATION_CREDENTIALSの内容をJSONとして解析できません");
      }
    } else {
      // ファイルパスと判断
      throw new Error("GOOGLE_APPLICATION_CREDENTIALSがファイルパスのようです。Netlify環境では直接JSONを指定してください");
    }
  }
  
  // 認証情報が見つからない
  throw new Error("Google Cloud認証情報が見つかりません。GOOGLE_CREDENTIALS_JSON環境変数を設定してください");
}

// TTSクライアント初期化 - 環境変数の副作用を回避
function getClient() {
  try {
    // 認証情報を取得
    const credentials = getCredentials();
    
    // 一時的に環境変数を退避して削除
    const origValue = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    // クライアント初期化
    const client = new textToSpeech.TextToSpeechClient({ credentials });
    
    // 環境変数を復元（他のライブラリへの影響を防ぐ）
    if (origValue !== undefined) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = origValue;
    }
    
    return client;
  } catch (error) {
    console.error('TTS Client初期化エラー:', error.message);
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
      console.log("TTSクライアント初期化開始");
      const client = getClient();
      console.log("TTSクライアント初期化成功");

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