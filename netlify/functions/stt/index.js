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

/* ───────── 誤変換辞書 ───────── */
// 辞書の構成を[間違った表記]: [正しい表記]の形式で整理（優先度順）
const speechCorrectionDict = {
  /* 幼稚園名関連 */
  'ほざな幼稚園': 'ホザナ幼稚園',
  '幼い幼稚園': 'ホザナ幼稚園',
  'おだな幼稚園': 'ホザナ幼稚園',
  'おさない幼稚園': 'ホザナ幼稚園',
  '保産が幼稚園': 'ホザナ幼稚園',
  '小棚幼稚園': 'ホザナ幼稚園',
  '児玉幼稚園': 'ホザナ幼稚園',
  'ほざな': 'ホザナ',
  'おだな': 'ホザナ',
  'おさない': 'ホザナ',
  '幼い': 'ホザナ',
  '保産が': 'ホザナ',
  '小棚': 'ホザナ',
  '児玉': 'ホザナ',
  
  /* 園長・延長保育関連 - 重要な区別 */
  'えんちょうほいく': '延長保育',    // えんちょう + ほいく の複合語は延長保育
  'えんちょう保育': '延長保育',      // えんちょう + 保育 の複合語も延長保育
  'えんちょう（園長）': '園長',      // 明示的な指定がある場合
  'えんちょう（延長）': '延長',      // 明示的な指定がある場合
  'えんちょうせんせい': '園長先生',  // 先生が付く場合は園長先生
  'えんちょう先生': '園長先生',      // 先生が付く場合は園長先生
  
  /* 副園長関連 */
  'ふくえんちょう': '副園長',
  '福園町': '副園長',
  'ふくえんまち': '副園長',
  'そえんちょう': '副園長',
  '福園町先生': '副園長先生',
  '副園町': '副園長',
  'ふくえんちょうせんせい': '副園長先生',
  
  /* 預かり保育関連 */
  'あずかりほいく': '預かり保育',
  'あつかいほいく': '預かり保育',
  'あつがりほいく': '預かり保育',
  '扱い保育': '預かり保育',
  '暑がり保育': '預かり保育',
  
  /* 願書関連 - 「がんしょ」が正しい読み、AIが「がんしょう」と誤認識する問題に対処 */
  'にゅうえんがんしょう': '入園願書',  // 複合語から処理
  'がんしょう': '願書',                // AIが「がんしょ」を「がんしょう」と誤認識する場合
  'かんしょう': '願書',
  '干渉': '願書',
  '眼症': '願書',
  '顔症': '願書',
  '元祥': '願書',
  'がんしょ': '願書',                // 正しい読み方
  'かんしょ': '願書',
  '幹書': '願書',
  'みきしょ': '願書',
  '入園願書': '入園願書',
  'にゅうえんがんしょ': '入園願書',
  
  /* モンテッソーリ関連 */
  'モンテストーリー教育': 'モンテッソーリ教育',
  'モンテソーリ教育': 'モンテッソーリ教育',
  'モンテソリー教育': 'モンテッソーリ教育',
  'マンテッソーリ教育': 'モンテッソーリ教育',
  'モンテッソリ教育': 'モンテッソーリ教育',
  'モンテストーリー': 'モンテッソーリ',
  'モンテソーリ': 'モンテッソーリ',
  'モンテソリー': 'モンテッソーリ',
  'マンテッソーリ': 'モンテッソーリ',
  'モンテッソリ': 'モンテッソーリ',

  /* 園児数関連 */
  'そうえんじすう': '総園児数',      // 複合語から先に処理
  '総演じ数': '総園児数',
  '総延字数': '総園児数',
  '総延児数': '総園児数',
  '総園字数': '総園児数',
  '総園時数': '総園児数',
  'えんじすう': '園児数',            // 次に園児数
  'えんじかず': '園児数',            // 誤った読みも修正
  '演じ数': '園児数',
  '延字数': '園児数',
  '延児数': '園児数',
  '園字数': '園児数',
  '園時数': '園児数',
  '縁児数': '園児数',

  /* 通園・登園・降園関連 */
  'つうえん': '通園',
  'こうえん': '降園',
  'とうえん': '登園',
  'とうえい': '登園',
  'こうえい': '降園',
  
  /* その他幼稚園用語 */
  'にゅうえんしき': '入園式',
  'にゅうえん': '入園',
  'そつえんしき': '卒園式',
  'そつえん': '卒園',
  'うんどうかい': '運動会',
  'うんどう会': '運動会',
  'たいいく': '体育',
  'きゅうしょく': '給食',
  'ほけん': '保健',
  'ほいく': '保育',
  'ほいくりょう': '保育料',
  'ようちえん': '幼稚園'
};

