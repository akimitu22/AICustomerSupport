/**
 * ハイブリッド音声認識システム
 * Web Speech API と Whisper API を組み合わせた幼稚園特化の音声認識
 */
class HybridVoiceRecognition {
  /**
   * コンストラクタ
   * @param {Object} options - 設定オプション
   * @param {string} options.language - 言語コード (default: 'ja-JP')
   * @param {string} options.whisperApiEndpoint - Whisper API エンドポイント
   * @param {boolean} options.debug - デバッグモード (default: false)
   * @param {string} options.namespace - グローバル名前空間 (default: 'HybridVoiceRecognition')
   */
  constructor(options = {}) {
    // デフォルト設定とユーザー設定のマージ
    this.options = {
      language: 'ja-JP',
      continuous: true,
      interimResults: true,
      maxAlternatives: 3,
      whisperApiEndpoint: null,
      debug: false,
      namespace: 'HybridVoiceRecognition',
      autoRestart: true,
      confidenceThreshold: 0.7,
      ...options
    };
    
    // 音声認識エンジンの初期化
    this.webSpeechRecognition = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isListening = false;
    this.isProcessing = false;
    this.lastResult = null;
    this.confidenceScores = { webSpeech: 0, whisper: 0 };
    this.resultCallbacks = { interim: null, final: null, error: null };
    
    // 形態素解析のセットアップ
    this.morphAnalyzer = typeof TinySegmenter !== 'undefined' ? new TinySegmenter() : null;
    
    // 修正辞書の初期化
    this.correctionDictionary = {
      // 幼稚園関連の単語修正
      "ようちえん": "幼稚園",
      "ほいくえん": "保育園",
      "あずか": "預か",
      "えんちょう": "園長",
      "せんせい": "先生",
      "ほいく": "保育",
      
      // 願書関連の誤認識パターンを追加
      "眼症": "願書",
      "がんしょう": "願書",
      "がんしょ": "願書",
      "顔書": "願書",
      "顔症": "願書",
      "眼書": "願書",
      "元書": "願書",
      "限症": "願書",
      "眼上": "願書",
      "願症": "願書"
    };
    
    // 幼稚園関連の優先キーワードリスト
    this.priorityKeywords = [
      "ホザナ", "願書", "入園", "募集", "出願", "保育", "幼稚園", "制服"
    ];
    
    // MIME タイプの検出
    this._detectSupportedMimeType();
    
    // 名前空間に自身を登録
    if (this.options.namespace) {
      globalThis[this.options.namespace] = this;
    }
    
    this._log('ハイブリッド音声認識システムを初期化しました');
  }
  
  /**
   * デバッグログ出力
   */
  _log(...args) {
    if (this.options.debug) {
      console.log('[HybridVR]', ...args);
    }
  }
  
  /**
   * エラーログ出力
   */
  _error(...args) {
    console.error('[HybridVR Error]', ...args);
  }
  
  /**
   * サポートされている MIME タイプを検出
   */
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
    
