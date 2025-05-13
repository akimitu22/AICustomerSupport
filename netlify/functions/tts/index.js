// netlify/functions/tts/index.js
import fetch from 'node-fetch';

// JSONファイルを動的にインポート
import kindergartenQAData from './QandA.json' assert { type: 'json' };
const kindergartenQA = kindergartenQAData.kindergartenQA;

/**
 * テキスト読み上げ(TTS)の指示と最適化ルール
 * 幼稚園の専門用語を正確に発音するためのガイドライン
 */
const TTS_PROMPT = {
  instructions: `
    # テキスト読み上げ最適化ルール
    
    ## 発音の統一ルール
    - 「ホザナ幼稚園」は「ホザナようちえん」と読む
    - 「えんちょう」単体は必ず「園長」として解釈する
    - 「えんちょうほいく」は「延長保育」として解釈する
    - 「副園長」は「ふくえんちょう」と読み、「ふくえんまち」「そえんちょう」とは絶対に読まない
    - 「園児数」は「えんじすう」と読み、「えんじかず」と絶対に読まない
    - 「総園児数」は「そうえんじすう」と読む
    - 「願書」は「がんしょ」と読み、「がんしょう」とは読まない
    
    ## 禁止事項
    - 電話番号は読み上げない（無音に置き換える）
    - メールアドレスはそのまま読み上げない（「お問い合わせ先」などに置き換える）
    
    ## 幼稚園用語の正しい読み方
    - 「入園」→「にゅうえん」
    - 「登園」→「とうえん」
    - 「降園」→「こうえん」
    - 「通園」→「つうえん」
    - 「卒園」→「そつえん」
    - 「保育」→「ほいく」
    - 「延長保育」→「えんちょうほいく」
  `
};

// CORS設定
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * 日本語の読み最適化
 * 幼稚園専門用語の発音を正確に変換する
 * @param {string} text - 変換対象のテキスト
 * @return {string} - 読み上げ最適化されたテキスト
 */
function optimizeJapaneseReading(text) {
  // 置換パターンを階層的に定義（処理順序を明確に）
  const replacementGroups = [
    // 1. 最優先の複合語句（他の変換の影響を受けないよう先に処理）
    [
      { pattern: /総園児数/g, reading: 'そうえんじすう' },
      { pattern: /園児数/g, reading: 'えんじすう' },
      { pattern: /延長保育/g, reading: 'えんちょうほいく' },
      { pattern: /預かり保育/g, reading: 'あずかりほいく' },
      { pattern: /入園願書/g, reading: 'にゅうえんがんしょ' },
      { pattern: /ホザナ幼稚園/g, reading: 'ホザナようちえん' },
      { pattern: /モンテッソーリ教育/g, reading: 'モンテッソーリきょういく' },
    ],
    
    // 2. 人物・役職関連
    [
      { pattern: /副園長先生/g, reading: 'ふくえんちょうせんせい' },
      { pattern: /副園長/g, reading: 'ふくえんちょう' },
      { pattern: /園長先生/g, reading: 'えんちょうせんせい' },
      { pattern: /園長/g, reading: 'えんちょう' }, // 単体の「えんちょう」は「園長」
      { pattern: /先生/g, reading: 'せんせい' },
    ],
    
    // 3. 園に関連する動詞・複合語
    [
      { pattern: /卒園児/g, reading: 'そつえんじ' },
      { pattern: /入園/g, reading: 'にゅうえん' },
      { pattern: /登園/g, reading: 'とうえん' },
      { pattern: /降園/g, reading: 'こうえん' },
      { pattern: /通園/g, reading: 'つうえん' },
      { pattern: /卒園/g, reading: 'そつえん' },
      { pattern: /他園/g, reading: 'たえん' },
    ],
    
    // 4. 単語・基本用語
    [
      { pattern: /願書/g, reading: 'がんしょ' },
      { pattern: /保育/g, reading: 'ほいく' },
      { pattern: /園児/g, reading: 'えんじ' },
      { pattern: /幼稚園/g, reading: 'ようちえん' },
      { pattern: /モンテッソーリ/g, reading: 'モンテッソーリ' },
    ],
    
    // 5. 最後に処理する単独の「園」（他の複合語に影響しないよう最後に）
    [
      // 園の前に数字がある場合や特定のパターンは変換しない
      { pattern: /([^0-9延卒登降通他])園($|[^児長])/g, reading: '$1えん$2' }, // 「○○園」の形で、かつ「園児」「園長」などの一部でない場合
    ]
  ];
  
  // 階層的に置換を実行
  let result = text;
  for (const group of replacementGroups) {
    for (const { pattern, reading } of group) {
      result = result.replace(pattern, reading);
    }
  }
  
  // 文脈依存の特別ケース処理（「延長」）
  // すでに「えんちょうほいく」は置換済みなので、残りの「延長」を処理
  result = result.replace(/延長/g, 'えんちょう');
  
  return result;
}

