// netlify/functions/stt/index.js
import axios from 'axios';
import FormData from 'form-data';

/* ───────── STT用プロンプト情報 ───────── */
const STT_PROMPT = {
  instructions: `
    音声認識に関する指示:
    - 「ホザナ」を正確に認識し、「幼い」「保産が」「おだな」「おさない」「小棚」などに誤変換しないこと
    - 「幼い幼稚園」や「ほざな幼稚園」などの誤認識表現は「ホザナ幼稚園」に統一すること
    - 「園児数」を「えんじすう」として認識し、「延字数」「園時数」「演じ数」などに誤変換しないこと
    - 「預かり保育」を正確に認識し、「扱い保育」「暑がり保育」に誤変換しないこと
    - 「願書」は「がんしょ」と正しく認識すべきだが、AIが「がんしょう」と誤認識して「顔症」「眼症」などに誤変換する問題を修正すること
    - 「副園長」を正確に認識し、「福園町」「ふくえんまち」「そえんちょう」などに誤変換しないこと
    - 「モンテッソーリ」を正確に認識し、「モンテストーリー」「モンテソーリ」などの誤表記を修正すること
    - 「通園」「登園」「降園」を正確に識別すること
    - すべての音声をホザナ幼稚園関連の文脈で解釈し、適切な幼稚園用語に変換すること
  `
};

/* ───────── 誤変換辞書 ───────── */
// 辞書の構成を[間違った表記]: [正しい表記]の形式で整理（優先度順）
const speechCorrectionDict = {
  /* 幼稚園名関連 */
  'ほざな幼稚園': 'ホザナ幼稚園',
  'ほざな': 'ホザナ',
  '幼い幼稚園': 'ホザナ幼稚園',
  'おだな': 'ホザナ',
  'おさない': 'ホザナ',
  '幼い': 'ホザナ',
  '保産が': 'ホザナ',
  '小棚': 'ホザナ',
  '児玉': 'ホザナ',
  'ようちえん': '幼稚園',

  /* 副園長関連 */
  'ふくえんちょう': '副園長',
  '福園町': '副園長',
  'ふくえんまち': '副園長',
  'そえんちょう': '副園長',
  '福園町先生': '副園長先生',
  '副園町': '副園長',
  
  /* 園長関連 */
  'えんちょう先生': '園長先生',
  'えんちょうせんせい': '園長先生',
  
  /* 預かり保育関連 */
  'あずかり保育': '預かり保育',
  'あつかいほいく': '預かり保育',
  'あつがりほいく': '預かり保育',
  '扱い保育': '預かり保育',
  '暑がり保育': '預かり保育',
  'えんちょうほいく': '延長保育',
  'えんちょう保育': '延長保育',

  /* 願書関連 - 「がんしょ」が正しい読み、AIが「がんしょう」と誤認識する問題に対処 */
  'がんしょう': '願書', // AIが「がんしょ」を「がんしょう」と誤認識する場合の修正
  'かんしょう': '願書',
  '干渉': '願書',
  '眼症': '願書',
  '顔症': '願書',
  '元祥': '願書',
  'がんしょ': '願書', // 正しい読み方
  'かんしょ': '願書',
  '幹書': '願書',
  'みきしょ': '願書',
  '入園願書': '入園願書',
  'にゅうえんがんしょ': '入園願書',
  
  /* モンテッソーリ関連 */
  'モンテストーリー': 'モンテッソーリ',
  'モンテストーリー教育': 'モンテッソーリ教育',
  'モンテソーリ': 'モンテッソーリ',
  'モンテソリー': 'モンテッソーリ',
  'マンテッソーリ': 'モンテッソーリ',
  'モンテッソリ': 'モンテッソーリ',

  /* 園児数関連 */
  'えんじすう': '園児数',
  'えんじかず': '園児数',
  '演じ数': '園児数',
  '延字数': '園児数',
  '延児数': '園児数',
  '園字数': '園児数',
  '園時数': '園児数',
  '縁児数': '園児数',
  'そうえんじすう': '総園児数',
  '総演じ数': '総園児数',
  '総延字数': '総園児数',
  '総延児数': '総園児数',
  '総園字数': '総園児数',
  '総園時数': '総園児数',

  /* 通園・登園・降園関連 */
  'つうえん': '通園',
  'こうえん': '降園',
  'とうえん': '登園',
  'とうえい': '登園',
  'こうえい': '降園',
  
  /* その他幼稚園用語 */
  'にゅうえん': '入園',
  'にゅうえんしき': '入園式',
  'そつえん': '卒園',
  'そつえんしき': '卒園式',
  'うんどうかい': '運動会',
  'うんどう会': '運動会',
  'たいいく': '体育',
  'きゅうしょく': '給食',
  'ほけん': '保健',
  'ほいく': '保育',
  'ほいくりょう': '保育料'
};

/* ───────── Whisper 用プロンプト ───────── */
const KINDERGARTEN_PROMPT =
  '===== 音声認識コンテキスト：ホザナ幼稚園 入園案内 =====\n' +
  'この会話はホザナ幼稚園の入園手続き・モンテッソーリ教育に関する Q&A です。\n\n' +
  '===== 用語ガイド =====\n' +
  '・「ホザナ幼稚園」は固有名詞です（誤認例: おだな／おさない／幼い）。\n' +
  '・「えんちょう」は文脈によって「園長」または「延長保育」を指します。\n' +
  '・「副園長」は「ふくえんちょう」と読み、「福園町」「そえんちょう」は誤りです。\n' +
  '・「預かり保育」は園のサービス名です（誤認例: あつかりほいく）。\n' +
  '・「願書」は「がんしょ」と読む入園書類名です（誤認識例: 「がんしょう」と認識され、眼症／顔症に誤変換）。\n' +
  '・「モンテッソーリ教育」は教育法です（誤認例: モンテストーリー）。\n' +
  '・「園児数」は「えんじすう」と読み、決して「えんじかず」と読まず、「延字数/園時数」などではありません。\n\n' +
  '===== 出力上の禁止事項 =====\n' +
  '※ 出力テキストに【名前】のような話者ラベルや Speaker タグを付けないでください。\n' +
  '※ すべての内容を幼稚園に関する文脈で解釈してください。\n';

