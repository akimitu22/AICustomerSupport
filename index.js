// netlify/functions/stt/index.js
import axios from 'axios';
import FormData from 'form-data';

/* ───────── STT用プロンプト情報 ───────── */
const STT_PROMPT = {
  instructions: `
    # 音声認識における幼稚園用語の正確な変換ルール

    ## 固有名詞の認識
    - 「ホザナ」を正確に認識し、「幼い」「保産が」「おだな」「おさない」「小棚」などに誤変換しないこと
    - 「幼い幼稚園」や「ほざな幼稚園」などの誤認識表現は「ホザナ幼稚園」に統一すること

    ## 役職・人物の認識
    - 「えんちょう」は単体では必ず「園長」として認識すること
    - 「えんちょうほいく」の場合のみ「延長保育」として認識すること
    - 「副園長」は「ふくえんちょう」と読み、「福園町」「ふくえんまち」「そえんちょう」などの誤変換を修正すること

    ## 重要用語の認識
    - 「園児数」は「えんじすう」と読み、「えんじかず」「延字数」「園時数」「演じ数」などへの誤変換を修正すること
    - 「願書」は「がんしょ」が正しい読みであり、「がんしょう」「顔症」「眼症」などの誤変換を修正すること
    - 「預かり保育」を正確に認識し、「扱い保育」「暑がり保育」への誤変換を修正すること
    - 「モンテッソーリ」を正確に認識し、「モンテストーリー」「モンテソーリ」などの誤表記を修正すること

    ## その他の幼稚園用語
    - 「通園」「登園」「降園」を正確に識別すること
    - すべての音声をホザナ幼稚園関連の文脈で解釈し、適切な幼稚園用語に変換すること
  `
};

/* ───────── ユーティリティ関数 ───────── */
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '[\\p{Script=Hani}\\p{Script=Hira}\\p{Script=Kana}]';

/* ───────── 誤変換補正関数 ───────── */
function correctKindergartenTerms(text) {
  let out = text;

  out = out.replace(/えんちょうほいく/g, '##ENCHOHOIKU##').replace(/えんちょう保育/g, '##ENCHOHOIKU##');
  out = out.replace(/\bえんちょう\b/gu, '園長');
  out = out.replace(/##ENCHOHOIKU##/g, '延長保育');

  const speechCorrectionDict = {
    'ふくえんまち': '副園長',
    'そえんちょう': '副園長',
    '福園町': '副園長',
    '演じ数': '園児数',
    'えんじかず': '園児数',
    '延字数': '園児数',
    '園時数': '園児数',
    '顔症': '願書',
    '眼症': '願書',
    'がんしょう': '願書',
    '暑がり保育': '預かり保育',
    '扱い保育': '預かり保育',
    'モンテストーリー': 'モンテッソーリ',
    'モンテソーリ': 'モンテッソーリ',
    'ほざな幼稚園': 'ホザナ幼稚園',
    '小棚幼稚園': 'ホザナ幼稚園',
    'おだな幼稚園': 'ホザナ幼稚園',
    '幼い幼稚園': 'ホザナ幼稚園',
  };

  const sortedEntries = Object.entries(speechCorrectionDict).sort((a, b) => b[0].length - a[0].length);

  for (const [wrong, right] of sortedEntries) {
    const pat = wrong.length <= 2
      ? new RegExp(`(?:^|[^${WORD}])${esc(wrong)}(?=$|[^${WORD}])`, 'gu')
      : new RegExp(esc(wrong), 'gu');

    out = out.replace(pat, m => (wrong.length <= 2 ? m.replace(wrong, right) : right));
  }

  out = out
    .replace(/えん(?:じ|字|時)(?:すう|数)/g, '園児数')
    .replace(/延(?:じ|字|児)(?:すう|数)/g, '園児数')
    .replace(/園(?:字|時)(?:すう|数)/g, '園児数')
    .replace(/縁児(?:すう|数)/g, '園児数');

  out = out
    .replace(/(\d+)([万千百十]?)円/g, '$1$2円')
    .replace(/([^\d０-９万千百十])円/g, '$1園')
    .replace(/円児/g, '園児')
    .replace(/円長/g, '園長');

  out = out
    .replace(/しますから\?/g, 'しますか?')
    .replace(/(\S+)(幼稚園|保育園)/g, (match, p1, p2) => (p1 !== 'ホザナ' && p2 === '幼稚園' ? 'ホザナ幼稚園' : match))
    .replace(/(です|ます)(\s+)([\.])/g, '$1$3')
    .replace(/(です|ます)([,\.、])\s+/g, '$1$2 ');

  return out;
}

/* ───────── Whisper API 呼び出し ───────── */
async function callWhisperAPI(audioBuffer, format) {
  const formData = new FormData();
  formData.append('file', audioBuffer, {
    filename: 'audio.webm',
    contentType: format || 'audio/webm'
  });
  formData.append('model', 'whisper-1');
  formData.append('language', 'ja');
  formData.append('prompt', STT_PROMPT.instructions);

  const headers = formData.getHeaders();
  headers['Content-Length'] = await new Promise(res => formData.getLength((_, len) => res(len)));

  return axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...headers },
    maxBodyLength: 25 * 1024 * 1024,
    maxContentLength: 25 * 1024 * 1024,
    timeout: 30000
  });
}

/* ───────── 共通レスポンス整形 ───────── */
function formatResponse(statusCode, headers, data = {}, error = null) {
  const body = { success: statusCode >= 200 && statusCode < 300, ...data };
  if (error) body.error = error;
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
    if (!process.env.OPENAI_API_KEY) return formatResponse(500, headers, {}, 'API Keyが未設定です');

    const audioBuffer = Buffer.from(req.audio, 'base64');
    const sizeInMB = audioBuffer.length / (1024 * 1024);
    console.log(`音声サイズ: ${sizeInMB.toFixed(2)} MB`);

    if (sizeInMB > 9.5) return formatResponse(413, headers, {}, '音声ファイルが大きすぎます (10MB以上)');

    const resp = await callWhisperAPI(audioBuffer, req.format);
    let recognized = resp.data.text || '';
    const corrected = correctKindergartenTerms(recognized);

    console.log('Whisper認識結果:', recognized);
    console.log('補正結果:', corrected);

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