/**
 * マークダウンをシンプルテキストに変換
 * @param {string} text - マークダウンテキスト
 * @return {string} - 変換後のプレーンテキスト
 */
function cleanMarkdown(text) {
  return text
    .replace(/^#{1,6}\s*/gm, '')           // 見出し記号を削除
    .replace(/\*\*(.+?)\*\*/g, '$1')       // 太字を通常テキストに
    .replace(/\*(.+?)\*/g, '$1')           // 斜体を通常テキストに
    .replace(/__(.+?)__/g, '$1')           // 下線を通常テキストに
    .replace(/`(.+?)`/g, '$1')             // インラインコードを通常テキストに
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // リンクテキストのみ残す
}

/**
 * URLを読みやすく変換
 * @param {string} text - 変換対象のテキスト
 * @return {string} - URL置換後のテキスト
 */
function optimizeUrlsForSpeech(text) {
  return text
    .replace(/https?:\/\/[^\s]+/g, 'ホームページのリンク')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, 'お問い合わせ先');
}

/**
 * 電話番号をSSML形式に変換して無音化
 * @param {string} text - 変換対象のテキスト
 * @return {string} - 電話番号が無音化されたテキスト
 */
function formatPhoneNumbers(text) {
  // 様々な形式の日本の電話番号パターンを検出
  const phonePatterns = [
    // 市外局番-市内局番-番号 形式（例: 03-1234-5678）
    /0\d{1,4}-\d{1,4}-\d{4}/g,
    
    // 括弧付き形式（例: (03)1234-5678）
    /\(0\d{1,4}\)\d{1,4}-\d{4}/g,
    
    // スペース区切り形式（例: 03 1234 5678）
    /0\d{1,4}\s\d{1,4}\s\d{4}/g,
    
    // 連続数字形式（例: 0312345678）- 誤検出防止のため9-11桁に限定
    /0\d{8,10}(?!\d)/g,
    
    // 一般的な電話番号形式（バックアップパターン）
    /(\d{2,4})[-\s]?(\d{2,4})[-\s]?(\d{2,4})/g
  ];
  
  // 各パターンで電話番号を検出して置換
  let result = text;
  for (const pattern of phonePatterns) {
    result = result.replace(pattern, '<break time="200ms"/><prosody volume="x-soft">電話番号省略</prosody><break time="200ms"/>');
  }
  
  return result;
}

/**
 * テキストにポーズと抑揚を追加
 * @param {string} text - 変換対象のテキスト
 * @return {string} - ポーズ追加後のテキスト
 */
function addProsody(text) {
  return text
    .replace(/([。、．，！？])\s*/g, '$1<break time="300ms"/>')  // 句読点で短いポーズ
    .replace(/\n+/g, '<break time="500ms"/>')                   // 改行で長めのポーズ
    .replace(/（[^）]+）/g, '<prosody rate="0.9">$&</prosody>') // 括弧内はやや遅く
    .replace(/「([^」]+)」/g, '<emphasis level="moderate">$1</emphasis>'); // 引用部分は強調
}

/**
 * 数値の読み上げ最適化
 * @param {string} text - 変換対象のテキスト
 * @return {string} - 数値読み上げが最適化されたテキスト
 */
function optimizeNumbers(text) {
  return text
    // 年号の読み上げ最適化
    .replace(/(\d{4})年/g, '<say-as interpret-as="date" format="y">$1</say-as>年')
    // 日付の読み上げ最適化
    .replace(/(\d{1,2})月(\d{1,2})日/g, '<say-as interpret-as="date" format="md">$1$2</say-as>')
    // 時刻の読み上げ最適化
    .replace(/(\d{1,2})時(\d{1,2})分/g, '<say-as interpret-as="time" format="hm">$1:$2</say-as>')
    // パーセントの読み上げ最適化
    .replace(/(\d+)%/g, '$1<say-as interpret-as="characters">%</say-as>')
    // 金額の読み上げ最適化
    .replace(/(\d+)円/g, '<say-as interpret-as="cardinal">$1</say-as>円');
}