/* ───────── 前処理：話者ラベル除去 ───────── */
function stripSpeakerLabel(text) {
  return text.replace(
    /^\s*(?:【[^】]{1,12}】|\[[^\]]{1,12}\]|\([^\)]{1,12}\)|[^\s]{1,12}[：:])\s*/u,
    ''
  );
}

/* ───────── 誤変換補正関数 ───────── */
function correctKindergartenTerms(text) {
  let corrected = text;

  /* 基本辞書置換 - オブジェクトのキーの長さで降順ソートして適用（より長いパターンを優先） */
  const sortedEntries = Object.entries(speechCorrectionDict)
    .sort((a, b) => b[0].length - a[0].length);
    
  for (const [wrong, right] of sortedEntries) {
    // 単語境界を考慮した置換（部分一致を避ける）
    const pattern = new RegExp(`\\b${wrong}\\b|${wrong}`, 'gi');
    corrected = corrected.replace(pattern, right);
  }

  /* 園児数に関する特別な処理 */
  corrected = corrected
    .replace(/えん(?:じ|字|時)(?:すう|数)/g, '園児数')
    .replace(/延(?:じ|字|児)(?:すう|数)/g, '園児数')
    .replace(/園(?:字|時)(?:すう|数)/g, '園児数')
    .replace(/縁児(?:すう|数)/g, '園児数');

  /* 「円」と「園」の誤変換対応 - 数字の後の円はそのままに */
  corrected = corrected
    .replace(/(\d+)([万千百十]?)円/g, '$1$2円')  // 数字＋円はそのまま
    .replace(/([^\d０-９万千百十])円/g, '$1園')  // それ以外＋円→園
    .replace(/円児/g, '園児')                   // 円児→園児
    .replace(/円長/g, '園長');                  // 円長→園長

  /* 文脈に応じた補正 */
  corrected = corrected
    .replace(/しますから\?/g, 'しますか?')            // 質問の誤認識修正
    .replace(/ようちえん/g, '幼稚園')                 // ひらがな→漢字変換
    .replace(/(\S+)(幼稚園|保育園)/g, (match, p1, p2) => {  // 幼稚園名の修正
      // ホザナ以外の単語が幼稚園に付く場合はホザナ幼稚園に統一
      if (p1 !== 'ホザナ' && p2 === '幼稚園') {
        return 'ホザナ幼稚園';
      }
      return match;
    });

  /* 文末処理 - "です"や"ます"の後に不自然なスペースや記号がある場合に修正 */
  corrected = corrected
    .replace(/(です|ます)(\s+)([\.。])/g, '$1$3')  // 不自然なスペースを削除

  return corrected;
}

/* ───────── Whisper API 呼び出し ───────── */
async function callWhisperAPI(audioBuffer, format) {
  const formData = new FormData();
  formData.append('file', audioBuffer, {
    filename: 'audio.webm',
    contentType: format || 'audio/webm'
  });
  formData.append('model', 'whisper-1');
  formData.append('language', 'ja');  // 日本語を明示的に指定
  
  // 拡張プロンプトを使用
  formData.append('prompt', KINDERGARTEN_PROMPT);

  const headers = formData.getHeaders();
  headers['Content-Length'] = await new Promise(res =>
    formData.getLength((_, len) => res(len))
  );

  return axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...headers },
    maxBodyLength: 25 * 1024 * 1024,
    maxContentLength: 25 * 1024 * 1024,
    timeout: 30000  // タイムアウト30秒に拡張
  });
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
  console.log(`STT処理開始: ${new Date().toISOString()}`);
  
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
      return formatResponse(400, headers, {}, 'JSON形式のリクエストが必要です');

    const req = JSON.parse(event.body || '{}');
    if (!req.audio) return formatResponse(400, headers, {}, '音声データが含まれていません');
    if (!process.env.OPENAI_API_KEY) return formatResponse(500, headers, {}, 'API設定エラー: API Keyが未設定です');

    /* 音声サイズ検証 */
    const audioBuffer = Buffer.from(req.audio, 'base64');
    const sizeInMB = audioBuffer.length / (1024 * 1024);
    console.log(`音声サイズ: ${sizeInMB.toFixed(2)} MB`);
    
    if (sizeInMB > 9.5)
      return formatResponse(413, headers, {}, '音声ファイルが大きすぎます (10MB以上)');

    /* Whisper 呼び出し */
    console.log('Whisper API呼び出し開始');
    const resp = await callWhisperAPI(audioBuffer, req.format);
    console.log('Whisper API呼び出し完了');
    
    let recognized = resp.data.text || '';
    recognized = stripSpeakerLabel(recognized);
    console.log(`認識結果(元): ${recognized}`);
    
    const corrected = correctKindergartenTerms(recognized);
    console.log(`補正後結果: ${corrected}`);

    return formatResponse(200, headers, {
      text: corrected,
      originalText: recognized,
      timestamp: Date.now()
    });

  } catch (err) {
    console.error('STT処理エラー:', err);
    const status = err.response?.status || 500;
    const detail = err.response?.data || err.message;
    return formatResponse(status, headers, { details: detail }, 'Whisper API接続エラー');
  }
};