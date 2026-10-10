/**
 * Audio Processor for Morning Brief Voice Cloning.
 * Converts any user audio (WAV, MP3, M4A, AAC, OGG) directly in the browser
 * into the exact format required by the Chatterbox-Turbo engine:
 *   - 24,000 Hz (24 kHz) sample rate
 *   - 1 Channel (Mono)
 *   - 16-bit Linear PCM WAV
 *   - Leading and trailing silence trimmed (< -45 dB)
 *   - Duration validation (Chatterbox requires >= 5.0s, optimal 8.0s - 30.0s)
 */

export async function processReferenceAudio(file) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error('Web Audio API is not supported in this browser.');
  }
  const audioContext = new AudioContextClass();
  const arrayBuffer = await file.arrayBuffer();

  let audioBuffer;
  try {
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  } catch (err) {
    throw new Error('Could not decode audio. Please ensure the file is a valid audio clip.');
  }

  const origSampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  // 1. Downmix all channels to a single mono Float32 array
  const mono = new Float32Array(length);
  for (let c = 0; c < numChannels; c++) {
    const chData = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      mono[i] += chData[i] / numChannels;
    }
  }

  // 2. Trim silence (threshold -45 dB ≈ 0.0056 peak amplitude)
  const silenceThreshold = 0.0056;
  let startIdx = 0;
  while (startIdx < length && Math.abs(mono[startIdx]) < silenceThreshold) {
    startIdx++;
  }
  let endIdx = length - 1;
  while (endIdx > startIdx && Math.abs(mono[endIdx]) < silenceThreshold) {
    endIdx--;
  }

  // Preserve 0.05s of ambient headroom
  const pad = Math.floor(origSampleRate * 0.05);
  startIdx = Math.max(0, startIdx - pad);
  endIdx = Math.min(length - 1, endIdx + pad);
  const trimmedLength = Math.max(1, endIdx - startIdx + 1);

  // 3. Resample to exactly 24,000 Hz using OfflineAudioContext
  const targetSampleRate = 24000;
  const targetLength = Math.round(trimmedLength * (targetSampleRate / origSampleRate));
  const offlineCtx = new OfflineAudioContext(1, targetLength, targetSampleRate);

  const trimmedBuf = offlineCtx.createBuffer(1, trimmedLength, origSampleRate);
  trimmedBuf.getChannelData(0).set(mono.subarray(startIdx, endIdx + 1));

  const source = offlineCtx.createBufferSource();
  source.buffer = trimmedBuf;
  source.connect(offlineCtx.destination);
  source.start(0);

  const resampled = await offlineCtx.startRendering();
  const samples = resampled.getChannelData(0);
  const duration = resampled.duration;

  // 4. Encode to 16-bit PCM WAV Blob
  const wavBlob = encodeWav16(samples, targetSampleRate);

  return {
    blob: wavBlob,
    duration,
    sampleRate: targetSampleRate,
    channels: 1,
    sizeBytes: wavBlob.size,
    isUsable: duration >= 5.0,
    isOptimal: duration >= 8.0 && duration <= 30.0,
    origDuration: audioBuffer.duration,
    origSampleRate,
  };
}

function encodeWav16(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);             // subchunk1size (16 for PCM)
  view.setUint16(20, 1, true);              // format (1 = PCM)
  view.setUint16(22, 1, true);              // channels (1 = Mono)
  view.setUint32(24, sampleRate, true);     // sample rate (24000)
  view.setUint32(28, sampleRate * 2, true); // byte rate (24000 * 1 * 2)
  view.setUint16(32, 2, true);              // block align (1 * 2)
  view.setUint16(34, 16, true);             // bits per sample (16)
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  // PCM 16-bit samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
