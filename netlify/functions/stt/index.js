// netlify/functions/stt/index.js
import FormData from 'form-data';
// 必要に応じてBufferを明示的にインポート
import { Buffer } from 'buffer';

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

/* ───────── 誤変換辞書 ───────── */
const speechCorrectionDict = {
  /* ホザナ */
  'ほざな':  'ホザナ',
  'おだな':  'ホザナ',
  'おさない':'ホザナ',
  '幼い':    'ホザナ',
  '保産が':  'ホザナ',
  '小棚':    'ホザナ',
  '児玉':    'ホザナ',

  /* 預かり保育 */
  'あつかいほいく': '預かり保育',
  'あつがりほいく': '預かり保育',
  '扱い保育':       '預かり保育',
  '暑がり保育':     '預かり保育',

  /* 願書 */
  'がんしょう': '願書',
  'かんしょう': '願書',
  '干渉':       '願書',
  '眼症':       '願書',
  '顔症':       '願書',
  '元祥':       '願書',
  'がんしょ':   '願書',
  'かんしょ':   '願書',
  '幹書':       '願書',
  'みきしょ':   '願書',

  /* モンテッソーリゆれ & 誤認識 */
  'モンテストーリー':       'モンテッソーリ',
  'モンテストーリー教育':   'モンテッソーリ教育',
  'モンテソーリ':           'モンテッソーリ',
  'モンテソリー':           'モンテッソーリ',
  'マンテッソーリ':         'モンテッソーリ',
  'モンテッソリ':           'モンテッソーリ',

   /* 園長／延長保育 の曖昧語対策 */
  'えんちょうほいく': '延長保育',
  'えんちょう ほいく':'延長保育',
  '延長先生':          '園長先生', 
  '園長先生':          'えんちょうせんせい', 
  'えんちょうせんせい':'園長先生', 
  '園長':       　　　 'えんちょう', 
  'えんちょう':        '園長', 
  'えんなが':       　 'えんちょう',    

  /* 副園長の誤変換 */
  'ふくえんちょう': '副園長',
  '福園町': 　　　　'副園長',
  'ふくえんまち': 　'副園長',
  '福園町先生': 　　'副園長先生',


  /* 園児数の誤変換対策（重要：追加・強化） */
  'えんじ':          '園児',
  'えんじすう':      '園児数',
  'えんじかず':      '園児数',
  '演じ数':          '園児数',
  '延字数':          '園児数',
  '延児数':          '園児数',
  '園字数':          '園児数',
  '園時数':          '園児数',
  '縁児数':          '園児数',
  'そうえんじすう':  '総園児数',
  '総演じ数':        '総園児数',
  '総延字数':        '総園児数',
  '総延児数':        '総園児数',
  '総園字数':        '総園児数',
  '総園時数':        '総園児数',

  /* その他 */
  'つうえん':       '通園',
  'こうえん':       '降園',
  'とうえん':       '登園'
};

/* ───────── Whisper 用プロンプト ───────── */
const KINDERGARTEN_PROMPT =
  '===== 音声認識コンテキスト：ホザナ幼稚園 入園案内 =====\n' +
  'この会話はホザナ幼稚園の入園手続き・モンテッソーリ教育に関する Q&A です。\n\n' +
  '===== 用語ガイド =====\n' +
  '・「ホザナ幼稚園」は固有名詞です（誤認例: おだな／おさない）。\n' +
  '・「預かり保育」は園のサービス名です（誤認例: あつかりほいく）。\n' +
  '・「願書」は入園書類名です（誤認例: がんしょう）。\n' +
  '・「モンテッソーリ教育」は頻出教育法です（誤認例: モンテストーリー）。\n' +
  '・「園児数」は幼稚園の在籍人数を表す用語です（誤認例: 延字数／園時数）。\n\n' +
  '・「園長」は園を運営する校長職です（誤認例: 延長）。\n' +
  '・「延長保育」は放課後の預かりサービスです（誤認例: 園長保育）。\n\n' +
  '===== 出力上の禁止事項 =====\n' +
  '※ 出力テキストに【名前】のような話者ラベルや Speaker タグを付けないでください。\n';

/* ───────── 前処理：話者ラベル除去 ───────── */
function stripSpeakerLabel(text) {
  return text.replace(
    /^\s*(?:【[^】]{1,12}】|\[[^\]]{1,12}\]|\([^\)]{1,12}\)|[^\s]{1,12}[：:])\s*/u,
    ''
  );
}

/* ───────── 誤変換補正（STT_PROMPTに基づく実装） ───────── */
function correctKindergartenTerms(text) {
  let corrected = text;

  /* 基本辞書置換 */
  for (const [wrong, right] of Object.entries(speechCorrectionDict)) {
    corrected = corrected.replace(new RegExp(wrong, 'g'), right);
  }

  /* 園児数に関する特別チェック（STT_PROMPTの指示に対応） */
  // 「えんじすう」「園児数」に関する特別処理
  corrected = corrected
    .replace(/えん(?:じ|字|時)(?:すう|数)/g, '園児数')
    .replace(/延(?:じ|字|児)(?:すう|数)/g, '園児数')
    .replace(/園(?:字|時)(?:すう|数)/g, '園児数')
    .replace(/縁児(?:すう|数)/g, '園児数');

  /* 円⇄園 誤変換 */
  corrected = corrected
    .replace(/(\d+)([万千百十]?)円/g, '$1$2円')          // 数字＋円はそのまま
    .replace(/([^\d０-９万千百十])円/g, '$1園');            // それ以外＋円→園

  /* しますから？→しますか？ */
  corrected = corrected.replace(/しますから\?/g, 'しますか?');

  /* ひらがなの ようちえん → 幼稚園 */
  corrected = corrected.replace(/ようちえん/g, '幼稚園');

  // プロンプトの指示に基づいた後処理
  corrected = postProcessBasedOnPrompt(corrected);

  return corrected;
}

/* ───────── プロンプトに基づく後処理 ───────── */
function postProcessBasedOnPrompt(text) {
  // STT_PROMPTの指示に基づく処理を実装
  // プロンプト: 「園児数」は「えんじすう」と認識し、「延字数」などに誤変換しない
  let result = text;
  
  // 残った可能性のある「園児数」の誤記を修正
  const possibleMistakes = [
    '延字数', '延児数', '園字数', '園時数', '縁児数',
    '総延字数', '総延児数', '総園字数', '総園時数'
  ];
  
  possibleMistakes.forEach(mistake => {
    const regex = new RegExp(mistake, 'g');
    result = result.replace(regex, mistake.startsWith('総') ? '総園児数' : '園児数');
  });
  
  return result;
}

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
      
      // プロンプトを追加 - 修正: KINDERGARTEN_PROMPTを使用
      formData.append('prompt', KINDERGARTEN_PROMPT);

      // 修正: formDataからバイナリデータを取得する方法を変更
      const formDataBuffer = Buffer.from(formData.getBuffer());

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