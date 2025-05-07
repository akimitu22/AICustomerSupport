/**
 * 幼稚園特化型ハイブリッド音声認識 - 改良版
 * Web Speech API と Whisper API を組み合わせて精度を向上
 * 実運用環境を想定した堅牢な実装
 */
class HybridVoiceRecognition {
  constructor(options = {}) {
    this.options = {
      language: 'ja-JP',
      shortUtteranceThreshold: 3000, // 3秒以下は短い発話とみなす
      whisperApiEndpoint: './.netlify/functions/stt', // 相対パスに修正
      maxAudioSize: 8 * 1024 * 1024, // 8MBを上限に
      namespace: '_hybridVR', // グローバル名前空間
      debug: false,
      ...options
    };
    
    // グローバル名前空間の初期化
    if (!globalThis[this.options.namespace]) {
      globalThis[this.options.namespace] = {};
    }
    
    // Web Speech API の初期化
    this.webSpeechRecognition = null;
    this.webSpeechSupported = this._initWebSpeech();
    
    // MediaRecorder用のストリーム
    this.stream = null;
    
    // 幼稚園特化の修正辞書
    this.correctionDictionary = this._initCorrectionDictionary();
    
    // 形態素解析（ブラウザ依存）
    this.morphAnalyzer = null;
    this._initMorphAnalyzer();
    
    // 状態
    this.isListening = false;
    this.audioChunks = [];
    this.mediaRecorder = null;
    this.recordingStartTime = null;
    
    // 結果格納
    this.webSpeechResult = null;
    
    // デバッグモード
    this.debug = this.options.debug;
    
    this._log('幼稚園特化型ハイブリッド音声認識を初期化しました');
  }
  
  /**
   * デバッグログ
   */
  _log(...args) {
    if (this.debug) {
      console.log('[HybridVR]', ...args);
    }
  }
  
  /**
   * エラーログ
   */
  _error(...args) {
    console.error('[HybridVR]', ...args);
  }
  
  /**
   * Web Speech API の初期化
   * @returns {boolean} サポート状況
   */
  _initWebSpeech() {
    const SpeechRecognition = window.SpeechRecognition || 
                              window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      this._log('このブラウザはWeb Speech APIをサポートしていません');
      return false;
    }
    
