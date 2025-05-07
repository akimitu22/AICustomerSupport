/**
 * ハイブリッド音声認識システム
 * Web Speech API と Whisper API を組み合わせた幼稚園特化の音声認識
 */
const correctionDictionary = {
  "ようちえん": "幼稚園",
  "ほいくえん": "保育園",
  "願症": "願書"
};
const kanaCorrectionMap = new Map([
  ["ようちえん", "幼稚園"],
  ["ほいくえん", "保育園"]
]);

// ブラウザ固有のAPI
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

class HybridVoiceRecognition {
  constructor(options = {}) {
    this.options = {
      language: 'ja-JP',
      continuous: true,
      interimResults: true,
      maxAlternatives: 3,
      whisperApiEndpoint: '/api/stt', // Netlify関数のエンドポイント
      debug: false,
      namespace: 'HybridVoiceRecognition',
      autoRestart: true,
      confidenceThreshold: 0.7,
      ...options
    };

    this.webSpeechRecognition = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isListening = false;
    this.isProcessing = false;
    this.lastResult = null;
    this.confidenceScores = { webSpeech: 0, whisper: 0 };
    this.resultCallbacks = { interim: null, final: null, error: null };

    this.morphAnalyzer = typeof TinySegmenter !== 'undefined' ? new TinySegmenter() : null;

    this.correctionDictionary = correctionDictionary;
    this.kanaCorrectionMap = kanaCorrectionMap;

    this.priorityKeywords = [
      "ホザナ", "願書", "入園", "募集", "出願", "保育", "幼稚園", "制服"
    ];

    this._detectSupportedMimeType();

    if (this.options.namespace) {
      window[this.options.namespace] = this;
    }

    this._log('ハイブリッド音声認識システムを初期化しました');
  }
  
  _log(...args) {
    if (this.options.debug) {
      console.log('[HybridVR]', ...args);
    }
  }
  
  _error(...args) {
    console.error('[HybridVR Error]', ...args);
  }
  
