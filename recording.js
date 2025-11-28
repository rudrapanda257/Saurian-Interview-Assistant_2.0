// /mnt/data/recording.js
// Robust RecordingService for Electron renderer
// Works with either:
//  - nodeIntegration: true (renderer can require('electron'))
//  - contextIsolation: true + preload exposing electronAPI.getDesktopSources
//
// Exports RecordingService class with methods: startSystem(), startMic(), stop()
// startSystem() captures system/speaker audio (desktop capture).
// startMic() captures microphone audio.

class RecordingService {
  constructor() {
    this.mediaRecorder = null;
    this.chunks = [];
    this.isRecording = false;
    this._stream = null;
  }

  // internal helper: create MediaRecorder safely and attach handlers
  _createMediaRecorder(stream) {
    if (!stream) throw new Error('_createMediaRecorder: stream is null');

    // Clean up any previous recorder
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch (e) { console.warn(e); }
      this.mediaRecorder = null;
      this.chunks = [];
    }

    let mimeType = 'audio/webm';
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
      }
    } catch (e) {
      // ignore
    }

    let mr;
    try {
      mr = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      console.error('_createMediaRecorder: MediaRecorder constructor failed:', err);
      throw err;
    }

    this.chunks = [];
    mr.ondataavailable = (event) => {
      if (event && event.data && event.data.size > 0) {
        this.chunks.push(event.data);
        console.log('ondataavailable chunk size:', event.data.size);
      }
    };

    mr.onerror = (ev) => {
      console.error('mediaRecorder error:', ev);
    };

    mr.onstop = async () => {
      try {
        const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();

        // Try Node Buffer first (Electron renderer with nodeIntegration)
        let base64;
        if (typeof Buffer !== 'undefined') {
          try {
            base64 = Buffer.from(arrayBuffer).toString('base64');
          } catch (e) {
            base64 = null;
          }
        }
        if (!base64) {
          // Fallback for strict browser environment
          const u8 = new Uint8Array(arrayBuffer);
          let binary = '';
          for (let i = 0; i < u8.byteLength; i++) binary += String.fromCharCode(u8[i]);
          base64 = typeof btoa !== 'undefined' ? btoa(binary) : null;
        }

        // Cleanup tracks
        try {
          if (this._stream) {
            this._stream.getTracks().forEach(t => t.stop());
          }
        } catch (e) { /* ignore */ }

        // Reset state
        this._stream = null;
        this.chunks = [];
        this.isRecording = false;
        this.mediaRecorder = null;

        // Emit via a DOM event so UI can listen (or you can replace with ipcRenderer)
        const ev = new CustomEvent('recording-finished', { detail: { base64 } });
        window.dispatchEvent(ev);
      } catch (e) {
        console.error('onstop handler error:', e);
        const ev = new CustomEvent('recording-error', { detail: { error: e }});
        window.dispatchEvent(ev);
      }
    };

    return mr;
  }

  // start recording a microphone stream (prompts for mic)
  async startMic() {
    if (this.isRecording) return true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia not supported');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._stream = stream;
      this.mediaRecorder = this._createMediaRecorder(stream);
      this.mediaRecorder.start(100); // collect 100ms chunks
      this.isRecording = true;
      console.log('startMic: recording started');
      return true;
    } catch (err) {
      console.error('startMic failed:', err);
      // cleanup if partially created
      try { if (this._stream) this._stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      this._stream = null;
      this.isRecording = false;
      this.mediaRecorder = null;
      this.chunks = [];
      throw err;
    }
  }

  // start recording system (speaker) audio.
  // This supports:
  //  - renderer with access to electron.desktopCapturer (require('electron').desktopCapturer)
  //  - or preload exposing window.electronAPI.getDesktopSources(opts) -> array
  async startSystem() {
  if (this.isRecording) return true;

  try {
    let sourceId = null;
    
    // Path A: Try direct require (nodeIntegration true)
    try {
      const { desktopCapturer } = require('electron');
      if (desktopCapturer) {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources && sources.length > 0) {
          sourceId = sources[0].id;
          console.log('startSystem: got source via require:', sources[0].name);
        }
      }
    } catch (e) {
      console.log('Direct require failed, trying window.electronAPI');
    }

    // Path B: Try preload API
    if (!sourceId && window.electronAPI && window.electronAPI.getDesktopSources) {
      try {
        const sources = await window.electronAPI.getDesktopSources({ types: ['screen'] });
        if (sources && sources.length > 0) {
          sourceId = sources[0].id;
          console.log('startSystem: got source via preload:', sources[0].name);
        }
      } catch (e) {
        console.log('Preload API failed:', e);
      }
    }

    // Path C: Try @electron/remote
    if (!sourceId) {
      try {
        const remote = require('@electron/remote');
        const { desktopCapturer } = remote;
        if (desktopCapturer) {
          const sources = await desktopCapturer.getSources({ types: ['screen'] });
          if (sources && sources.length > 0) {
            sourceId = sources[0].id;
            console.log('startSystem: got source via remote:', sources[0].name);
          }
        }
      } catch (e) {
        console.log('Remote failed:', e);
      }
    }

    if (!sourceId) {
      throw new Error('Could not get desktop source. Check screen recording permissions in System Settings.');
    }

    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getVideoTracks().forEach(track => track.stop());
    const audioStream = new MediaStream(stream.getAudioTracks());
    this._stream = audioStream;
    this.mediaRecorder = this._createMediaRecorder(audioStream);
    this.mediaRecorder.start(100);
    this.isRecording = true;
    console.log('startSystem: recording started');
    return true;
  } catch (err) {
    console.error('startSystem failed:', err);
    try { if (this._stream) this._stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    this._stream = null;
    this.mediaRecorder = null;
    this.isRecording = false;
    this.chunks = [];
    throw err;
  }
}

  // stop recording; resolves to base64 audio string or null
  async stop() {
    if (!this.isRecording) return null;
    return new Promise((resolve, reject) => {
      try {
        // Hook once for onstop result: use event listener to receive the CustomEvent
        function onFinished(e) {
          window.removeEventListener('recording-finished', onFinished);
          window.removeEventListener('recording-error', onError);
          resolve(e.detail.base64);
        }
        function onError(e) {
          window.removeEventListener('recording-finished', onFinished);
          window.removeEventListener('recording-error', onError);
          reject(e.detail?.error || new Error('recording error'));
        }

        window.addEventListener('recording-finished', onFinished);
        window.addEventListener('recording-error', onError);

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
          try {
            this.mediaRecorder.stop();
          } catch (e) {
            console.warn('mediaRecorder.stop() threw:', e);
            // cleanup and resolve null
            try { if (this._stream) this._stream.getTracks().forEach(t => t.stop()); } catch (z) {}
            this.isRecording = false;
            resolve(null);
          }
        } else {
          // Nothing to stop, cleanup
          try { if (this._stream) this._stream.getTracks().forEach(t => t.stop()); } catch (z) {}
          this.isRecording = false;
          resolve(null);
        }
      } catch (err) {
        this.isRecording = false;
        console.error('stop() error:', err);
        reject(err);
      }
    });
  }

  isActive() {
    return !!this.isRecording;
  }
}

module.exports = RecordingService;
