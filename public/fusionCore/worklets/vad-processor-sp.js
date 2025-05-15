// fallback for Safari < 14.5  (AudioWorklet not available)
export function createScriptProcessor(ctx, onSpeech) {
  const bufferSize = 2048;
  const sp = ctx.createScriptProcessor(bufferSize, 1, 1);
  let speaking = false;
  let silenceCnt = 0;
  const threshold = 0.5;

  sp.onaudioprocess = ({ inputBuffer }) => {
    const data = inputBuffer.getChannelData(0);
    const rms = Math.hypot(...data) / Math.sqrt(data.length);
    if (rms > threshold) {
      if (!speaking) {
        speaking = true;
        onSpeech('speechStart');
      }
      silenceCnt = 0;
    } else if (speaking && ++silenceCnt > 30) {
      speaking = false;
      onSpeech('speechEnd');
      silenceCnt = 0;
    }
  };
  return sp;
}
