import express from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { exec } from 'child_process';
import { promisify } from 'util';
import 'dotenv/config';
import ffmpegPath from 'ffmpeg-static';
import { kindergartenQA } from './QandA.js';
import KuroshiroModule from 'kuroshiro';
import KuromojiAnalyzer from 'kuroshiro-analyzer-kuromoji';

const Kuroshiro = KuroshiroModule.default;
const kuro = new Kuroshiro();
await kuro.init(new KuromojiAnalyzer());

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
    const wavPath = `${audioPath}.wav`;

    let useWav = false;
    if (ffmpegPath) {
      try {
        await execPromise(`"${ffmpegPath}" -i "${audioPath}" -ar 16000 -ac 1 "${wavPath}"`);
        useWav = true;
      } catch (err) {
        console.error(`FFmpeg failed: ${err.message}`);
      }
    }

    const fd = new FormData();
    fd.append('file', fs.createReadStream(useWav ? wavPath : audioPath), {
      filename: path.basename(useWav ? wavPath : audioPath),
      contentType: useWav ? 'audio/wav' : 'audio/webm'
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

    res.json({ text: data.text ?? '' });
  } catch (e) {
    console.error('STT error:', e);
    res.status(500).json({ error: '音声認識失敗' });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    const wav = `${req.file?.path}.wav`;
    if (wav && fs.existsSync(wav)) fs.unlink(wav, () => {});
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
不明点は「園へお問い合わせください」と案内してください。また、絶対に「入園」を「入院」と誤変換して理解しないでください。お問い合わせに「入園」は絶対にありえません。それは100％「入園」の意味です。`;
}

app.post('/ai', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'empty' });

    const sid = sessionId || `s_${Date.now()}`;
    const sess = sessionStorage[sid] ||= { history: [], stage: STAGES.INITIAL };
    sess.history.push({ role: 'user', content: message });
    sess.stage = analyzeStage(message, sess.stage);

    const qaContext = kindergartenQA
      .map(q => `Q: ${q.question}\nA: ${q.answer}`)
      .join('\n');

    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `${systemPrompt()}

以下はホザナ幼稚園の公式Q&Aです：

----- Q&A -----
${qaContext}
----------------`
          },
          ...sess.history.slice(-5)
        ],
        max_tokens: 400,
        temperature: 0.5
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

async function synthesize(text) {
  const fixed = text
    .replace(/副園長/g, 'ふくえんちょう')
    .replace(/入園/g, 'にゅうえん')
    .replace(/園長/g, 'えんちょう')
    .replace(/幼稚園/g, 'ようちえん')
    .replace(/園庭/g, 'えんてい')
    .replace(/園児/g, 'えんじ')
    .replace(/他園/g, 'たえん')
    .replace(/園/g, 'えん')
    .replace(/大坪園子/g, 'おおつぼそのこ');

  const ssmlText = `<speak>${convertMarkdownToSSML(fixed)}</speak>`;

  const { data } = await axios.post(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_API_KEY}`,
    {
      input: { ssml: ssmlText },
      voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.15 }
    }
  );

  return `data:audio/mpeg;base64,${data.audioContent}`;
}

app.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'empty' });
    const audioUrl = await synthesize(text);
    res.json({ audioUrl });
  } catch (e) {
    console.error('TTS error:', e.response?.data || e.message);
    res.status(500).json({ error: 'TTS失敗' });
  }
});

module.exports = app;
