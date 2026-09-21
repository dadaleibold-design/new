/* ============================================================
 * js/ringtone.js
 * نغمات رنين تفاعلية مولَّدة عبر Web Audio API (بدون ملفات صوتية):
 *   - outgoing : نغمة "الانتظار" أثناء رنين الطرف الآخر (Ringback tone)
 *   - incoming : لحن رنين للمكالمة الواردة + اهتزاز على الجوال
 *   - connected: نغمة قصيرة عند قبول المكالمة
 *   - ended    : نغمة قصيرة عند الإنهاء
 *   - busy     : نغمة مشغول عند الرفض
 * كل شيء مغلّف بـ try/catch — أي بيئة بلا AudioContext تتجاهل بصمت.
 * ============================================================ */

let audioCtx = null;
let masterGain = null;
let loopTimer = null;
let currentKind = null;
let activeNodes = new Set();
let vibrateTimer = null;

function getContext() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(audioCtx.destination);
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

/** يجب استدعاؤها من حدث نقر ليسمح المتصفح بتشغيل الصوت لاحقاً */
export function unlockAudio() {
  try {
    const ctx = getContext();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  } catch {
    /* تجاهل */
  }
}

function tone({ freq, start, duration, type = "sine", volume = 1, attack = 0.01, release = 0.05 }) {
  const ctx = getContext();
  if (!ctx || !masterGain) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + start;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + attack);
  gain.gain.setValueAtTime(volume, t0 + Math.max(attack, duration - release));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
  activeNodes.add(osc);
  osc.onended = () => {
    activeNodes.delete(osc);
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      /* تجاهل */
    }
  };
}

/* أنماط النغمات — تُرجع طول الدورة بالثواني */
const PATTERNS = {
  // نغمة انتظار دولية: 425Hz لمدة ثانية، صمت 4 ثوانٍ
  outgoing() {
    tone({ freq: 425, start: 0, duration: 1.0, volume: 0.6 });
    tone({ freq: 450, start: 0, duration: 1.0, volume: 0.25 });
    return 4.0;
  },
  // لحن رنين قصير (مستوحى من نغمات تطبيقات المراسلة)
  incoming() {
    const notes = [
      [784, 0.0, 0.16],
      [988, 0.18, 0.16],
      [1175, 0.36, 0.2],
      [988, 0.6, 0.16],
      [784, 0.78, 0.16],
      [1175, 0.96, 0.32],
      [784, 1.5, 0.16],
      [988, 1.68, 0.16],
      [1175, 1.86, 0.2],
      [1319, 2.1, 0.36],
    ];
    notes.forEach(([f, s, d]) => {
      tone({ freq: f, start: s, duration: d, type: "triangle", volume: 0.9 });
      tone({ freq: f / 2, start: s, duration: d, type: "sine", volume: 0.25 });
    });
    return 3.4;
  },
  busy() {
    tone({ freq: 425, start: 0, duration: 0.5, volume: 0.5, type: "square" });
    return 1.0;
  },
};

function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* تجاهل */
  }
}

/**
 * يبدأ نغمة متكررة.
 * @param {"outgoing"|"incoming"|"busy"} kind
 */
export function startRingtone(kind = "outgoing") {
  stopRingtone();
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const pattern = PATTERNS[kind] || PATTERNS.outgoing;
  currentKind = kind;

  const cycle = () => {
    if (currentKind !== kind) return;
    let period = 1;
    try {
      period = pattern();
    } catch {
      /* تجاهل */
    }
    loopTimer = setTimeout(cycle, period * 1000);
  };
  cycle();

  if (kind === "incoming") {
    const vib = () => {
      if (currentKind !== "incoming") return;
      vibrate([400, 200, 400, 1400]);
      vibrateTimer = setTimeout(vib, 2400);
    };
    vib();
  }
}

export function stopRingtone() {
  currentKind = null;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  if (vibrateTimer) {
    clearTimeout(vibrateTimer);
    vibrateTimer = null;
  }
  vibrate(0);
  activeNodes.forEach((node) => {
    try {
      node.stop();
    } catch {
      /* تجاهل */
    }
  });
  activeNodes.clear();
}

export function isRinging() {
  return currentKind !== null;
}

/** نغمة قصيرة عند اتصال المكالمة */
export function playConnectedTone() {
  stopRingtone();
  try {
    tone({ freq: 880, start: 0, duration: 0.09, volume: 0.5 });
    tone({ freq: 1175, start: 0.1, duration: 0.14, volume: 0.5 });
    vibrate(60);
  } catch {
    /* تجاهل */
  }
}

/** نغمة قصيرة عند انتهاء المكالمة */
export function playEndedTone() {
  stopRingtone();
  try {
    tone({ freq: 660, start: 0, duration: 0.12, volume: 0.45 });
    tone({ freq: 440, start: 0.14, duration: 0.2, volume: 0.45 });
    vibrate([40, 40, 40]);
  } catch {
    /* تجاهل */
  }
}

/** نغمة مشغول مؤقتة (3 دورات) عند رفض المكالمة */
export function playBusyTone() {
  startRingtone("busy");
  setTimeout(() => {
    if (currentKind === "busy") stopRingtone();
  }, 3000);
}
