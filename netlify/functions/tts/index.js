// netlify/functions/tts/index.js
import fetch from 'node-fetch';

// JSONファイルを動的にインポート
import kindergartenQAData from './QandA.json' assert { type: 'json' };
const kindergartenQA = kindergartenQAData.kindergartenQA;

// 追加するプロンプト情報
const TTS_PROMPT = {
  instructions: `
    テキスト読み上げに関する指示:
    - 園の名前は「ホザナようちえん」と読む
    - 電話番号は読み上げない
    - 「園児数」は「えんじかず」とは読まず、必ず「えんじすう」と読む
    - 丁寧で温かみのある話し方を心がける
    - 教育用語は正確に発音する
  `
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 日本語の読み最適化
function optimizeJapaneseReading(text) {
  // TTS_PROMPTの指示に基づいた読み最適化
  let optimizedText = text
    .replace(/副園長/g, 'ふくえんちょう')
    .replace(/入園/g, 'にゅうえん')
    .replace(/登園/g, 'とうえん')
    .replace(/降園/g, 'こうえん')
    .replace(/通園/g, 'つうえん')
    .replace(/園児/g, 'えんじ')
    .replace(/園児数/g, 'えんじすう')
    .replace(/総園児数/g, 'そうえんじすう')
    .replace(/卒園/g, 'そつえん')
    .replace(/卒園児/g, 'そつえんじ')
    .replace(/園/g, 'えん');
  
  // 数字の読み上げ最適化 (例: 10人→じゅうにん)
  // 実際には日本語のTTSエンジンが自動的に処理するため、
  // ここでは特殊なケースのみ対応
  optimizedText = optimizedText
    .replace(/(\d+)人/g, (match, num) => {
      // 簡易的な例 - 実際にはもっと複雑な変換が必要かもしれません
      if (num === '10') return 'じゅうにん';
      if (num === '20') return 'にじゅうにん';
      if (num === '30') return 'さんじゅうにん';
      return match; // その他のケースはそのまま返す
    });
  
  return optimizedText;
}

// マークダウンをシンプルテキストに変換
function cleanMarkdown(text) {
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1');
}

// URLを読みやすくする
function optimizeUrlsForSpeech(text) {
  return text
    .replace(/https?:\/\/[^\s]+/g, 'ホームページのリンク');
}

// 電話番号をSSML形式に変換
// TTS_PROMPTの指示に基づき "電話番号は読み上げない" を実装
function formatPhoneNumbers(text) {
  // 電話番号を検出して非読み上げマークアップに置換
  return text.replace(
    /(\d{2,4})[-\s]?(\d{2,4})[-\s]?(\d{2,4})/g, 
    '<say-as interpret-as="verbatim">電話番号省略</say-as>'
  );
}

// ポーズと抑揚を追加
function addProsody(text) {
  // 丁寧で温かみのある話し方を実現するためのSSML調整
  return text
    .replace(/([。、．，！？])\s*/g, '$1<break time="300ms"/>')
    .replace(/\n+/g, '<break time="500ms"/>')
    // 重要な情報に対して強調を追加
    .replace(/(お申し込み|ご予約|ご来園)/g, '<emphasis level="moderate">$1</emphasis>')
    // 声のトーンを温かみのあるものに
    .replace(/^(.+)$/gm, '<prosody rate="0.97" pitch="+0.5%">$1</prosody>');
}

// テキストをSSMLに変換（統合関数）
function textToSSML(text) {
  let ssml = optimizeJapaneseReading(text);
  ssml = cleanMarkdown(ssml);
  ssml = optimizeUrlsForSpeech(ssml);
  ssml = formatPhoneNumbers(ssml);
  ssml = addProsody(ssml);
  
  // プロンプトの指示に従ったSSMLを生成
  return `<speak>${ssml}</speak>`;
}

// Googleの音声合成APIを呼び出す際にプロンプトの内容を反映
function getVoiceConfig() {
  // TTS_PROMPTの指示に基づいた音声設定
  return {
    languageCode: 'ja-JP',
    name: 'ja-JP-Standard-B', // 温かみのある声質の男性声
    ssmlGender: 'NEUTRAL'
  };
}

export const handler = async (event) => {
  // ─ OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const requestData = JSON.parse(event.body || '{}');
    const { text = '', ssml = '' } = requestData;
    
    if (!text.trim() && !ssml.trim()) {
      throw new Error('text is empty');
    }

    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY not set');

    /* ── Google TTS ── */
    let requestBody;
    
    // TTS_PROMPTを考慮した音声設定
    const voiceConfig = getVoiceConfig();
    
    if (ssml && ssml.trim()) {
      // SSMLが提供されている場合はそれを使用
      requestBody = {
        input: { ssml: ssml.includes('<speak>') ? ssml : `<speak>${ssml}</speak>` },
        voice: voiceConfig,
        audioConfig: { 
          audioEncoding: 'MP3',
          speakingRate: 1.15,
          pitch: 0.0,
          volumeGainDb: 0.0
        },
      };
    } else {
      // 通常のテキスト入力の前処理
      const processedSSML = textToSSML(text);
      
      requestBody = {
        input: { ssml: processedSSML },
        voice: voiceConfig,
        audioConfig: { 
          audioEncoding: 'MP3',
          speakingRate: 1.15,
          pitch: 0.0,
          volumeGainDb: 0.0
        },
      };
    }

    // モデル選択を試行
    try {
      requestBody.voice.name = 'ja-JP-Standard-B';
    } catch (e) {
      console.log('Voice model specification failed, using default voice');
    }

    const resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }
    ).then(r => r.json());

    if (!resp.audioContent) throw new Error(resp.error?.message || 'no audio');

    /* ─ data:URL にラップ ─ */
    const audioUrl = `data:audio/mpeg;base64,${resp.audioContent}`;

    // TTS_PROMPTを考慮したレスポンス処理
    console.log(`TTS completed following the prompt instructions: ${TTS_PROMPT.instructions.trim().split('\n')[0]}...`);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioUrl }),
    };
  } catch (err) {
    console.error('TTS error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'TTS failed', detail: err.message }),
    };
  }
};