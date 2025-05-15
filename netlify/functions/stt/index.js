// netlify/functions/stt/index.js
import FormData from 'form-data';

/* ───────── STT用プロンプト情報 ───────── */
const STT_PROMPT = {
  instructions: `
    音声認識に関する指示:
    - 「ホザナ」の発音を正しく認識し、「幼い」や「保産が」などに誤変換しないでください
    - 「幼い幼稚園」や「ほざな幼稚園」というのは存在しないので、必ず「ホザナ幼稚園」と変換してください
    - 「園児数」は「えんじすう」と認識し、「延字数」などに誤変換しないでください
    - 「預かり保育」は正しく認識するようにしてください
    - 「願書」は「顔症」や「眼症」などに誤変換しないでください.
    - 「えんちょう」や「えんちょうせんせい」は「園長」や「園長先生」の意味で、「延長先生」という言葉は存在しません。「延長保育」を意図する場合は「えんちょう」とは言わず、「えんちょうほいく」と言ってきますので、間違わないでください
    - 「副園長」の発音を正しく認識し、「福園町」や「福園長」などに誤変換しないでください
    - すべての音声をホザナ幼稚園関連の言葉と認識して正しく変換してください
  `
};

// その他の定数や関数は同じなので省略...

/* ───────── Whisper API 呼び出し（リトライロジック付き） ───────── */
async function callWhisperAPIWithRetry(audioBuffer, format, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const formData = new FormData();
      formData.append('file', audioBuffer, {
        filename: 'audio.webm',
        contentType: format || 'audio/webm'
      });
      formData.append('model', 'whisper-1');
      
      // プロンプトを追加
      formData.append('prompt', KINDERGARTEN_PROMPT);

      // formDataからバイナリデータを取得
      const formDataBuffer = await new Promise((resolve) => {
        let chunks = [];
        formData.on('data', (chunk) => {
          chunks.push(chunk);
        });
        formData.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      });

      // formDataのヘッダーを取得
      const formHeaders = formData.getHeaders();
      
      // fetchで送信
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formHeaders
        },
        body: formDataBuffer
      });

      if (!response.ok) {
        throw new Error(`API responded with status ${response.status}`);
      }
      
      const data = await response.json();
      return { data };
      
    } catch (error) {
      console.error(`Attempt ${attempt + 1}/${maxRetries} failed:`, error.message);
      
      // 最後の試行で失敗した場合はエラーをスロー
      if (attempt === maxRetries - 1) {
        console.error("All retry attempts failed");
        throw error;
      }
      
      // 指数バックオフで待機
      const delay = 1000 * Math.pow(2, attempt);
      console.log(`Waiting ${delay}ms before next attempt...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/* ───────── 共通レスポンス整形 ───────── */
function formatResponse(statusCode, headers, data = {}, error = null) {
  const body = { success: statusCode >= 200 && statusCode < 300, ...data };
  if (error) body.error = error;
  if (!body.text && body.stt?.text) body.text = body.stt.text;
  if (!body.text?.trim()) {
    body.success = false;
    body.error = body.error || '認識されたテキストが空です';
    body.text = '認識エラー';
    statusCode = 422;
  }
  return { statusCode, headers, body: JSON.stringify(body) };
}

/* ───────── Lambda ハンドラ ───────── */
export const handler = async (event) => {
  // 未処理の例外をキャッチするハンドラを追加
  process.on('unhandledRejection', (error) => {
    console.error('Unhandled Promise Rejection:', error);
  });
  
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
  });

  // STT_PROMPTの指示に従ってリクエストを処理
  console.log(`Processing STT request based on prompt instructions: ${STT_PROMPT.instructions.split('\n')[1]}`);
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return formatResponse(405, headers, {}, 'Method Not Allowed');

  try {
    if (!event.headers['content-type']?.includes('application/json'))
      return formatResponse(400, headers, {}, 'JSON required');

    const req = JSON.parse(event.body || '{}');
    
    // テストモード対応（オプション）
    if (req.test === true) {
      return formatResponse(200, headers, {
        text: "テストモード：音声認識機能は正常に動作しています",
        originalText: "テストモード：音声認識機能は正常に動作しています",
        timestamp: Date.now()
      });
    }
    
    if (!req.audio) return formatResponse(400, headers, {}, 'No audio data');
    if (!process.env.OPENAI_API_KEY) return formatResponse(500, headers, {}, 'API key missing');

    /* 音声サイズ検証 */
    const audioBuffer = Buffer.from(req.audio, 'base64');
    if (audioBuffer.length / (1024 * 1024) > 9.5)
      return formatResponse(413, headers, {}, 'Audio too large (>10 MB)');

    /* Whisper 呼び出し（リトライロジック付き） */
    const resp = await callWhisperAPIWithRetry(audioBuffer, req.format);
    let recognized = resp.data.text || '';
    recognized = stripSpeakerLabel(recognized);        // ← 話者ラベルを除去
    const corrected = correctKindergartenTerms(recognized);

    return formatResponse(200, headers, {
      text: corrected,
      originalText: recognized,
      timestamp: Date.now()
    });

  } catch (err) {
    console.error("STT処理エラー:", err);
    console.error("エラースタックトレース:", err.stack);
    
    const status = err.response?.status || 500;
    const detail = err.response?.data || err.message;
    return formatResponse(status, headers, { details: detail }, 'Whisper API error');
  }
};