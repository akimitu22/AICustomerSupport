// netlify/functions/tts/index.js
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

// 音声API認証情報
const TTS_API_KEY = process.env.GOOGLE_API_KEY;
const VOICE_NAME = 'ja-JP-Standard-B'; // 女性声
const SPEAKING_RATE = 1.15; 

// 音声生成関数
async function generateSpeech(text) {
  // SSMLに変換して自然な発音を実現
  const ssml = convertToSSML(text);
  console.log('変換後SSML:', ssml);

  try {
    const response = await axios.post(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${TTS_API_KEY}`,
      {
        input: { ssml },
        voice: { languageCode: 'ja-JP', name: VOICE_NAME },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: SPEAKING_RATE,
          pitch: 0,
          volumeGainDb: 0.5
        }
      }
    );
    return response.data.audioContent;
  } catch (error) {
    console.error('音声生成APIエラー:', error);
    throw new Error(`音声合成に失敗しました: ${error.message}`);
  }
}

// テキストをSSMLに変換する関数（自然な発音のための最適化）
function convertToSSML(text) {
  // 基本的なクリーニング
  let ssml = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // 特殊な読み置換（幼稚園関連）
  ssml = ssml
    // 「えんちょうほいく」→「延長保育」の変換は維持（必須）
    .replace(/えんちょうほいく/g, '延長保育')
    // 「えんちょう」→「園長」への変換は削除（過剰補正防止）
    // TTSエンジンが「園長」を適切に読み上げるため

    // その他の幼稚園用語は必要に応じて残す
    .replace(/がんしょ/g, '願書')
    .replace(/がんしょう/g, '願書')
    .replace(/ふくえんちょう/g, '副園長')
    .replace(/ようちえん/g, '幼稚園')
    .replace(/こどものいえ/g, '子どもの家')
    .replace(/にゅうえん/g, '入園')
    .replace(/そつえん/g, '卒園')
    .replace(/もんてっそーり/g, 'モンテッソーリ');

  // 区切り要素でポーズを入れる（読点のポーズは削除して自然さ向上）
  ssml = ssml
    // 句読点（読点は除外）
    .replace(/([。！？])\s*/g, '$1<break time="300ms"/>')
    
    // 改行
    .replace(/\n+/g, '<break time="500ms"/>')
    
    // 括弧（prosodyタグは削除し、シンプルなbreakに）
    .replace(/（/g, '<break time="200ms"/>（')
    .replace(/）/g, '）<break time="200ms"/>');

  // 日付と時間の読み方修正
  ssml = ssml
    .replace(/(\d+)月(\d+)日/g, '$1げつ$2にち')
    .replace(/(\d+):(\d+)/g, '$1じ$2ふん');
  
  // 英語表現は区切りをつけて明瞭に
  ssml = ssml.replace(/([a-zA-Z]+)/g, '<break time="100ms"/>$1<break time="100ms"/>');

  // 最終的なSSML形式に整形
  return `<speak>${ssml}</speak>`;
}

// Netlify Functions ハンドラ
export const handler = async (event) => {
  // CORS対応
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // プリフライトリクエスト対応
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // POSTメソッド以外は拒否
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // リクエストボディを解析
    const requestBody = JSON.parse(event.body);
    const { text } = requestBody;

    if (!text) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '変換するテキストが指定されていません' })
      };
    }

    // 音声生成実行
    console.log(`TTS開始: ${text.substring(0, 50)}...`);
    const audioContent = await generateSpeech(text);

    // 成功レスポンス
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        audio: audioContent,
        timestamp: Date.now()
      })
    };

  } catch (error) {
    console.error('TTS処理エラー:', error);
    
    // エラーレスポンス
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: `音声合成に失敗しました: ${error.message}`
      })
    };
  }
};