/* ───────── Whisper 用プロンプト ───────── */
const KINDERGARTEN_PROMPT =
  '===== 音声認識コンテキスト：ホザナ幼稚園 入園案内 =====\n' +
  'この会話はホザナ幼稚園の入園手続き・モンテッソーリ教育に関する Q&A です。\n\n' +
  '===== 用語ガイド =====\n' +
  '・「ホザナ幼稚園」は固有名詞です（誤認例: おだな／おさない／幼い）。\n' +
  '・「えんちょう」は単体では「園長」を指します。「えんちょうほいく」の場合のみ「延長保育」を意味します。\n' +
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

/* ───────── ユーティリティ関数 ───────── */
// メタ文字をエスケープする関数
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 日本語文字（漢字・ひらがな・カタカナ）を表す正規表現
const WORD = '[\\p{Script=Hani}\\p{Script=Hira}\\p{Script=Kana}]';

/* ───────── 誤変換補正関数 ───────── */
function correctKindergartenTerms(text) {
  let out = text;

  /* 前処理 - えんちょうの単体処理を確実にするための特別ルール */
  // 先に「えんちょうほいく」「えんちょう保育」を一時的なマーカーに置換
  out = out
    .replace(/えんちょうほいく/g, '##ENCHOHOKU##')
    .replace(/えんちょう保育/g, '##ENCHOHOIKU##');
  
  // 単体の「えんちょう」は必ず「園長」に変換（単語境界考慮）
  out = out.replace(/\bえんちょう\b/gu, '園長');
  
  // マーカーを「延長保育」に戻す
  out = out
    .replace(/##ENCHOHOKU##/g, '延長保育')
    .replace(/##ENCHOHOIKU##/g, '延長保育');

  /* 基本辞書置換 - 優先度→長さの降順でソート */
  const sortedEntries = Object.entries(speechCorrectionDict)
    .sort((a, b) => b[0].length - a[0].length);
    
  for (const [wrong, right] of sortedEntries) {
    // 単語の長さによって置換パターンを変える
    const pattern = wrong.length <= 2
      // 前後が日本語文字でないことを保証（短語用）
      ? new RegExp(`(?:^|[^${WORD}])${esc(wrong)}(?=$|[^${WORD}])`, 'gu')
      // 普通の単語はエスケープして置換
      : new RegExp(esc(wrong), 'gu');

    // 置換処理
    out = out.replace(pattern, m => {
      // 先頭を保持して置換（短語用）
      if (wrong.length <= 2) {
        return m.replace(wrong, right);
      }
      return right;
    });
  }

  /* 園児数に関する特別な処理 - 万が一辞書で対応できなかったパターン向け */
  out = out
    .replace(/えん(?:じ|字|時)(?:すう|数)/g, '園児数')
    .replace(/延(?:じ|字|児)(?:すう|数)/g, '園児数')
    .replace(/園(?:字|時)(?:すう|数)/g, '園児数')
    .replace(/縁児(?:すう|数)/g, '園児数');

  /* 「円」と「園」の誤変換対応 - 数字の後の円はそのままに */
  out = out
    .replace(/(\d+)([万千百十]?)円/g, '$1$2円')  // 数字＋円はそのまま
    .replace(/([^\d０-９万千百十])円/g, '$1園')  // それ以外＋円→園
    .replace(/円児/g, '園児')                   // 円児→園児
    .replace(/円長/g, '園長');                  // 円長→園長

  /* 文脈に応じた補正 */
  out = out
    .replace(/しますから\?/g, 'しますか?')            // 質問の誤認識修正
    .replace(/(\S+)(幼稚園|保育園)/g, (match, p1, p2) => {  // 幼稚園名の修正
      // ホザナ以外の単語が幼稚園に付く場合はホザナ幼稚園に統一
      if (p1 !== 'ホザナ' && p2 === '幼稚園') {
        return 'ホザナ幼稚園';
      }
      return match;
    });

  /* 文末処理 - "です"や"ます"の後に不自然なスペースや記号がある場合に修正 */
  out = out
    .replace(/(です|ます)(\s+)([\.。])/g, '$1$3')  // 不自然なスペースを削除
    .replace(/(です|ます)([,\.。、])\s+/g, '$1$2 ') // 句読点後のスペースを整理

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