    this.mimeType = types.find(type => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch (e) {
        return false;
      }
    }) || '';
    
    this._log('サポートされているMIMEタイプ:', this.mimeType || 'なし');
  }
  
  /**
   * ブラウザが Web Speech API をサポートしているか確認
   */
  _isSpeechRecognitionSupported() {
    return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  }
  
  /**
   * ブラウザが MediaRecorder をサポートしているか確認
   */
  _isMediaRecorderSupported() {
    return 'MediaRecorder' in window && this.mimeType !== '';
  }
  
  /**
   * Web Speech API の初期化
   */
  _initWebSpeechRecognition() {
    if (!this._isSpeechRecognitionSupported()) {
      this._log('Web Speech APIがサポートされていません');
      return false;
    }
    
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.webSpeechRecognition = new SpeechRecognition();
    
    this.webSpeechRecognition.lang = this.options.language;
    this.webSpeechRecognition.continuous = this.options.continuous;
    this.webSpeechRecognition.interimResults = this.options.interimResults;
    this.webSpeechRecognition.maxAlternatives = this.options.maxAlternatives;
    
    // 結果イベント
    this.webSpeechRecognition.onresult = (event) => {
      const result = event.results[event.resultIndex];
      const text = result[0].transcript.trim();
      const isFinal = result.isFinal;
      
      // 信頼性スコアの計算
      this.confidenceScores.webSpeech = this._calculateConfidenceScore(result);
      
      // 中間結果のコールバック
      if (!isFinal) {
        this._handleInterimResult(text);
        return;
      }
      
      // 最終結果の処理
      this._handleWebSpeechFinalResult(text, result);
    };
    
    // エラーイベント
    this.webSpeechRecognition.onerror = (event) => {
      this._handleSpeechRecognitionError(event);
    };
    
    // 認識終了イベント
    this.webSpeechRecognition.onend = () => {
      this._log('Web Speech認識が終了しました');
      
      // 自動再起動が有効で、まだリスニング中の場合は再起動
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
  
  /**
   * Web Speech APIの中間結果を処理
   */
  _handleInterimResult(text) {
    const correctedText = this._correctText(text);
    
    if (this.resultCallbacks.interim) {
      this.resultCallbacks.interim(correctedText);
    }
  }
  
  /**
   * Web Speech APIの最終結果を処理
   */
  _handleWebSpeechFinalResult(text, result) {
    const correctedText = this._correctText(text);
    
    this.lastResult = {
      text: correctedText,
      engine: 'webSpeech',
      confidence: this.confidenceScores.webSpeech,
      timestamp: Date.now()
    };
    
    // 信頼性スコアが閾値以上なら結果として採用
    if (this.confidenceScores.webSpeech >= this.options.confidenceThreshold) {
      this._notifyResult(this.lastResult);
    } else {
      // 信頼性が低い場合はWhisperを試す
      this._log('Web Speech認識の信頼性が低いため (${this.confidenceScores.webSpeech})、Whisperで試行します');
      this._useWhisperFallback();
    }
  }
  
  /**
   * 信頼性スコアの計算
   */
  _calculateConfidenceScore(result) {
    // 基本スコア（Web Speech APIのconfidence値）
    let baseScore = result[0].confidence || 0;
    
    // 優先キーワードボーナス
    const text = result[0].transcript.toLowerCase();
    const keywordBonus = this.priorityKeywords.some(keyword => 
      text.includes(keyword.toLowerCase())
    ) ? 0.15 : 0;
    
    // 長さによるボーナス（短すぎる・長すぎる場合はペナルティ）
    const lengthScore = text.length > 5 && text.length < 100 ? 0.1 : -0.1;
    
    // 代替候補の類似性ボーナス
    let alternativeScore = 0;
    if (result.length > 1) {
      // 代替候補同士の類似度をチェック
      const alternatives = Array.from({length: Math.min(result.length, 3)}, (_, i) => 
        result[i].transcript.toLowerCase()
      );
      
      // 最初の候補と他の候補の類似性をチェック
      const similarCount = alternatives.slice(1).filter(alt => 
        this._calculateSimilarity(alternatives[0], alt) > 0.7
      ).length;
      
      alternativeScore = similarCount / (alternatives.length - 1) * 0.1;
    }
    
    // 最終スコアの計算（0〜1の範囲に収める）
    const finalScore = Math.min(Math.max(baseScore + keywordBonus + lengthScore + alternativeScore, 0), 1);
    
    this._log(`信頼性スコア計算: base=${baseScore.toFixed(2)}, keyword=${keywordBonus.toFixed(2)}, length=${lengthScore.toFixed(2)}, alt=${alternativeScore.toFixed(2)} => ${finalScore.toFixed(2)}`);
    
    return finalScore;
  }
  
  /**
   * 2つの文字列の類似度を計算（0〜1）
   */
  _calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;
    
    // 編集距離の計算（レーベンシュタイン距離）
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));
    
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;
    
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,       // 削除
          matrix[i][j - 1] + 1,       // 挿入
          matrix[i - 1][j - 1] + cost // 置換
        );
      }
    }
    
    const distance = matrix[len1][len2];
    const maxLen = Math.max(len1, len2);
    
    // 類似度を0〜1の範囲で返す（1が完全一致）
    return maxLen === 0 ? 1 : 1 - distance / maxLen;
  }
  
  /**
   * Web Speech API のエラーハンドリング
   */
  _handleSpeechRecognitionError(event) {
    this._log('Web Speech認識エラー:', event);
    
    // エラー情報の整形
    const errorInfo = {
      error: event.error,
      message: event.message || this._getErrorMessage(event.error),
      engine: 'webSpeech',
      originalError: event
    };
    
    // 特定のエラーは無視して再起動を試みる
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
    
    // マイク許可エラーの場合はWhisperもエラーになるので通知する
    if (event.error === 'not-allowed' || event.error === 'permission-denied') {
      this._notifyError(errorInfo);
      return;
    }
    
    // その他のエラーはWhisperにフォールバック
    this._log('Web Speech認識エラーのため、Whisperにフォールバックします');
    this._useWhisperFallback();
  }
  
  /**
   * エラーコードからメッセージを取得
   */
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
  
  /**
   * MediaRecorder の初期化
   */
  _initMediaRecorder(stream) {
    if (!this._isMediaRecorderSupported()) {
      this._log('MediaRecorderがサポートされていないか、適切なMIMEタイプがありません');
      return false;
    }
    
    try {
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: this.mimeType });
      
      // データ取得イベント
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      
      // 録音停止イベント
      this.mediaRecorder.onstop = () => {
        this._log('MediaRecorder録音停止');
        
        if (this.audioChunks.length === 0) {
          this._log('録音データがありません');
          return;
        }
        
        const audioBlob = new Blob(this.audioChunks, { type: this.mimeType });
        this._sendToWhisperApi(audioBlob);
        
        // チャンクをクリア
        this.audioChunks = [];
      };
      
      // エラーイベント
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
  
  /**
   * Whisper APIにフォールバック
   */
  _useWhisperFallback() {
    // Whisper APIエンドポイントが設定されていなければ終了
    if (!this.options.whisperApiEndpoint) {
      this._log('Whisper APIエンドポイントが設定されていないため、フォールバックできません');
      
      // Web Speechの結果を採用
      if (this.lastResult) {
        this._notifyResult(this.lastResult);
      }
      
      return;
    }
    
    // マイクストリームがなければ終了
    if (!this.micStream) {
      this._log('マイクストリームがないため、Whisperフォールバックできません');
      
      // Web Speechの結果を採用
      if (this.lastResult) {
        this._notifyResult(this.lastResult);
      }
      
      return;
    }
    
    // MediaRecorderが未初期化なら初期化
    if (!this.mediaRecorder) {
      const success = this._initMediaRecorder(this.micStream);
      if (!success) {
        // Web Speechの結果を採用
        if (this.lastResult) {
          this._notifyResult(this.lastResult);
        }
        
        return;
      }
    }
    
    try {
      // MediaRecorderが既に録音中なら一旦停止
      if (this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
        
        // 新しい録音を開始する前に少し待つ
        setTimeout(() => {
          this.audioChunks = [];
          this.mediaRecorder.start();
        }, 100);
        
        return;
      }
      
      // 新しい録音を開始
      this.audioChunks = [];
      this.mediaRecorder.start();
      
      // 5秒後に録音を停止（音声長の制限）
      setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this._log('Whisper用の録音を停止します（タイムアウト）');
          this.mediaRecorder.stop();
        }
      }, 5000);
    } catch (error) {
      this._error('Whisperフォールバック録音の開始に失敗:', error);
      
      // Web Speechの結果を採用
      if (this.lastResult) {
        this._notifyResult(this.lastResult);
      }
    }
  }
  
  /**
   * Whisper APIに音声データを送信
   */
  async _sendToWhisperApi(audioBlob) {
    if (!this.options.whisperApiEndpoint) {
      this._log('Whisper APIエンドポイントが設定されていません');
      return;
    }
    
    this.isProcessing = true;
    
    try {
      // Blobデータをbase64エンコード
      const base64Audio = await this._blobToBase64(audioBlob);
      
      // 音声の長さを推定
      const audioDuration = await this._estimateAudioDuration(audioBlob);
      this._log(`音声データ: ${(audioBlob.size / 1024).toFixed(2)} KB, 推定時間: ${(audioDuration / 1000).toFixed(2)}秒`);
      
      // 短すぎる音声は処理しない（ノイズ防止）
      if (audioDuration < 300) { // 300ms未満
        this._log('音声が短すぎるため、処理をスキップします');
        this.isProcessing = false;
        
        // Web Speechの結果を採用
        if (this.lastResult) {
          this._notifyResult(this.lastResult);
        }
        
        return;
      }
      
      // Whisper APIにリクエスト
      const response = await fetch(this.options.whisperApiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          audio: base64Audio,
          language: this.options.language.split('-')[0],
          mimeType: this.mimeType
        })
      });
      
      if (!response.ok) {
        throw new Error(`Whisper APIエラー: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data.text) {
        throw new Error('Whisper APIから空のレスポンスが返されました');
      }
      
      // レスポンスの処理
      const correctedText = this._correctText(data.text);
      
      // 信頼性スコアの計算（Whisperは返さないので独自に計算）
      this.confidenceScores.whisper = this._calculateWhisperConfidence(
        correctedText, audioDuration
      );
      
      const whisperResult = {
        text: correctedText,
        engine: 'whisper',
        confidence: this.confidenceScores.whisper,
        timestamp: Date.now()
      };
      
      // Web Speech結果とWhisper結果を比較し、より良い方を採用
      this._selectBestResult(whisperResult);
    } catch (error) {
      this._error('Whisper API処理エラー:', error);
      
      // エラー通知
      this._notifyError({
        error: 'whisper-api-error',
        message: 'Whisper API処理中にエラーが発生しました',
        engine: 'whisper',
        originalError: error
      });
      
      // Web Speechの結果を採用
      if (this.lastResult) {
        this._notifyResult(this.lastResult);
      }
    } finally {
      this.isProcessing = false;
    }
  }
  
  /**
   * Whisperの信頼性スコアを計算
   */
  _calculateWhisperConfidence(text, duration) {
    if (!text) return 0;
    
    // テキストの長さに基づくスコア
    const textLength = text.length;
    let lengthScore = 0;
    
    if (textLength < 3) {
      lengthScore = 0.2; // 非常に短いテキストは低信頼性
    } else if (textLength < 10) {
      lengthScore = 0.5; // 短いテキストは中程度の信頼性
    } else if (textLength < 50) {
      lengthScore = 0.8; // 適切な長さは高信頼性
    } else {
      lengthScore = 0.7; // 長すぎるテキストはやや減点
    }
    
    // 音声の長さに基づくスコア
    const durationSec = duration / 1000;
    let durationScore = 0;
    
    if (durationSec < 0.5) {
      durationScore = 0.3; // 非常に短い音声は低信頼性
    } else if (durationSec < 1.0) {
      durationScore = 0.5; // 短い音声は中程度の信頼性
    } else if (durationSec < 5.0) {
      durationScore = 0.8; // 適切な長さは高信頼性
    } else {
      durationScore = 0.6; // 長すぎる音声はやや減点
    }
    
    // 優先キーワードボーナス
    const textLower = text.toLowerCase();
    const keywordBonus = this.priorityKeywords.some(keyword => 
      textLower.includes(keyword.toLowerCase())
    ) ? 0.15 : 0;
    
    // 最終スコアの計算（0〜1の範囲に収める）
    const finalScore = Math.min(Math.max(
      (lengthScore * 0.5 + durationScore * 0.5) + keywordBonus, 0
    ), 1);
    
    this._log(`Whisper信頼性スコア計算: length=${lengthScore.toFixed(2)}, duration=${durationScore.toFixed(2)}, keyword=${keywordBonus.toFixed(2)} => ${finalScore.toFixed(2)}`);
    
    return finalScore;
  }
  
  /**
   * Web SpeechとWhisperの結果を比較し、より良い方を選択
   */
  _selectBestResult(whisperResult) {
    // Web Speechの結果がなければWhisperを採用
    if (!this.lastResult) {
      this._notifyResult(whisperResult);
      return;
    }
    
    const webSpeechConfidence = this.confidenceScores.webSpeech;
    const whisperConfidence = this.confidenceScores.whisper;
    
    // 時間差が大きい場合は最新の結果を優先
    const timeDiff = Math.abs(whisperResult.timestamp - this.lastResult.timestamp);
    if (timeDiff > 5000) { // 5秒以上の差
      this._log('時間差が大きいため、最新の結果を採用します');
      this._notifyResult(whisperResult);
      return;
    }
    
    // 信頼性スコアを比較
    if (whisperConfidence > webSpeechConfidence + 0.1) {
      // Whisperが明らかに良い
      this._log(`Whisperの結果を採用: ${whisperConfidence.toFixed(2)} > ${webSpeechConfidence.toFixed(2)}`);
      this._notifyResult(whisperResult);
    } else {
      // Web Speechが同等以上
      this._log(`Web Speechの結果を採用: ${webSpeechConfidence.toFixed(2)} >= ${whisperConfidence.toFixed(2)}`);
      this._notifyResult(this.lastResult);
    }
  }
  
  /**
   * 最終結果を通知
   */
  _notifyResult(result) {
    if (this.resultCallbacks.final) {
      this.resultCallbacks.final(result);
    }
  }
  
  /**
   * エラーを通知
   */
  _notifyError(error) {
    if (this.resultCallbacks.error) {
      this.resultCallbacks.error(error);
    }
  }
  
  /**
   * 音声認識の開始
   * @param {function} interimCallback - 中間結果のコールバック
   * @param {function} finalCallback - 最終結果のコールバック
   * @param {function} errorCallback - エラー発生時のコールバック
   */
  startListening(interimCallback, finalCallback, errorCallback) {
    // 既にリスニング中なら何もしない
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
    
    // マイクへのアクセス要求
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        this.micStream = stream;
        
        // Web Speech API の初期化
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
        
        // MediaRecorder の初期化（Whisper API用）
        if (this.options.whisperApiEndpoint) {
          this._initMediaRecorder(stream);
        }
      })
      .catch((error) => {
        this.isListening = false;
        this._error('マイクアクセスエラー:', error);
        
        // エラー通知
        this._notifyError({
          error: 'mic-permission',
          message: 'マイクへのアクセス許可がありません',
          engine: 'system',
          originalError: error
        });
      });
  }
  
  /**
   * 音声認識の停止
   */
  stopListening() {
    // リスニング中でなければ何もしない
    if (!this.isListening) {
      this._log('リスニング中ではありません');
      return;
    }
    
    this.isListening = false;
    
    // Web Speech API の停止
    if (this.webSpeechRecognition) {
      try {
        this.webSpeechRecognition.stop();
        this._log('Web Speech認識を停止しました');
      } catch (error) {
        this._error('Web Speech認識の停止に失敗:', error);
      }
    }
    
    // MediaRecorder の停止
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try {
        this.mediaRecorder.stop();
        this._log('MediaRecorderを停止しました');
      } catch (error) {
        this._error('MediaRecorderの停止に失敗:', error);
      }
    }
    
    // マイクストリームの停止
    if (this.micStream) {
      try {
        this.micStream.getTracks().forEach(track => track.stop());
        this._log('マイクストリームを停止しました');
      } catch (error) {
        this._error('マイクストリームの停止に失敗:', error);
      }
      
      this.micStream = null;
    }
    
    // 変数のクリア
    this.audioChunks = [];
    this.lastResult = null;
  }
  
  /**
   * 幼稚園特化のテキスト修正
   */
  _correctText(text) {
    if (!text) return '';
    
    let corrected = text;
    
    // 「願書」の特別処理（最優先）
    const ganshoPriority = [
      /眼症/g, /がんしょう/g, /がんしょ/g, /顔書/g, /顔症/g, 
      /眼書/g, /元書/g, /限症/g, /眼上/g, /願症/g
    ];
    
    // 入園関連のキーワードが近くにあるかチェック
    const hasEnrollmentContext = /入園|出願|申し込み|提出|書類|手続き|入学|募集|受付|必要|入園の|用紙|資料|請求/i.test(corrected);
    
    // 入園関連の文脈がある場合、または単独で「眼症」などが出てきた場合
    if (hasEnrollmentContext || ganshoPriority.some(pattern => pattern.test(corrected))) {
      for (const pattern of ganshoPriority) {
        corrected = corrected.replace(pattern, '願書');
      }
    }
    
    // 「ホザナ」の特別処理
    // ホザナに似た発音のパターンを検出して置換
    const hosanaPatterns = [
      /[ほホ][うウゥーさザ][なナざザ][なナ]?/gi,
      /[ほホ][ーさザ][なナざザ][なナ]?/gi,
      /[ほホ][さザ][なナ][なナ]?/gi
    ];
    
    for (const pattern of hosanaPatterns) {
      corrected = corrected.replace(pattern, 'ホザナ');
    }
    
    // 文中に「幼稚園」が出てきて園の名前がない場合、「ホザナ幼稚園」に補完
    if (/幼稚園/gi.test(corrected) && !(/ホザナ/gi.test(corrected))) {
      corrected = corrected.replace(/幼稚園/gi, 'ホザナ幼稚園');
    }
    
    // 「〜が欲しい」や「〜はどこ」などの表現で「願書」のコンテキストを検出
    if (/[がは](欲しい|ほしい|どこ|どれ|必要)/i.test(corrected)) {
      corrected = corrected.replace(/眼症|がんしょう|がんしょ|顔書|顔症/gi, '願書');
    }
    
    // 「〜行ったらいい」などの質問形式での文脈でも「願書」に修正
    if (/行った(ら|方が)いい|行け(ば|ます)|もらえ(る|ます)|入手/i.test(corrected)) {
      corrected = corrected.replace(/眼症|がんしょう|がんしょ|顔書|顔症/gi, '願書');
    }
    
    // 形態素解析が利用可能な場合は、より精密な修正を適用
    if (this.morphAnalyzer) {
      corrected = this._correctWithMorphology(corrected);
    } else {
      // 形態素解析が利用できない場合は辞書ベースの修正
      Object.entries(this.correctionDictionary).forEach(([pattern, replacement]) => {
        // 単純な文字列置換ではなく、単語境界を考慮
        const regex = new RegExp(`\\b${pattern}\\b`, 'gi');
        corrected = corrected.replace(regex, replacement);
      });
    }
    
    // 「円」→「園」の特殊変換 (前後の文脈を考慮)
    // 金額として明らかな場合は変換しない
    corrected = corrected.replace(/(\d+)([万千百十]?)円/g, '$1$2円'); // 数字+円はそのまま
    // 数字以外+円は園に変換（より厳密な条件）
    corrected = corrected.replace(/([^\d０-９万千百十])円/g, '$1園');
    
    // 「保育園」が「保育員」になる誤りを修正
    corrected = corrected.replace(/保育員/g, '保育園');
    
    // 「預かり保育」が「預かり保険」になる誤りを修正
    corrected = corrected.replace(/預かり保険/g, '預かり保育');
    
    // 「制服」が「征服」「正服」になる誤りを修正
    corrected = corrected.replace(/征服|正服/g, '制服');
    
    // 保育園、幼稚園などの語彙が欠けている場合に補完
    if (/園に(つい|関し|ある|入り)/i.test(corrected) && !/(幼稚園|保育園|こども園)/i.test(corrected)) {
      corrected = corrected.replace(/園に/i, 'ホザナ幼稚園に');
    }
    
    // 「〜しますか？」が「〜しますから？」になる誤りを修正
    corrected = corrected.replace(/しますから\?/g, 'しますか?');
    
    // ひらがなだけの「ようちえん」を「幼稚園」に変換
    corrected = corrected.replace(/ようちえん/g, '幼稚園');
    
    // 最終的なログ出力（デバッグ用）
    if (this.options.debug && corrected !== text) {
      this._log(`テキスト修正: "${text}" → "${corrected}"`);
    }
    
    return corrected;
  }
  
  /**
   * 形態素解析を使用したテキスト修正
   */
  _correctWithMorphology(text) {
    // 形態素解析が利用できない場合は元のテキストを返す
    if (!this.morphAnalyzer) return text;
    
    try {
      // テキストを分かち書き
      const tokens = this.morphAnalyzer.segment(text);
      
      // 修正後のトークン
      const correctedTokens = [];
      
      // 各トークンに対して修正を適用
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        
        // 辞書に登録されているかチェック
        const lowerToken = token.toLowerCase();
        if (this.correctionDictionary[lowerToken]) {
          correctedTokens.push(this.correctionDictionary[lowerToken]);
        } else if (lowerToken === 'えん' || lowerToken === '円') {
          // 「円」「えん」の特殊処理
          // 前のトークンが数字または単位の場合は「円」のまま
          const prevToken = i > 0 ? tokens[i-1] : '';
          const isNumber = /^[0-9０-９]+$/.test(prevToken);
          const isUnit = /[万千百十]/.test(prevToken);
          
          if (isNumber || isUnit) {
            correctedTokens.push('円');
          } else {
            correctedTokens.push('園');
          }
        } else {
          // その他のトークンはそのまま
          correctedTokens.push(token);
        }
      }
      
      // トークンを結合して返す
      return correctedTokens.join('');
    } catch (error) {
      this._error('形態素解析処理エラー:', error);
      return text; // エラー時は元のテキストを返す
    }
  }
  
  /**
   * 音声の長さを推定
   */
  async _estimateAudioDuration(audioBlob) {
    return new Promise((resolve, reject) => {
      const audioElement = new Audio();
      audioElement.src = URL.createObjectURL(audioBlob);
      
      audioElement.onloadedmetadata = () => {
        const duration = audioElement.duration * 1000; // ミリ秒に変換
        URL.revokeObjectURL(audioElement.src);
        resolve(duration);
      };
      
      audioElement.onerror = (error) => {
        URL.revokeObjectURL(audioElement.src);
        this._log('音声長推定エラー:', error);
        
        // 推定できない場合はサイズから概算
        const durationEstimate = audioBlob.size / 16000; // 16kbps想定
        resolve(durationEstimate);
      };
      
      // 10秒以上待っても読み込まれない場合のタイムアウト
      setTimeout(() => {
        URL.revokeObjectURL(audioElement.src);
        this._log('音声長推定タイムアウト');
        
        // サイズから概算
        const durationEstimate = audioBlob.size / 16000;
        resolve(durationEstimate);
      }, 10000);
    });
  }
  
  /**
   * BlobをBase64に変換
   */
  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        // "data:audio/webm;base64," を除去
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  
  /**
   * リソース解放
   */
  dispose() {
    this.stopListening();
    
    // 名前空間から削除
    if (globalThis[this.options.namespace]) {
      delete globalThis[this.options.namespace];
    }
    
    this._log('リソースを解放しました');
  }
}

// グローバルに公開（名前空間を使用）
if (!globalThis.HybridVoiceRecognition) {
  globalThis.HybridVoiceRecognition = HybridVoiceRecognition;
}