import { unlock } from '/fusionCore/polyfills/audio-context-resume.js';

function isiOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// FusionVoiceAdapter がロードされた後に実行されることを想定
window.addEventListener('DOMContentLoaded', () => {
  if (!isiOS()) return; // PC / Android は何もしない

  const base = '/fusionCore/';
  const wPath = `${base}worklets/`;
  const spPath = `${base}worklets/vad-processor-sp.js`;

  // ① AudioContext 自動再生制限を解除
  const AC = window.AudioContext || window.webkitAudioContext;
  const orig = AC.prototype.resume;
  AC.prototype.resume = async function () {
    await unlock(this); // ユーザージェスチャ待ち
    return orig.apply(this, arguments);
  };

  // ② FusionVoiceAdapter.prototype.initializeFusionCore を monkey-patch
  const fva = window.FusionVoiceAdapter?.prototype;
  if (!fva) return;

  const originalInit = fva.initializeFusionCore;
  fva.initializeFusionCore = async function (...args) {
    this.workletPath = wPath; // iOS は固定パスを注入
    // AudioWorklet が無い場合は ScriptProcessor 版に切替
    if (!('audioWorklet' in AC.prototype)) {
      this.useScriptProcessor = true;
      // FusionCore 側で import できるようにグローバル参照を用意
      window.vadProcessorFallbackURL = spPath;
    }
    return originalInit.apply(this, args);
  };
});
