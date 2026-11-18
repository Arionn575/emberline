// Sound, synthesized with WebAudio: no audio files, no network. Everything
// is guarded so a browser without audio (or a headless test) never throws.
// The context is only created after a user gesture (unlock), so the game
// never trips the browser's autoplay warning on load or in a screenshot.
export function makeSound() {
  let ctx = null;
  let unlocked = false;

  function audio() {
    if (!unlocked || ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = AC ? new AC() : null;
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function tone(freq, dur, gain = 0.12, type = 'sine', when = 0) {
    const c = audio();
    if (!c) return;
    try {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const start = c.currentTime + when;
      g.gain.setValueAtTime(gain, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(g).connect(c.destination);
      osc.start(start);
      osc.stop(start + dur);
    } catch {
      // Audio is decoration; a failure never stops the game.
    }
  }

  function burst(dur, gain = 0.2, cutoff = 1200) {
    const c = audio();
    if (!c) return;
    try {
      const length = Math.max(1, Math.floor(c.sampleRate * dur));
      const buffer = c.createBuffer(1, length, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
      const src = c.createBufferSource();
      src.buffer = buffer;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(filter).connect(g).connect(c.destination);
      src.start();
    } catch {
      // Audio is decoration; a failure never stops the game.
    }
  }

  return {
    unlock() {
      unlocked = true;
      const c = audio();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
    },
    shot() { burst(0.09, 0.22, 1600); },
    enemyShot() { burst(0.07, 0.08, 900); },
    hit() { tone(1400, 0.05, 0.1, 'square'); },
    kill() { tone(880, 0.08, 0.12, 'square'); tone(1320, 0.1, 0.12, 'square', 0.08); },
    reload() { tone(520, 0.06, 0.08); },
    plant() { tone(660, 0.1, 0.12); tone(990, 0.14, 0.12, 'sine', 0.1); },
    bombBeep() { tone(1100, 0.07, 0.1, 'square'); },
    explosion() { burst(0.6, 0.5, 320); tone(70, 0.5, 0.3); },
    roundWin() { tone(523, 0.12, 0.12); tone(659, 0.12, 0.12, 'sine', 0.12); tone(784, 0.2, 0.12, 'sine', 0.24); },
    roundLose() { tone(392, 0.15, 0.12); tone(311, 0.25, 0.12, 'sine', 0.15); },
  };
}
