import express from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { exec } from 'child_process';
import { promisify } from 'util';
import 'dotenv/config';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execPromise = promisify(exec);
const app = express();
const upload = multer({ dest: 'uploads/' });
const sessionStorage = {};

app.use(express.json());
app.use(express.static('public'));

const STAGES = {
  INITIAL: 'initial',
  INTEREST: 'interest',
  CONSIDERATION: 'consideration',
  DESIRE: 'desire',
  ACTION: 'action'
};

/* ───── Whisper STT ───── */
app.post('/stt', upload.single('audio'), async (req, res) => {
  try {
    const audioPath = req.file.path;

    const fd = new FormData();
    fd.append('file', fs.createReadStream(audioPath), {
      filename: path.basename(audioPath),
      contentType: 'audio/webm'
    });
    fd.append('model', 'whisper-1');
    fd.append('language', 'ja');

    const { data } = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      fd,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...fd.getHeaders()
        }
      }
    );

    res.json({ text: data.text?.toLowerCase() || '' });
  } catch (e) {
    console.error('STT error:', e);
    res.status(500).json({ error: '音声認識失敗' });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }
});

/* ───── ChatGPT ───── */
function analyzeStage(msg, stage) {
  const kw = ['見学', '説明会', '願書', '入園'];
  if (stage === STAGES.INITIAL && kw.some(w => msg.includes(w))) return STAGES.INTEREST;
  if (stage === STAGES.INTEREST && msg.includes('見学')) return STAGES.CONSIDERATION;
  if (stage === STAGES.CONSIDERATION && /(いつ|日程|予約)/.test(msg)) return STAGES.DESIRE;
  if (stage === STAGES.DESIRE && /(予約|申し込み)/.test(msg)) return STAGES.ACTION;
  return stage;
}

function systemPrompt() {
  return `ホザナ幼稚園の入園コンシェルジュです。園に関する質問に250文字程度で親切・丁寧に回答してください。

※見学を希望される方には「このページ上部の見学予約ボタンからお申し込みください」と案内してください。
※電話番号は絶対に読み上げないでください。
※お問い合わせには「ホームページのお問い合わせフォームからどうぞ」と案内してください。
※「電話でのお問い合わせ」という言葉や電話番号は絶対に使わないでください。

不明点は「園へお問い合わせください」と案内してください。また、絶対に「入園」を「入院」と誤変換して理解しないでください。幼稚園へのお問い合わせに「入院」は絶対にありえません。それと「眼症」も絶対にありえません。それは100％「願書」の意味です。また「扱い保育」という言葉も存在しません。日本語として不自然に感じた場合は一番近いものを探して解釈してください。たとえば「扱い保育」は「預かり保育」を意味する、とそう解釈してください。要するに、すべて幼稚園関係の言葉だと幼稚園関係用語に変換して対応してください。仮にそれがひやかしなどで、幼稚園関係のものでないとしても、幼稚園以外の質問に回答する必要はありません。`;
}

app.post('/ai', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'empty' });

    const sid = sessionId || `s_${Date.now()}`;
    const sess = sessionStorage[sid] ||= { history: [], stage: STAGES.INITIAL };
    sess.history.push({ role: 'user', content: message });
    sess.stage = analyzeStage(message, sess.stage);

    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt()
          },
          ...sess.history.slice(-5)
        ],
        max_tokens: 400,
        temperature: 0.7
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const reply = data.choices?.[0]?.message?.content
      || '申し訳ありません、回答を生成できませんでした。';

    sess.history.push({ role: 'assistant', content: reply });
    res.json({ reply, sessionId: sid, stage: sess.stage });
  } catch (e) {
    console.error('AI error:', e);
    res.status(500).json({ error: '回答生成失敗' });
  }
});

/* ───── TTS (Google APIキー方式) ───── */
function convertMarkdownToSSML(text) {
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '<emphasis level="moderate">$1</emphasis>')
    .replace(/\*(.+?)\*/g, '<emphasis level="reduced">$1</emphasis>')
    .replace(/__(.+?)__/g, '<emphasis level="strong">$1</emphasis>');
}

function formatPhoneNumbers(text) {
  return text.replace(
    /(\d{2,4})[-\s]?(\d{2,4})[-\s]?(\d{2,4})/g, 
    '<say-as interpret-as="telephone">$1-$2-$3</say-as>'
  );
}

function optimizeTextForSpeech(text) {
  return text
    .replace(/https?:\/\/[^\s]+/g, 'ホームページのリンク')
    .replace(/\n+/g, '<break time="500ms"/>')
    .replace(/([。、．，！？])\s*/g, '$1<break time="300ms"/>');
}

async function synthesize(text) {
  const fixed = text
    .replace(/副園長/g, 'ふくえんちょう')
    .replace(/入園/g, 'にゅうえん')
    .replace(/登園/g, 'とうえん')
    .replace(/降園/g, 'こうえん')
    .replace(/通園/g, 'つうえん')
    .replace(/卒園/g, 'そつえん')
    .replace(/園児数/g, 'えんじすう')
    .replace(/園児/g, 'えんじ')
    .replace(/園/g, 'えん');

  let processedText = convertMarkdownToSSML(fixed);
  processedText = formatPhoneNumbers(processedText);
  processedText = optimizeTextForSpeech(processedText);
  
  const ssmlText = `<speak>${processedText}</speak>`;

  try {
    const { data } = await axios.post(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_API_KEY}`,
      {
        input: { ssml: ssmlText },
        voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
        audioConfig: { 
          audioEncoding: 'MP3', 
          speakingRate: 1.15,
          pitch: 0.0,
          volumeGainDb: 0.0
        }
      }
    );

    return `data:audio/mpeg;base64,${data.audioContent}`;
  } catch (error) {
    console.error('Google TTS API error:', error.response?.data || error.message);
    try {
      const { data } = await axios.post(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_API_KEY}`,
        {
          input: { ssml: ssmlText },
          voice: { languageCode: 'ja-JP', name: 'ja-JP-Standard-B' },
          audioConfig: { 
            audioEncoding: 'MP3', 
            speakingRate: 1.15,
            pitch: 0.0
          }
        }
      );
      return `data:audio/mpeg;base64,${data.audioContent}`;
    } catch (fallbackError) {
      const { data } = await axios.post(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_API_KEY}`,
        {
          input: { ssml: ssmlText },
          voice: { languageCode: 'ja-JP' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 1.15 }
        }
      );
      return `data:audio/mpeg;base64,${data.audioContent}`;
    }
  }
}

app.post('/tts', async (req, res) => {
  try {
    const { text, ssml } = req.body;
    
    if (!text?.trim() && !ssml?.trim()) {
      return res.status(400).json({ error: 'empty' });
    }
    
    let audioUrl;
    if (ssml && ssml.trim()) {
      const finalSSML = ssml.includes('<speak>') ? ssml : `<speak>${ssml}</speak>`;
      const { data } = await axios.post(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_API_KEY}`,
        {
          input: { ssml: finalSSML },
          voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
          audioConfig: { 
            audioEncoding: 'MP3', 
            speakingRate: 1.15,
            pitch: 0.0,
            volumeGainDb: 0.0
          }
        }
      );
      audioUrl = `data:audio/mpeg;base64,${data.audioContent}`;
    } else {
      audioUrl = await synthesize(text);
    }
    
    res.json({ audioUrl });
  } catch (e) {
    console.error('TTS error:', e.response?.data || e.message);
    res.status(500).json({ error: 'TTS失敗' });
  }
});

// CommonJSのexportsからESMのexportに変更
export default app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 サーバーが起動しました: http://localhost:${PORT}`);
});