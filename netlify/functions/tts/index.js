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

// Google Cloud認証情報の設定 - Netlify環境変数から直接取得
const getClient = () => {
  try {
    console.log("環境変数の確認:");
    // 利用可能な環境変数の一覧を表示（キーのみ）
    console.log("利用可能な環境変数キー:", Object.keys(process.env).filter(key => 
      key.includes('GOOGLE') || key.includes('APPLICATION') || key.includes('CREDENTIALS') || key.includes('KEY')
    ));
    
    // Netlify環境変数からJSONを直接取得
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      console.log("GOOGLE_APPLICATION_CREDENTIALS_JSON が見つかりました");
      const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      return new textToSpeech.TextToSpeechClient({ credentials });
    }
    
    // 他の可能性のある環境変数名をチェック
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log("GOOGLE_APPLICATION_CREDENTIALS が見つかりました");
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS.startsWith('{')) {
        // JSONとして解析可能
        const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
        return new textToSpeech.TextToSpeechClient({ credentials });
      } else {
        // ファイルパスとして処理
        console.log("GOOGLE_APPLICATION_CREDENTIALSはファイルパスのようです");
        // Netlify環境ではファイルパスは使用できないので、エラーをスローする
        throw new Error("ファイルパスではなくJSON文字列が必要です");
      }
    }
    
    // その他の可能性のある名前をチェック
    if (process.env.GOOGLE_CREDENTIALS) {
      console.log("GOOGLE_CREDENTIALS が見つかりました");
      const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      return new textToSpeech.TextToSpeechClient({ credentials });
    }
    
    if (process.env.GCP_CREDENTIALS) {
      console.log("GCP_CREDENTIALS が見つかりました");
      const credentials = JSON.parse(process.env.GCP_CREDENTIALS);
      return new textToSpeech.TextToSpeechClient({ credentials });
    }
    
    // 認証情報が見つからない場合
    console.error("認証情報がありません。環境変数を確認してください。");
    throw new Error("Google Cloud認証情報が環境変数に設定されていません");
  } catch (error) {
    console.error('TTS Client初期化エラー:', error);
    console.error('エラースタック:', error.stack);
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
      console.log("音声データエンコード完了、長さ:", audioContent.length);

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
    console.error('スタックトレース:', e.stack);
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