  _detectSupportedMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/mpeg',
      'audio/wav',
      'audio/aac'
    ];
    
    this.mimeType = MediaRecorder ? types.find(type => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch (e) {
        return false;
      }
    }) || '' : '';
    
    this._log('サポートされているMIMEタイプ:', this.mimeType || 'なし');
  }
  
  _isSpeechRecognitionSupported() {
    return SpeechRecognition !== null;
  }
  
  _isMediaRecorderSupported() {
    return MediaRecorder !== null && this.mimeType !== '';
  }
  
  _initWebSpeechRecognition() {
    if (!this._isSpeechRecognitionSupported()) {
      this._log('Web Speech APIがサポートされていません');
      return false;
    }
    
    this.webSpeechRecognition = new SpeechRecognition();
    
    this.webSpeechRecognition.lang = this.options.language;
    this.webSpeechRecognition.continuous = this.options.continuous;
    this.webSpeechRecognition.interimResults = this.options.interimResults;
    this.webSpeechRecognition.maxAlternatives = this.options.maxAlternatives;
    
    this.webSpeechRecognition.onresult = (event) => {
      const result = event.results[event.resultIndex];
      const text = result[0].transcript.trim();
      const isFinal = result.isFinal;
      
      this.confidenceScores.webSpeech = this._calculateConfidenceScore(result);
      
      if (!isFinal) {
        this._handleInterimResult(text);
        return;
      }
      
      this._handleWebSpeechFinalResult(text, result);
    };
    
    this.webSpeechRecognition.onerror = (event) => {
      this._handleSpeechRecognitionError(event);
    };
    
    this.webSpeechRecognition.onend = () => {
      this._log('Web Speech認識が終了しました');
      
      if (this.options.autoRestart && this.isListening && !this.isProcessing) {
        this._log('Web Speech認識を再起動します');
        try {
          this.webSpeechRecognition.start();
        } catch (error) {
          this._error('Web Speech認識の再起動に失敗:', error);
          this._notifyError({
            error: 'restart-failed',
            message: 'Web Speech認識の再起動に失敗しました',
            engine: 'webSpeech',
            originalError: error
          });
        }
      }
    };
    
    return true;
  }
  
  _handleInterimResult(text) {
    const correctedText = this._correctText(text);
    
    if (this.resultCallbacks.interim) {
      this.resultCallbacks.interim(correctedText);
    }
  }
  
  _handleWebSpeechFinalResult(text, result) {
    const correctedText = this._correctText(text);
    
    this.lastResult = {
      text: correctedText,
      engine: 'webSpeech',
      confidence: this.confidenceScores.webSpeech,
      timestamp: Date.now()
    };
    
    if (this.confidenceScores.webSpeech >= this.options.confidenceThreshold) {
      this._notifyResult(this.lastResult);
    } else {
      this._log(`Web Speech認識の信頼性が低いため (${this.confidenceScores.webSpeech})、Whisperで試行します`);
      this._useWhisperFallback();
    }
  }
  
  _calculateConfidenceScore(result) {
    let baseScore = result[0].confidence || 0;
    
    const text = result[0].transcript.toLowerCase();
    const keywordBonus = this.priorityKeywords.some(keyword => 
      text.includes(keyword.toLowerCase())
    ) ? 0.15 : 0;
    
    const lengthScore = text.length > 5 && text.length < 100 ? 0.1 : -0.1;
    
    let alternativeScore = 0;
    if (result.length > 1) {
      const alternatives = Array.from({length: Math.min(result.length, 3)}, (_, i) => 
        result[i].transcript.toLowerCase()
      );
      
      const similarCount = alternatives.slice(1).filter(alt => 
        this._calculateSimilarity(alternatives[0], alt) > 0.7
      ).length;
      
      alternativeScore = similarCount / (alternatives.length - 1) * 0.1;
    }
    
    const finalScore = Math.min(Math.max(baseScore + keywordBonus + lengthScore + alternativeScore, 0), 1);
    
    this._log(`信頼性スコア計算: base=${baseScore.toFixed(2)}, keyword=${keywordBonus.toFixed(2)}, length=${lengthScore.toFixed(2)}, alt=${alternativeScore.toFixed(2)} => ${finalScore.toFixed(2)}`);
    
    return finalScore;
  }
  
  _calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;
    
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));
    
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    
    const distance = matrix[len1][len2];
    const maxLen = Math.max(len1, len2);
    
    return maxLen === 0 ? 1 : 1 - distance / maxLen;
  }
  
  _handleSpeechRecognitionError(event) {
    this._log('Web Speech認識エラー:', event);
    
    const errorInfo = {
      error: event.error,
      message: event.message || this._getErrorMessage(event.error),
      engine: 'webSpeech',
      originalError: event
    };
    
    const ignorableErrors = ['network', 'aborted', 'no-speech'];
    if (ignorableErrors.includes(event.error) && this.options.autoRestart && this.isListening) {
      this._log('無視可能なエラーのため再起動を試みます:', event.error);
      setTimeout(() => {
        try {
          this.webSpeechRecognition.start();
        } catch (e) {
          this._error('エラー後の再起動に失敗:', e);
        }
      }, 1000);
      return;
    }
    
    if (event.error === 'not-allowed' || event.error === 'permission-denied') {
      this._notifyError(errorInfo);
      return;
    }
    
    this._log('Web Speech認識エラーのため、Whisperにフォールバックします');
    this._useWhisperFallback();
  }
  
  _getErrorMessage(errorCode) {
    const errorMessages = {
      'aborted': '音声認識が中断されました',
      'audio-capture': 'オーディオキャプチャに失敗しました',
      'network': 'ネットワークエラーが発生しました',
      'no-speech': '音声が検出されませんでした',
      'not-allowed': 'マイクの使用許可がありません',
      'permission-denied': 'マイクの使用許可がありません',
      'service-not-allowed': 'サービスの使用が許可されていません',
      'bad-grammar': '不正な文法が指定されました',
      'language-not-supported': '指定された言語はサポートされていません',
      'no-match': '認識結果が一致しませんでした',
      'service-unavailable': 'サービスが利用できません'
    };
    
    return errorMessages[errorCode] || `未知のエラー: ${errorCode}`;
  }
  
  _initMediaRecorder(stream) {
    if (!this._isMediaRecorderSupported()) {
      this._log('MediaRecorderがサポートされていないか、適切なMIMEタイプがありません');
      return false;
    }
    
    try {
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: this.mimeType });
      
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      
      this.mediaRecorder.onstop = () => {
        this._log('MediaRecorder録音停止');
        
        if (this.audioChunks.length === 0) {
          this._log('録音データがありません');
          return;
        }
        
        const audioBlob = new Blob(this.audioChunks, { type: this.mimeType });
        this._sendToWhisperApi(audioBlob);
        
        this.audioChunks = [];
      };
      
      this.mediaRecorder.onerror = (error) => {
        this._error('MediaRecorderエラー:', error);
        
        this._notifyError({
          error: 'recorder-error',
          message: 'MediaRecorderエラーが発生しました',
          engine: 'whisper',
          originalError: error
        });
      };
      
      return true;
    } catch (error) {
      this._error('MediaRecorderの初期化に失敗:', error);
      
      this._notifyError({
        error: 'recorder-init-failed',
        message: 'MediaRecorderの初期化に失敗しました',
        engine: 'whisper',
        originalError: error
      });
      
      return false;
    }
  }
  
  _useWhisperFallback() {
    if (!this.options.whisperApiEndpoint) {
      this._log('Whisper APIエンドポイントが設定されていないため、フォールバックできません');
      
      if (this.lastResult) {
        this._notifyResult(this.lastResult);
      }
      
      return;
    }
    
    if (!this.micStream) {
      this._log('マイクストリームがないため、Whisperフォールバックできません');
      
      if (this.lastResult) {
        this._notifyResult(this.lastResult);
      }
      
      return;
    }
    
    if (!this.mediaRecorder) {
      const success = this._initMediaRecorder(this.micStream);
      if (!success) {
        if (this.lastResult) {
          this._notifyResult(this.lastResult);
        }
        
        return;
      }
    }
    
    try {
      if (this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
        
        setTimeout(() => {
          this.audioChunks = [];
          this.mediaRecorder.start();
        }, 100);
        
        return;
      }
      
      this.audioChunks = [];
      this.mediaRecorder.start();
      
      setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this._log('Whisper用の録音を停止します（タイムアウト）');
          this.mediaRecorder.stop();
        }
      }, 5000);
    } catch (error) {
      this._error('Whisperフォールバック録音の開始に失敗:', error);
      
      if (this.lastResult) {
        this._notifyResult(this.lastResult);
      }
    }
  }
  
  async _sendToWhisperApi(audioBlob) {
    if (!this.options.whisperApiEndpoint) {
      this._log('Whisper APIエンドポイントが設定されていません');
      return;
    }
    
    this.isProcessing = true;
    
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, {
        filename: 'audio.webm',
        contentType: this.mimeType
      });
      
      const response = await fetch(this.options.whisperApiEndpoint, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        throw new Error(`Whisper APIエラー: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data.text) {
        throw new Error('Whisper APIから空のレスポンスが返されました');
      }
      
      const correctedText = this._correctText(data.text);
      
      this.confidenceScores.whisper = this._calculateWhisperConfidence(
        correctedText, await this._estimateAudioDuration(audioBlob)
      );
      
      const whisperResult = {
        text: correctedText,
        engine: 'whisper',
        confidence: this.confidenceScores.whisper,
        timestamp: Date.now()
      };
      
      this._selectBestResult(whisperResult);
    } catch (error) {
      this._error('Whisper API処理エラー:', error);
      
      this._notifyError({
        error: 'whisper-api-error',
        message: 'Whisper API処理中にエラーが発生しました',
        engine: 'whisper',
        originalError: error
      });
      
      if (this.lastResult) {
        this._notifyResult(this.lastResult);
      }
    } finally {
      this.isProcessing = false;
    }
  }
  
  _calculateWhisperConfidence(text, duration) {
    if (!text) return 0;
    
    const textLength = text.length;
    let lengthScore = 0;
    
    if (textLength < 3) {
      lengthScore = 0.2;
    } else if (textLength < 10) {
      lengthScore = 0.5;
    } else if (textLength < 50) {
      lengthScore = 0.8;
    } else {
      lengthScore = 0.7;
    }
    
    const durationSec = duration / 1000;
    let durationScore = 0;
    
    if (durationSec < 0.5) {
      durationScore = 0.3;
    } else if (durationSec < 1.0) {
      durationScore = 0.5;
    } else if (durationSec < 5.0) {
      durationScore = 0.8;
    } else {
      durationScore = 0.6;
    }
    
    const textLower = text.toLowerCase();
    const keywordBonus = this.priorityKeywords.some(keyword => 
      textLower.includes(keyword.toLowerCase())
    ) ? 0.15 : 0;
    
    const finalScore = Math.min(Math.max(
      (lengthScore * 1.0 + durationScore * 1.0) + keywordBonus, 0
    ), 1);
    
    this._log(`Whisper信頼性スコア計算: length=${lengthScore.toFixed(2)}, duration=${durationScore.toFixed(2)}, keyword=${keywordBonus.toFixed(2)} => ${finalScore.toFixed(2)}`);
    
    return finalScore;
  }
  
  _selectBestResult(whisperResult) {
    if (!this.lastResult) {
      this._notifyResult(whisperResult);
      return;
    }
    
    const webSpeechConfidence = this.confidenceScores.webSpeech;
    const whisperConfidence = this.confidenceScores.whisper;
    
    const timeDiff = Math.abs(whisperResult.timestamp - this.lastResult.timestamp);
    if (timeDiff > 5000) {
      this._log('時間差が大きいため、最新の結果を採用します');
      this._notifyResult(whisperResult);
      return;
    }
    
    if (whisperConfidence > webSpeechConfidence + 0.1) {
      this._log(`Whisperの結果を採用: ${whisperConfidence.toFixed(2)} > ${webSpeechConfidence.toFixed(2)}`);
      this._notifyResult(whisperResult);
    } else {
      this._log(`Web Speechの結果を採用: ${webSpeechConfidence.toFixed(2)} >= ${whisperConfidence.toFixed(2)}`);
      this._notifyResult(this.lastResult);
    }
  }
  
  _notifyResult(result) {
    if (this.resultCallbacks.final) {
      this.resultCallbacks.final(result);
    }
  }
  
  _notifyError(error) {
    if (this.resultCallbacks.error) {
      this.resultCallbacks.error(error);
    }
  }
  
  startListening(interimCallback, finalCallback, errorCallback) {
    if (this.isListening) {
      this._log('既にリスニング中です');
      return;
    }
    
    this.isListening = true;
    this.audioChunks = [];
    this.resultCallbacks = {
      interim: interimCallback,
      final: finalCallback,
      error: errorCallback
    };
    
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        this.micStream = stream;
        
        if (this._isSpeechRecognitionSupported()) {
          const success = this._initWebSpeechRecognition();
          
          if (success) {
            try {
              this.webSpeechRecognition.start();
              this._log('Web Speech認識を開始しました');
            } catch (error) {
              this._error('Web Speech認識の開始に失敗:', error);
            }
          }
        } else {
          this._log('Web Speech APIがサポートされていないため、Whisperのみを使用します');
        }
        
        if (this.options.whisperApiEndpoint) {
          this._initMediaRecorder(stream);
        }
      })
      .catch((error) => {
        this.isListening = false;
        this._error('マイクアクセスエラー:', error);
        
        this._notifyError({
          error: 'mic-permission',
          message: 'マイクへのアクセス許可がありません',
          engine: 'system',
          originalError: error
        });
      });
  }
  
  stopListening() {
    if (!this.isListening) {
      this._log('リスニング中ではありません');
      return;
    }
    
    this.isListening = false;
    
    if (this.webSpeechRecognition) {
      try {
        this.webSpeechRecognition.stop();
        this._log('Web Speech認識を停止しました');
      } catch (error) {
        this._error('Web Speech認識の停止に失敗:', error);
      }
    }
    
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try {
        this.mediaRecorder.stop();
        this._log('MediaRecorderを停止しました');
      } catch (error) {
        this._error('MediaRecorderの停止に失敗:', error);
      }
    }
    
    if (this.micStream) {
      try {
        this.micStream.getTracks().forEach(track => track.stop());
        this._log('マイクストリームを停止しました');
      } catch (error) {
        this._error('マイクストリームの停止に失敗:', error);
      }
      
      this.micStream = null;
    }
    
    this.audioChunks = [];
    this.lastResult = null;
  }
  
  _correctText(text) {
    if (!text) return '';
    
    if (this.kanaCorrectionMap && this.kanaCorrectionMap.size) {
      text = this.kanaCorrectionMap.get(text) || text;
    }

    let corrected = text;
    
    const ganshoPriority = [
      /眼症/g, /がんしょう/g, /がんしょ/g, /顔書/g, /顔症/g, 
      /眼書/g, /元書/g, /限症/g, /眼上/g, /願症/g
    ];
    
    const hasEnrollmentContext = /入園|出願|申し込み|提出|書類|手続き|入学|募集|受付|必要|入園の|用紙|資料|請求/i.test(corrected);
    
    if (hasEnrollmentContext || ganshoPriority.some(pattern => pattern.test(corrected))) {
      for (const pattern of ganshoPriority) {
        corrected = corrected.replace(pattern, '願書');
      }
    }
    
    const hosanaPatterns = [
      /[ほホ][うウゥーさザ][なナざザ][なナ]?/gi,
      /[ほホ][ーさザ][なナざザ][なナ]?/gi,
      /[ほホ][さザ][なナ][なナ]?/gi
    ];
    
    for (const pattern of hosanaPatterns) {
      corrected = corrected.replace(pattern, 'ホザナ');
    }
    
    if (/幼稚園/gi.test(corrected) && !(/ホザナ/gi.test(corrected))) {
      corrected = corrected.replace(/幼稚園/gi, 'ホザナ幼稚園');
    }
    
    if (/[がは](欲しい|ほしい|どこ|どれ|必要)/i.test(corrected)) {
      corrected = corrected.replace(/眼症|がんしょう|がんしょ|顔書|顔症/gi, '願書');
    }
    
    if (/行った(ら|方が)いい|行け(ば|ます)|もらえ(る|ます)|入手/i.test(corrected)) {
      corrected = corrected.replace(/眼症|がんしょう|がんしょ|顔書|顔症/gi, '願書');
    }
    
    if (this.morphAnalyzer) {
      corrected = this._correctWithMorphology(corrected);
    } else {
      Object.entries(this.correctionDictionary).forEach(([pattern, replacement]) => {
        const regex = new RegExp(`\\b${pattern}\\b`, 'gi');
        corrected = corrected.replace(regex, replacement);
      });
    }
    
    corrected = corrected.replace(/(\d+)([万千百十]?)円/g, '$1$2円');
    corrected = corrected.replace(/([^\d０-９万千百十])円/g, '$1園');
        
    corrected = corrected.replace(/扱い保育/g, '預かり保育');
    corrected = corrected.replace(/征服|正服/g, '制服');
    corrected = corrected.replace(/児玉幼稚園|小棚幼稚園/g, 'ホザナ幼稚園');
    corrected = corrected.replace(/\b扱い(保育|時間)\b/g, '預かり$1');
    
    if (/園に(つい|関し|ある|入り)/i.test(corrected) && !/(幼稚園|保育園|こども園)/i.test(corrected)) {
      corrected = corrected.replace(/園に/i, 'ホザナ幼稚園に');
    }
    
    corrected = corrected.replace(/しますから\?/g, 'しますか?');
    corrected = corrected.replace(/ようちえん/g, '幼稚園');
    
    if (this.options.debug && corrected !== text) {
      this._log(`テキスト修正: "${text}" → "${corrected}"`);
    }
    
    return corrected;
  }
  
  _correctWithMorphology(text) {
    if (!this.morphAnalyzer) return text;
    
    try {
      const tokens = this.morphAnalyzer.segment(text);
      const correctedTokens = [];
      
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const lowerToken = token.toLowerCase();
        if (this.correctionDictionary[lowerToken]) {
          correctedTokens.push(this.correctionDictionary[lowerToken]);
        } else if (lowerToken === 'えん' || lowerToken === '円') {
          const prevToken = i > 0 ? tokens[i-1] : '';
          const isNumber = /^[0-9０-９]+$/.test(prevToken);
          const isUnit = /[万千百十]/.test(prevToken);
          
          if (isNumber || isUnit) {
            correctedTokens.push('円');
          } else {
            correctedTokens.push('園');
          }
        } else {
          correctedTokens.push(token);
        }
      }
      
      return correctedTokens.join('');
    } catch (error) {
      this._error('形態素解析処理エラー:', error);
      return text;
    }
  }
  
  async _estimateAudioDuration(audioBlob) {
    return new Promise((resolve) => {
      const audio = new Audio(URL.createObjectURL(audioBlob));
      audio.onloadedmetadata = () => {
        resolve(audio.duration * 1000);
        URL.revokeObjectURL(audio.src);
      };
      audio.onerror = () => {
        resolve(audioBlob.size / 16000);
      };
    });
  }
  
  dispose() {
    this.stopListening();
    
    if (window[this.options.namespace]) {
      delete window[this.options.namespace];
    }
    
    this._log('リソースを解放しました');
  }
}

if (!window.HybridVoiceRecognition) {
  window.HybridVoiceRecognition = HybridVoiceRecognition;
}