    try {
      this.webSpeechRecognition = new SpeechRecognition();
      this.webSpeechRecognition.lang = this.options.language;
      // continuous = true に修正して長時間対応
      this.webSpeechRecognition.continuous = true;
      this.webSpeechRecognition.interimResults = true;
      
      return true;
    } catch (e) {
      this._error('Web Speech API初期化エラー:', e);
      return false;
    }
  }
  
  /**
   * 形態素解析機能の初期化
   */
  _initMorphAnalyzer() {
    // Tiny Segmenterを使用（軽量な日本語形態素解析）
    if (typeof TinySegmenter !== 'undefined') {
      this.morphAnalyzer = new TinySegmenter();
      this._log('形態素解析を初期化しました');
    } else {
      // 動的にTinySegmenterをロード
      this._loadScript('https://cdn.jsdelivr.net/npm/tiny-segmenter@0.2.0/tiny_segmenter.min.js')
        .then(() => {
          if (typeof TinySegmenter !== 'undefined') {
            this.morphAnalyzer = new TinySegmenter();
            this._log('形態素解析を初期化しました');
          }
        })
        .catch(err => {
          this._log('形態素解析のロードに失敗しました:', err);
        });
    }
  }
  
  /**
   * スクリプトを動的にロード
   */
  _loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  
  /**
   * 修正辞書の初期化
   */
  _initCorrectionDictionary() {
    return {
      // 「ホザナ」の誤認識パターン（優先順位高）
      'ホサナ': 'ホザナ',
      'ほざな': 'ホザナ',
      'ほさな': 'ホザナ',
      'ほうさな': 'ホザナ',
      '保座菜': 'ホザナ',
      '保佐名': 'ホザナ',
      '宝座名': 'ホザナ',
      '穂佐奈': 'ホザナ',
      '穂沢名': 'ホザナ',
      '帆座名': 'ホザナ',
      '歩座奈': 'ホザナ',
      '歩佐名': 'ホザナ',
      '保沢名': 'ホザナ',
      'ほざなし': 'ホザナ',
      
      // 入園関連の誤認識修正
      '元祥': '願書',
      'げんしょう': '願書',
      '玄証': '願書',
      '願状': '願書',
      '源証': '願書',
      '現象': '願書',
      '願正': '願書',
      
      // 園/円の修正
      // 注: 実際の適用は_correctText内で文脈に基づき行う
      '縁': '園',
      '宴': '園',
      '演': '園',
      '延': '園',
      '炎': '園',
      
      // 「幼稚園」の誤認識修正
      '用紙園': '幼稚園',
      '用地園': '幼稚園',
      '洋紙園': '幼稚園',
      '要旨園': '幼稚園',
      '幼児園': '幼稚園',
      '容姿園': '幼稚園',
      '幼時代': '幼稚園',
      
      // 幼稚園特有の用語
      '預かり保育': '預かり保育',
      '課外教室': '課外教室',
      '給食': '給食',
      '制服': '制服',
      '満3歳児': '満3歳児',
      '年少': '年少',
      '年中': '年中',
      '年長': '年長',
      '通園バス': '通園バス',
      '入園': '入園',
      '保育料': '保育料',
      '説明会': '説明会',
      '願書配布': '願書配布',
      '願書受付': '願書受付',
      '募集要項': '募集要項',
      
      // よくある誤認識の修正
      'おしえて': '教えて',
      'おねがいします': 'お願いします',
      'わかりません': '分かりません',
      'おしえてください': '教えてください',
      'ありがとう': 'ありがとう',
      'すみません': 'すみません',
      'わかった': '分かった',
      'つかえない': '使えない',
      'つかえます': '使えます'
    };
  }
  
  /**
   * サポートされているMIMEタイプを取得
   * @returns {string} サポートされているMIMEタイプ
   */
  _getSupportedMimeType() {
    const types = [
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/wav'
    ];
    
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        this._log(`サポートされているMIMEタイプ: ${type}`);
        return type;
      }
    }
    
    this._log('標準MIMEタイプをサポートしていません、デフォルトを使用します');
    return '';  // デフォルトを使用
  }
  
  /**
   * 音声認識の開始
   * @param {Function} onInterimResult 中間結果のコールバック
   * @param {Function} onFinalResult 最終結果のコールバック
   * @param {Function} onError エラー時のコールバック
   */
  async startListening(onInterimResult, onFinalResult, onError) {
    if (this.isListening) return;
    
    this.isListening = true;
    this.audioChunks = [];
    this.webSpeechResult = null;
    this.recordingStartTime = Date.now();
    
    try {
      // マイク入力の取得
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        .catch(err => {
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            throw new Error('マイクの使用許可が得られませんでした');
          } else {
            throw err;
          }
        });
      
      // Web Speech API のセットアップ
      if (this.webSpeechSupported && this.webSpeechRecognition) {
        // 中間結果ハンドラ
        this.webSpeechRecognition.onresult = (event) => {
          // 複数の結果を正しく処理
          let finalTranscript = '';
          let interimTranscript = '';
          
          // 全ての結果をループ処理
          for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0].transcript;
            
            if (result.isFinal) {
              finalTranscript += transcript;
            } else {
              interimTranscript += transcript;
            }
          }
          
          // 中間結果がある場合は修正して通知
          if (interimTranscript && onInterimResult) {
            const correctedInterim = this._correctText(interimTranscript);
            onInterimResult(correctedInterim);
          }
          
          // 最終結果がある場合は処理
          if (finalTranscript) {
            // 最終結果にも幼稚園特化の修正を適用
            const correctedFinal = this._correctText(finalTranscript);
            
            // Web Speech API の結果を保存
            this.webSpeechResult = {
              text: correctedFinal,
              original: finalTranscript,
              confidence: this._calculateConfidence(finalTranscript, correctedFinal),
              engine: 'web-speech',
              timestamp: Date.now()
            };
            
            // Whisper の結果を待たずにまず Web Speech の結果を通知
            if (onFinalResult && correctedFinal) {
              onFinalResult(this.webSpeechResult);
            }
          }
        };
        
        // エラーハンドラ
        this.webSpeechRecognition.onerror = (event) => {
          this._error('Web Speech APIエラー:', event.error);
          // エラーを通知するが認識を停止しない（Whisperバックアップへ）
          if (onError) {
            onError({ 
              error: event.error, 
              engine: 'web-speech'
            });
          }
        };
        
        // 認識終了時のハンドラ
        this.webSpeechRecognition.onend = () => {
          this._log('Web Speech API認識終了');
          
          // 認識中なら再開（継続的な認識のため）
          if (this.isListening) {
            try {
              this.webSpeechRecognition.start();
              this._log('Web Speech API再開');
            } catch (e) {
              this._error('Web Speech API再開エラー:', e);
            }
          }
        };
        
        // Web Speech API開始
        try {
          this.webSpeechRecognition.start();
        } catch (e) {
          this._error('Web Speech API開始エラー:', e);
          this.webSpeechSupported = false;
        }
      }
      
      // サポートされているMIMEタイプを取得
      const mimeType = this._getSupportedMimeType();
      
      // MediaRecorderの設定（Whisper用の音声録音）
      const recorderOptions = mimeType ? { mimeType } : undefined;
      
      try {
        this.mediaRecorder = new MediaRecorder(this.stream, recorderOptions);
      } catch (e) {
        this._error('MediaRecorder初期化エラー、デフォルト設定を使用します:', e);
        this.mediaRecorder = new MediaRecorder(this.stream);
      }
      
      // データ取得
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      
      // 録音終了時の処理
      this.mediaRecorder.onstop = async () => {
        try {
          // 音声データがある場合は処理
          if (this.audioChunks.length > 0) {
            // Blobの作成
            const audioBlob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
            
            // 音声の長さを推定
            const audioDuration = await this._estimateAudioDuration(audioBlob);
            this._log(`推定音声長: ${audioDuration}ms`);
            
            // 音声の長さに応じて処理を分岐
            if (audioDuration < this.options.shortUtteranceThreshold) {
              this._log('短い発話なので Web Speech API の結果を優先');
              
              // すでにWeb Speech APIの結果があれば十分
              if (this.webSpeechResult && this.webSpeechResult.text) {
                this._log('Web Speech APIの結果を使用');
              } else {
                // Web Speech APIの結果がない場合はWhisperを使用
                this._log('Web Speech APIの結果がないため、Whisperを使用');
                await this._processWithWhisper(audioBlob, onFinalResult, onError);
              }
            } else {
              // 長い発話はWhisperも使用して比較
              this._log('長い発話なのでWhisperも使用して最適な結果を選択');
              await this._processWithWhisper(audioBlob, onFinalResult, onError);
            }
          }
        } catch (error) {
          this._error('録音終了処理エラー:', error);
          if (onError) {
            onError({
              error: error.message,
              engine: 'recorder'
            });
          }
        } finally {
          this.isListening = false;
        }
      };
      
      // 録音開始（エラーハンドリングを追加）
      try {
        this.mediaRecorder.start(1000); // 1秒ごとにデータを取得
        this._log('MediaRecorder開始');
      } catch (e) {
        this._error('MediaRecorder開始エラー:', e);
        throw e;
      }
      
      return true;
    } catch (error) {
      this._error('音声認識開始エラー:', error);
      this.isListening = false;
      
      // リソースのクリーンアップ
      this._cleanupResources();
      
      if (onError) {
        // 特定のエラーを識別
        if (error.message.includes('許可')) {
          onError({ 
            error: 'mic-permission',
            message: 'マイクの使用許可が必要です',
            engine: 'system'
          });
        } else {
          onError({ 
            error: error.message, 
            engine: 'hybrid'
          });
        }
      }
      
      return false;
    }
  }
  
  /**
   * 音声認識の停止
   */
  stopListening() {
    if (!this.isListening) return;
    
    this._log('音声認識を停止します');
    
    // Web Speech API停止
    if (this.webSpeechSupported && this.webSpeechRecognition) {
      try {
        this.webSpeechRecognition.stop();
        this._log('Web Speech API停止');
      } catch (e) {
        this._error('Web Speech API停止エラー:', e);
      }
    }
    
    // MediaRecorder停止（状態チェック追加）
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try {
        this.mediaRecorder.stop();
        this._log('MediaRecorder停止');
      } catch (e) {
        this._error('MediaRecorder停止エラー:', e);
      }
    }
    
    // リソースのクリーンアップ
    this._cleanupResources();
    
    this.isListening = false;
  }
  
  /**
   * リソースのクリーンアップ
   */
  _cleanupResources() {
    // MediaStreamの停止
    if (this.stream) {
      try {
        this.stream.getTracks().forEach(track => track.stop());
        this._log('MediaStream停止');
      } catch (e) {
        this._error('MediaStream停止エラー:', e);
      }
      this.stream = null;
    }
  }
  
  /**
   * 信頼度の計算（より正確な方法）
   */
  _calculateConfidence(original, corrected) {
    // ブラウザ間の差異を考慮した独自の信頼度計算
    
    // 1. 文字列の類似度を計算（レーベンシュタイン距離を使用）
    const similarity = 1 - (this._levenshteinDistance(original, corrected) / 
                          Math.max(original.length, corrected.length));
    
    // 2. 重要キーワードの出現を評価
    const keyTerms = ['ホザナ', '幼稚園', '入園', '願書', '説明会', '募集'];
    const keyTermsCount = keyTerms.filter(term => corrected.includes(term)).length;
    const keyTermsBonus = keyTermsCount * 0.05; // 1キーワードあたり5%ボーナス
    
    // 3. 最終的な信頼度スコア（最大1.0）
    return Math.min(1.0, similarity * 0.7 + keyTermsBonus);
  }
  
  /**
   * レーベンシュタイン距離の計算
   */
  _levenshteinDistance(a, b) {
    const matrix = [];
    
    // 行列の初期化
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    
    // 行列の埋め込み
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i-1) === a.charAt(j-1)) {
          matrix[i][j] = matrix[i-1][j-1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i-1][j-1] + 1, // 置換
            matrix[i][j-1] + 1,   // 挿入
            matrix[i-1][j] + 1    // 削除
          );
        }
      }
    }
    
    return matrix[b.length][a.length];
  }
  
  /**
   * WhisperAPIでの処理
   */
  async _processWithWhisper(audioBlob, onFinalResult, onError) {
    try {
      this._log('Whisper APIで処理開始');
      
      // 音声データのサイズチェック
      if (audioBlob.size > this.options.maxAudioSize) {
        this._log(`音声データが大きすぎます (${(audioBlob.size / 1024 / 1024).toFixed(2)}MB)`);
        // 大きすぎる場合は圧縮・リサンプリングが必要だが、ここでは簡易的にエラー処理
        throw new Error('音声データが大きすぎます (8MB制限)');
      }
      
      // Blobをbase64に変換
      const base64Audio = await this._blobToBase64(audioBlob);
      
      // APIエンドポイントのURL構築（相対パスから絶対パスへ）
      const apiUrl = new URL(
        this.options.whisperApiEndpoint,
        window.location.origin
      ).toString();
      
      // APIリクエスト
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          audio: base64Audio,
          format: audioBlob.type || 'audio/webm'
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`API error: ${response.status} - ${errorData.error || 'Unknown error'}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.text) {
        // 幼稚園特化の修正を適用
        const correctedText = this._correctText(data.text);
        
        // 信頼度を計算（固定値ではなく）
        const confidence = this._calculateConfidence(data.text, correctedText);
        
        const whisperResult = {
          text: correctedText,
          original: data.text,
          confidence: confidence,
          engine: 'whisper',
          timestamp: Date.now()
        };
        
        // Web Speech API と Whisper の結果を比較
        const bestResult = await this._compareAndSelectBestResult(
          this.webSpeechResult,
          whisperResult
        );
        
        // 最適な結果を通知
        if (onFinalResult && bestResult.text) {
          // Web Speechと同じ結果を返さないようにする
          if (!this.webSpeechResult || 
              (this.webSpeechResult.text !== bestResult.text &&
               bestResult.timestamp !== this.webSpeechResult.timestamp)) {
            onFinalResult(bestResult);
          }
        }
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (error) {
      this._error('Whisper処理エラー:', error);
      
      if (onError) {
        onError({ 
          error: error.message, 
          engine: 'whisper'
        });
      }
    }
  }
  
  /**
   * 両方のエンジン結果を比較して最適なものを選択
   */
  async _compareAndSelectBestResult(webSpeechResult, whisperResult) {
    // どちらかが null の場合は他方を返す
    if (!webSpeechResult) return whisperResult;
    if (!whisperResult) return webSpeechResult;
    
    // 「ホザナ」を含むかどうかチェック
    const webSpeechHasHosana = /ホザナ|ほざな|ほさな|ホサナ/i.test(webSpeechResult.text);
    const whisperHasHosana = /ホザナ|ほざな|ほさな|ホサナ/i.test(whisperResult.text);
    
    // 「ホザナ」を含む方を優先
    if (webSpeechHasHosana && !whisperHasHosana) {
      return webSpeechResult;
    } else if (!webSpeechHasHosana && whisperHasHosana) {
      return whisperResult;
    }
    
    // 「幼稚園」を含むかどうかチェック
    const webSpeechHasKindergarten = /幼稚園/i.test(webSpeechResult.text);
    const whisperHasKindergarten = /幼稚園/i.test(whisperResult.text);
    
    // 「幼稚園」を含む方を優先
    if (webSpeechHasKindergarten && !whisperHasKindergarten) {
      return webSpeechResult;
    } else if (!webSpeechHasKindergarten && whisperHasKindergarten) {
      return whisperResult;
    }
    
    // 入園関連の重要単語をチェック
    const keyTerms = ['入園', '願書', '申し込み', '募集', '見学', '説明会'];
    const webSpeechTermCount = keyTerms.filter(term => webSpeechResult.text.includes(term)).length;
    const whisperTermCount = keyTerms.filter(term => whisperResult.text.includes(term)).length;
    
    if (webSpeechTermCount > whisperTermCount) {
      return webSpeechResult;
    } else if (whisperTermCount > webSpeechTermCount) {
      return whisperResult;
    }
    
    // その他の場合は信頼度で判断
    return (webSpeechResult.confidence >= whisperResult.confidence) ? 
           webSpeechResult : whisperResult;
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
   * 幼稚園特化のテキスト修正
   */
  _correctText(text) {
    if (!text) return '';
    
    let corrected = text;
    
    // 「ホザナ」の特別処理（最優先）
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