/**
 * テキストをSSMLに変換（統合関数）
 * @param {string} text - 変換対象の生テキスト
 * @return {string} - SSML形式の完全なマークアップ
 */
function textToSSML(text) {
  // テキスト前処理
  // 1. マークダウンをプレーンテキストに変換
  let ssml = cleanMarkdown(text);
  
  // 2. URLや電話番号を最適化
  ssml = optimizeUrlsForSpeech(ssml);
  ssml = formatPhoneNumbers(ssml);
  
  // 3. 重要: 「えんちょう」を常に「園長」として解釈、「えんちょうほいく」は「延長保育」として解釈
  ssml = ssml
    .replace(/えんちょうほいく/g, '延長保育') // 先に「えんちょうほいく」を処理
    .replace(/えんちょう/g, '園長');  // 残りの「えんちょう」は全て「園長」
  
  // 4. 日本語の読みを最適化（特に幼稚園用語）
  ssml = optimizeJapaneseReading(ssml);
  
  // 5. 文脈処理後の追加補正
  // SSMLタグ付け前の最終チェック
  ssml = ssml
    .replace(/えんじかず/g, 'えんじすう') // 「園児数」の読み間違い対策
    .replace(/ふくえんまち/g, 'ふくえんちょう') // 副園長の誤読対策
    .replace(/そえんちょう/g, 'ふくえんちょう') // 副園長の別の誤読対策
    .replace(/がんしょう/g, 'がんしょ'); // 願書の読み間違い対策

  // 6. ポーズと抑揚を追加
  ssml = addProsody(ssml);
  
  // 7. 数値の読み上げ最適化
  ssml = optimizeNumbers(ssml);
  
  // 最終的なSSML形式に整形
  return `<speak>${ssml}</speak>`;
}

/**
 * Netlify Function Handler
 * テキスト→音声変換処理のメインロジック
 */
export const handler = async (event) => {
  // CORS用のPreflight requestへの対応
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    // リクエストボディの解析
    const requestData = JSON.parse(event.body || '{}');
    const { text = '', ssml = '' } = requestData;
    
    // 入力チェック
    if (!text.trim() && !ssml.trim()) {
      throw new Error('テキストが空です');
    }

    // API KEYのチェック
    const key = process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error('GOOGLE_API_KEYが設定されていません');
    }

    /* Google Text-to-Speech APIリクエスト作成 */
    let requestBody;
    
    if (ssml && ssml.trim()) {
      // SSMLが直接提供されている場合はそれを使用
      requestBody = {
        input: { ssml: ssml.includes('<speak>') ? ssml : `<speak>${ssml}</speak>` },
        voice: { 
          languageCode: 'ja-JP', 
          name: 'ja-JP-Standard-B',
          ssmlGender: 'NEUTRAL' 
        },
        audioConfig: { 
          audioEncoding: 'MP3',
          speakingRate: 1.15,  // やや早め
          pitch: 0.0,          // 標準ピッチ
          volumeGainDb: 0.0    // 標準音量
        },
      };
    } else {
      // 通常のテキスト入力の場合は最適化処理を実行
      const processedSSML = textToSSML(text);
      
      requestBody = {
        input: { ssml: processedSSML },
        voice: { 
          languageCode: 'ja-JP', 
          name: 'ja-JP-Standard-B',  // 日本語女性音声
          ssmlGender: 'NEUTRAL' 
        },
        audioConfig: { 
          audioEncoding: 'MP3',
          speakingRate: 1.15,
          pitch: 0.0,
          volumeGainDb: 0.0
        },
      };
    }

    // Google Text-to-Speech API呼び出し
    const resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }
    ).then(r => r.json());

    // レスポンスチェック
    if (!resp.audioContent) {
      throw new Error(resp.error?.message || '音声データが生成されませんでした');
    }

    // Base64エンコードされた音声データをdata:URLに変換
    const audioUrl = `data:audio/mpeg;base64,${resp.audioContent}`;

    // 成功レスポンス
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioUrl }),
    };
  } catch (err) {
    // エラーハンドリング
    console.error('TTS処理エラー:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: '音声合成に失敗しました', 
        detail: err.message 
      }),
    };
  }
};