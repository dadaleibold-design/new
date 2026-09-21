/* ============================================================
 * js/calls.js
 * مكالمات صوتية ومرئية عبر منصة Agora RTC.
 *
 * المعمارية:
 *   - الإشارات (Signaling): عبر Supabase Realtime Broadcast على قناة
 *     خاصة بكل مستخدم `calls:user:<uid>` + جدول `call_rooms` للحالة الدائمة.
 *   - الوسائط (Media): عبر Agora RTC Web SDK (يُحمَّل بشكل كسول Lazy
 *     عند أول مكالمة فقط، حتى لا يبطئ إقلاع التطبيق).
 *   - الأمان: كل شيء مغلّف بـ try/catch — أي فشل يُنهي المكالمة بلطف
 *     ولا يُسقط الواجهة.
 * ============================================================ */

import { AGORA, isAgoraConfigured, buildAgoraChannelName } from "./config.js";
import { safeAsync, safeQuery, safeDom, guard } from "./safety.js";

/* ------------------------------------------------------------
 * 1) تحميل Agora SDK بشكل كسول
 * ---------------------------------------------------------- */
let sdkPromise = null;

/**
 * يحمّل ملف SDK واحداً عبر وسم <script>.
 *
 * ⚠️ مهم: لا نضبط script.crossOrigin إطلاقاً. وسم <script> العادي يُحمَّل
 * عبر الأصول دون قيود، لكن ضبط crossOrigin يُفعّل فحص CORS فيرفض المتصفح
 * الملف ما لم يُرسل الخادم Access-Control-Allow-Origin — وهو ما لا يفعله
 * download.agora.io، فكان ذلك سبب خطأ "blocked by CORS policy".
 */
function loadSdkFrom(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;

    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      // أزل الوسم الفاشل حتى لا يتراكم في <head>
      try {
        script.remove();
      } catch {
        /* تجاهل */
      }
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`انتهت مهلة تحميل مكتبة Agora من ${url}`)),
      timeoutMs
    );

    script.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();

      if (window.AgoraRTC) {
        resolve(window.AgoraRTC);
      } else {
        reject(new Error("تم تحميل ملف Agora لكن الكائن AgoraRTC غير متاح."));
      }
    };

    script.onerror = () =>
      fail(new Error(`تعذّر تحميل مكتبة Agora RTC من ${url}`));

    document.head.appendChild(script);
  });
}

/**
 * يحمّل Agora SDK مع التنقّل بين عدة مصادر (CDN mirrors) بالتتابع،
 * فلا يُسقط مصدرٌ واحد معطّل (503) ميزة المكالمات بالكامل.
 */
function loadAgoraSdk() {
  if (window.AgoraRTC) return Promise.resolve(window.AgoraRTC);
  if (sdkPromise) return sdkPromise;

  const urls = AGORA.sdkUrls;

  sdkPromise = (async () => {
    const failures = [];

    for (const url of urls) {
      try {
        const sdk = await loadSdkFrom(url);

        try {
          sdk.setLogLevel?.(3); // أخطاء فقط
        } catch {
          /* تجاهل */
        }

        return sdk;
      } catch (err) {
        failures.push(`${url} → ${err.message}`);
        console.warn("[calls] فشل مصدر SDK، جارٍ تجربة التالي:", url, err.message);
      }
    }

    throw new Error(
      "تعذّر تحميل مكتبة Agora RTC من جميع المصادر. التفاصيل: " + failures.join(" | ")
    );
  })();

  // اسمح بإعادة المحاولة في المكالمة التالية بدل تخزين وعد مرفوض للأبد
  sdkPromise.catch(() => {
    sdkPromise = null;
  });

  return sdkPromise;
}

/* ------------------------------------------------------------
 * 2) حالة وحدة المكالمات
 * ---------------------------------------------------------- */
const callState = {
  ctx: null, // { supabase, getMe, getActiveConversation, notify, t }

  client: null,
  localAudioTrack: null,
  localVideoTrack: null,
  remoteUsers: new Map(),

  // المكالمة الجارية
  current: null, // { roomId, channel, callType, peer, direction, startedAt }
  incoming: null, // دعوة واردة قيد العرض

  signalChannel: null,
  ringTimer: null,
  durationTimer: null,
  ringtoneEl: null,

  micMuted: false,
  cameraOff: false,
  joining: false,
};

function t(key, fallback) {
  const dict = callState.ctx?.t?.();
  return (dict && dict[key]) || fallback;
}

function notify(message) {
  try {
    callState.ctx?.notify?.(message);
  } catch {
    console.warn("[calls]", message);
  }
}

function uuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Agora UID رقمي مشتق بثبات من UUID المستخدم (يبقى ثابتاً لكل مستخدم) */
function uidFromUserId(userId) {
  const str = String(userId || "");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 1000000000 || 1;
}

/* ------------------------------------------------------------
 * 3) واجهة المكالمة (Overlay) — تُبنى مرة واحدة عند الحاجة
 * ---------------------------------------------------------- */
function ensureCallOverlay() {
  let overlay = document.getElementById("call-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "call-overlay";
  overlay.className = "call-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="call-stage">
      <div id="call-remote-video" class="call-video call-video-remote"></div>
      <div id="call-local-video" class="call-video call-video-local"></div>

      <div class="call-peer-card" id="call-peer-card">
        <div class="call-avatar"><img id="call-peer-avatar" src="" alt="" /></div>
        <div class="call-peer-name" id="call-peer-name"></div>
        <div class="call-status-text" id="call-status-text"></div>
        <div class="call-timer" id="call-timer"></div>
      </div>

      <div class="call-controls" id="call-controls">
        <button type="button" id="call-btn-mic" class="call-ctrl" title="كتم الصوت">🎙️</button>
        <button type="button" id="call-btn-cam" class="call-ctrl" title="إيقاف الكاميرا">🎥</button>
        <button type="button" id="call-btn-switch" class="call-ctrl" title="تبديل الكاميرا">🔄</button>
        <button type="button" id="call-btn-end" class="call-ctrl call-ctrl-end" title="إنهاء">📵</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay
    .querySelector("#call-btn-mic")
    ?.addEventListener("click", guard("call:mic", toggleMicrophone));
  overlay
    .querySelector("#call-btn-cam")
    ?.addEventListener("click", guard("call:cam", toggleCamera));
  overlay
    .querySelector("#call-btn-switch")
    ?.addEventListener("click", guard("call:switch", switchCamera));
  overlay
    .querySelector("#call-btn-end")
    ?.addEventListener("click", guard("call:end", () => endCall("ended")));

  return overlay;
}

function ensureIncomingDialog() {
  let box = document.getElementById("incoming-call");
  if (box) return box;

  box = document.createElement("div");
  box.id = "incoming-call";
  box.className = "incoming-call hidden";
  box.innerHTML = `
    <div class="incoming-card">
      <div class="call-avatar"><img id="incoming-avatar" src="" alt="" /></div>
      <div class="incoming-name" id="incoming-name"></div>
      <div class="incoming-sub" id="incoming-sub"></div>
      <div class="incoming-actions">
        <button type="button" id="incoming-decline" class="call-ctrl call-ctrl-end">📵</button>
        <button type="button" id="incoming-accept" class="call-ctrl call-ctrl-accept">📞</button>
      </div>
    </div>
  `;
  document.body.appendChild(box);

  box
    .querySelector("#incoming-accept")
    ?.addEventListener("click", guard("call:accept", acceptIncomingCall));
  box
    .querySelector("#incoming-decline")
    ?.addEventListener("click", guard("call:decline", declineIncomingCall));

  return box;
}

function setOverlayVisible(visible) {
  safeDom("call-overlay", () => {
    const overlay = ensureCallOverlay();
    overlay.classList.toggle("hidden", !visible);
    document.body.classList.toggle("in-call", visible);
  });
}

function setCallStatus(text) {
  safeDom("call-status", () => {
    const el = document.getElementById("call-status-text");
    if (el) el.textContent = text || "";
  });
}

function setPeerInfo(peer) {
  safeDom("call-peer", () => {
    const nameEl = document.getElementById("call-peer-name");
    const avatarEl = document.getElementById("call-peer-avatar");
    if (nameEl) nameEl.textContent = peer?.display_name || "مستخدم";
    if (avatarEl) avatarEl.src = peer?.avatar_url || "./icons/icon.png";
  });
}

function startDurationTimer() {
  stopDurationTimer();
  const startedAt = Date.now();
  callState.durationTimer = setInterval(() => {
    safeDom("call-timer", () => {
      const el = document.getElementById("call-timer");
      if (!el) return;
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, "0");
      const ss = String(secs % 60).padStart(2, "0");
      el.textContent = `${mm}:${ss}`;
    });
  }, 1000);
}

function stopDurationTimer() {
  if (callState.durationTimer) {
    clearInterval(callState.durationTimer);
    callState.durationTimer = null;
  }
}

function playRingtone() {
  safeDom("ringtone", () => {
    const audio = document.getElementById("notification-sound");
    if (!audio) return;
    callState.ringtoneEl = audio;
    audio.loop = true;
    // play() قد يُرجع undefined في بيئات قديمة، وقد يُرفض بسبب سياسة التشغيل التلقائي
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  });
}

function stopRingtone() {
  safeDom("ringtone-stop", () => {
    const audio = callState.ringtoneEl || document.getElementById("notification-sound");
    if (!audio) return;
    audio.loop = false;
    audio.pause();
    audio.currentTime = 0;
  });
}

/* ------------------------------------------------------------
 * 4) الإشارات عبر Supabase Realtime
 * ---------------------------------------------------------- */
function signalChannelName(userId) {
  return `calls:user:${userId}`;
}

/**
 * قنوات الإرسال المُعاد استخدامها، مفتاحها اسم القناة.
 *
 * سبب الوجود: إنشاء قناة جديدة لكل إشارة ثم إزالتها بعد 1.5 ثانية كان
 * يُحدث تسابقاً — إرسال إشارتين متتاليتين لنفس الموضوع (مثل invite ثم end
 * عند فشل الاتصال) يُنشئ قناة ثانية بنفس الـ topic بينما الأولى قيد
 * الانضمام/الإزالة، فلا تصل الثانية أبداً إلى SUBSCRIBED وتنتهي بمهلة.
 */
const outboundChannels = new Map();

function getOutboundChannel(channelName) {
  const supabase = callState.ctx?.supabase;

  const existing = outboundChannels.get(channelName);
  if (existing) return existing;

  const channel = supabase.channel(channelName, {
    config: { broadcast: { ack: true, self: false } },
  });

  // وعد انضمام واحد مشترك بين كل المُرسِلين لنفس القناة
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("مهلة الاشتراك بقناة الإشارة")),
      10000
    );

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve(channel);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error("تعذّر الاتصال بقناة الإشارة"));
      }
    });
  });

  const entry = { channel, ready };
  outboundChannels.set(channelName, entry);

  // عند الفشل، أزل القيد ليُعاد بناؤه نظيفاً في المحاولة التالية
  ready.catch(() => {
    outboundChannels.delete(channelName);
    try {
      supabase.removeChannel(channel);
    } catch {
      /* تجاهل */
    }
  });

  return entry;
}

/** يغلق كل قنوات الإرسال المؤقتة (يُستدعى عند انتهاء المكالمة) */
function closeOutboundChannels() {
  const supabase = callState.ctx?.supabase;

  outboundChannels.forEach(({ channel }) => {
    try {
      supabase?.removeChannel(channel);
    } catch {
      /* تجاهل */
    }
  });

  outboundChannels.clear();
}

async function sendSignal(targetUserId, event, payload) {
  const supabase = callState.ctx?.supabase;
  if (!supabase || !targetUserId) return false;

  return (
    await safeAsync(`calls:signal:${event}`, async () => {
      if (supabase.realtime.connectionState?.() === "disconnected") {
        supabase.realtime.connect();
      }
      const { channel, ready } = getOutboundChannel(signalChannelName(targetUserId));

      await ready;

      const result = await channel.send({ type: "broadcast", event, payload });

      if (result === "timed out" || result === "error") {
        throw new Error(`تعذّر إرسال إشارة ${event} (${result})`);
      }

      return true;
    }, { retries: 1, delayMs: 700 })
  ).ok;
}

/** يشترك في قناة الإشارات الخاصة بالمستخدم الحالي لاستقبال المكالمات */
export function subscribeToIncomingCalls() {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !me?.id) return;

  unsubscribeFromIncomingCalls();

  callState.signalChannel = supabase
    .channel(signalChannelName(me.id), { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "call:invite" }, ({ payload }) => {
      handleIncomingInvite(payload).catch((e) => console.error("[calls] invite", e));
    })
    .on("broadcast", { event: "call:accept" }, ({ payload }) => {
      handlePeerAccepted(payload);
    })
    .on("broadcast", { event: "call:decline" }, ({ payload }) => {
      handlePeerDeclined(payload);
    })
    .on("broadcast", { event: "call:end" }, ({ payload }) => {
      handlePeerEnded(payload);
    })
    .subscribe();
}

export function unsubscribeFromIncomingCalls() {
  const supabase = callState.ctx?.supabase;
  if (supabase && callState.signalChannel) {
    try {
      supabase.removeChannel(callState.signalChannel);
    } catch {
      /* تجاهل */
    }
  }
  callState.signalChannel = null;
}

/* ------------------------------------------------------------
 * 5) سجل المكالمات في قاعدة البيانات
 * ---------------------------------------------------------- */
async function persistCallRoom(room) {
  const supabase = callState.ctx?.supabase;
  if (!supabase) return false;
  const activeRoom = await supabase
    .from("call_rooms")
    .select("id,status")
    .eq("conversation_id", room.conversationId)
    .in("status", ["ringing", "active"])
    .limit(1)
    .maybeSingle();
  if (activeRoom.error) {
    notify("تعذّر التحقق من حالة المكالمة. طبّق سياسات RLS الخاصة بالمكالمات.");
    return false;
  }
  if (activeRoom.data) {
    notify("توجد مكالمة جارية في هذه المحادثة.");
    return false;
  }
  const result = await safeQuery("calls:insert-room", () =>
    supabase.from("call_rooms").insert({
      id: room.roomId,
      conversation_id: room.conversationId,
      channel_name: room.channel,
      call_type: room.callType,
      caller_id: room.callerId,
      callee_id: room.calleeId,
      status: "ringing",
    })
  );
  if (!result.ok) {
    if (result.error?.code === "23505") {
      notify("توجد مكالمة جارية في هذه المحادثة.");
    } else {
      notify("تعذّر إنشاء غرفة المكالمة. طبّق schema.sql ثم أعد المحاولة.");
    }
  }
  return result.ok;
}

async function updateCallRoom(roomId, patch) {
  const supabase = callState.ctx?.supabase;
  if (!supabase || !roomId) return;
  await safeQuery("calls:update-room", () =>
    supabase.from("call_rooms").update(patch).eq("id", roomId)
  );
}

async function logCallEvent(roomId, event, meta = {}) {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !roomId || !me?.id) return false;
  const result = await safeQuery("calls:log", () =>
    supabase.from("call_logs").insert({
      room_id: roomId,
      user_id: me.id,
      event,
      metadata: meta,
    })
  );
  return result.ok;
}

async function writeCallMessage(call, status, durationSeconds = 0) {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !call?.conversationId || !me?.id) return;
  const isMissed = status === "missed";
  const label = isMissed ? "مكالمة فائتة" : call.callType === "video" ? "مكالمة فيديو" : "مكالمة صوتية";
  const duration = durationSeconds ? ` · المدة ${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, "0")}` : "";
  await safeQuery("calls:chat-message", () =>
    supabase.from("messages").insert({
      conversation_id: call.conversationId,
      sender_id: me.id,
      content: `${label}${duration}`,
      message_type: "call",
      call_id: call.roomId,
      call_duration_seconds: durationSeconds || null,
      status: "sent",
    })
  );
}

async function setCallPresence(status) {
  const supabase = callState.ctx?.supabase;
  const me = callState.ctx?.getMe?.();
  if (!supabase || !me?.id) return;
  await safeQuery("calls:presence", () =>
    supabase
      .from("profiles")
      .update({ call_status: status, call_status_at: new Date().toISOString() })
      .eq("id", me.id)
  );
}

/* ------------------------------------------------------------
 * 6) إدارة Agora RTC
 * ---------------------------------------------------------- */
async function fetchAgoraToken(channel, uid) {
  if (!AGORA.tokenEndpoint) {
    // A secured Agora project rejects tokenless joins with
    // CAN_NOT_GET_GATEWAY_SERVER / dynamic use static key. Fail before join
    // so the user gets an actionable message instead of a noisy SDK error.
    throw new Error(
      "Agora يحتاج إلى توكن أمان. فعّل نقطة AGORA_TOKEN_ENDPOINT أو عطّل App Certificate في Agora Console (Testing)."
    );
  }

  const result = await safeAsync("calls:token", async () => {
    const authResult = await callState.ctx?.supabase?.auth?.getSession?.();
    const accessToken = authResult?.data?.session?.access_token;
    const headers = { "Content-Type": "application/json" };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const res = await fetch(AGORA.tokenEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ channelName: channel, uid }),
    });
    if (!res.ok) throw new Error(`خادم التوكن أعاد ${res.status}`);
    const json = await res.json();
    return json?.token || null;
  });

  if (!result.ok || !result.data) {
    throw result.error || new Error("لم يُرجع خادم Agora توكناً صالحاً.");
  }

  return result.data;
}

function attachClientHandlers(client) {
  client.on("user-published", async (user, mediaType) => {
    await safeAsync("calls:subscribe-remote", async () => {
      await client.subscribe(user, mediaType);
      callState.remoteUsers.set(user.uid, user);

      if (mediaType === "video") {
        safeDom("remote-video", () => {
          const container = document.getElementById("call-remote-video");
          if (container) {
            container.innerHTML = "";
            user.videoTrack?.play(container, { fit: "cover" });
            container.classList.add("has-video");
            document.getElementById("call-peer-card")?.classList.add("compact");
          }
        });
      }

      if (mediaType === "audio") {
        user.audioTrack?.play();
      }
    });
  });

  client.on("user-unpublished", (user, mediaType) => {
    if (mediaType === "video") {
      safeDom("remote-video-off", () => {
        const container = document.getElementById("call-remote-video");
        if (container) {
          container.innerHTML = "";
          container.classList.remove("has-video");
          document.getElementById("call-peer-card")?.classList.remove("compact");
        }
      });
    }
  });

  client.on("user-left", (user) => {
    callState.remoteUsers.delete(user.uid);
    if (callState.remoteUsers.size === 0 && callState.current) {
      notify("انتهت المكالمة — غادر الطرف الآخر.");
      endCall("ended", { silent: true });
    }
  });

  client.on("connection-state-change", (curr) => {
    if (curr === "DISCONNECTED" && callState.current) {
      setCallStatus("انقطع الاتصال...");
    } else if (curr === "RECONNECTING") {
      setCallStatus("إعادة الاتصال...");
    }
  });

  client.on("exception", (evt) => {
    if (evt?.code === 1003 || evt?.code === 3003) return;
    console.warn("[calls] Agora exception:", evt?.code, evt?.msg);
  });
}

async function joinAgoraChannel({ channel, callType }) {
  const AgoraRTC = await loadAgoraSdk();

  const me = callState.ctx?.getMe?.();
  const uid = uidFromUserId(me?.id);

  const client = AgoraRTC.createClient({ mode: AGORA.mode, codec: AGORA.codec });
  callState.client = client;
  attachClientHandlers(client);

  const token = await fetchAgoraToken(channel, uid);
  await client.join(AGORA.appId, channel, token || null, uid);

  // --- المسارات المحلية ---
  const tracks = [];

  const audioResult = await safeAsync("calls:mic-track", () =>
    AgoraRTC.createMicrophoneAudioTrack({
      encoderConfig: AGORA.audioProfile,
      AEC: true, // إلغاء الصدى
      ANS: true, // تقليل الضوضاء
      AGC: true, // تحكم تلقائي بمستوى الصوت
    })
  );

  if (audioResult.ok && audioResult.data) {
    callState.localAudioTrack = audioResult.data;
    tracks.push(audioResult.data);
  } else {
    notify("تعذّر الوصول إلى الميكروفون — تحقق من أذونات المتصفح.");
  }

  if (callType === "video") {
    const videoResult = await safeAsync("calls:cam-track", () =>
      AgoraRTC.createCameraVideoTrack({
        encoderConfig: AGORA.videoProfile,
        optimizationMode: "motion",
      })
    );

    if (videoResult.ok && videoResult.data) {
      callState.localVideoTrack = videoResult.data;
      tracks.push(videoResult.data);

      safeDom("local-video", () => {
        const container = document.getElementById("call-local-video");
        if (container) {
          container.innerHTML = "";
          container.classList.remove("hidden");
          videoResult.data.play(container, { fit: "cover", mirror: true });
        }
      });
    } else {
      notify("تعذّر الوصول إلى الكاميرا — ستتم المتابعة بالصوت فقط.");
    }
  }

  if (tracks.length) {
    await safeAsync("calls:publish", () => client.publish(tracks));
  }

  return client;
}

async function releaseLocalTracks() {
  for (const key of ["localAudioTrack", "localVideoTrack"]) {
    const track = callState[key];
    if (!track) continue;
    try {
      track.stop();
      track.close();
    } catch (err) {
      console.warn("[calls] track release", err);
    }
    callState[key] = null;
  }
}

async function leaveAgoraChannel() {
  await releaseLocalTracks();

  if (callState.client) {
    await safeAsync("calls:leave", async () => {
      callState.client.removeAllListeners?.();
      await callState.client.leave();
    });
    callState.client = null;
  }

  callState.remoteUsers.clear();

  safeDom("clear-videos", () => {
    const remote = document.getElementById("call-remote-video");
    const local = document.getElementById("call-local-video");
    if (remote) {
      remote.innerHTML = "";
      remote.classList.remove("has-video");
    }
    if (local) {
      local.innerHTML = "";
      local.classList.add("hidden");
    }
    document.getElementById("call-peer-card")?.classList.remove("compact");
  });
}

/** يحوّل أخطاء الانضمام التقنية إلى رسالة مفهومة وقابلة للتصرّف */
function describeJoinFailure(error) {
  const msg = String(error?.message || "");

  if (/Agora RTC|مكتبة Agora|AgoraRTC/i.test(msg)) {
    return "تعذّر تحميل مكتبة المكالمات — تحقق من الاتصال أو من حاجب الإعلانات ثم أعد المحاولة.";
  }

  // أخطاء أذونات الأجهزة من Agora
  if (/PERMISSION_DENIED|NotAllowedError/i.test(msg)) {
    return "تم رفض إذن الكاميرا/الميكروفون — فعّله من إعدادات المتصفح.";
  }

  if (/NotFoundError|DEVICE_NOT_FOUND/i.test(msg)) {
    return "لم يُعثر على كاميرا أو ميكروفون متصل بالجهاز.";
  }

  if (/AGORA يحتاج إلى توكن|CAN_NOT_GET_GATEWAY_SERVER|dynamic use static key|invalid token|INVALID_TOKEN/i.test(msg)) {
    return "تعذّر اتصال Agora لأن المشروع يستخدم App Certificate بدون توكن. اضبط AGORA_TOKEN_ENDPOINT أو عطّل الشهادة من Agora Console للاختبار.";
  }

  if (/INVALID_VENDOR_KEY/i.test(msg)) {
    return "معرّف مشروع Agora غير صحيح — راجع App ID في js/config.js.";
  }

  return "تعذّر بدء المكالمة: " + (msg || "خطأ غير معروف");
}

/* ------------------------------------------------------------
 * 7) تدفق المكالمة الصادرة
 * ---------------------------------------------------------- */
export async function startCall(callType = "audio") {
  if (callState.current || callState.joining) {
    notify("هناك مكالمة جارية بالفعل.");
    return;
  }

  if (!isAgoraConfigured()) {
    notify("مكالمات Agora غير مهيّأة بعد — أضف App ID في js/config.js.");
    return;
  }

  const me = callState.ctx?.getMe?.();
  const conv = callState.ctx?.getActiveConversation?.();

  if (!me?.id) {
    notify("يجب تسجيل الدخول أولاً.");
    return;
  }

  if (!conv?.id || !conv?.otherProfile?.id) {
    notify("افتح محادثة أولاً لبدء مكالمة.");
    return;
  }

  if (!navigator.onLine) {
    notify("لا يمكن إجراء مكالمة بدون اتصال بالإنترنت.");
    return;
  }

  callState.joining = true;

  const roomId = uuid();
  const channel = buildAgoraChannelName(conv.id);
  const peer = conv.otherProfile;

  callState.current = {
    roomId,
    channel,
    callType,
    peer,
    conversationId: conv.id,
    direction: "outgoing",
    connected: false,
  };

  setPeerInfo(peer);
  setCallStatus(callType === "video" ? "جارٍ الاتصال بالفيديو..." : "جارٍ الاتصال...");
  setOverlayVisible(true);
  updateControlsForType(callType);

  const roomCreated = await persistCallRoom({
    roomId,
    conversationId: conv.id,
    channel,
    callType,
    callerId: me.id,
    calleeId: peer.id,
  });
  if (!roomCreated) {
    callState.current = null;
    callState.joining = false;
    setOverlayVisible(false);
    return;
  }

  await logCallEvent(roomId, "initiated", { call_type: callType });
  await setCallPresence("in_call");

  const delivered = await sendSignal(peer.id, "call:invite", {
    roomId,
    channel,
    callType,
    conversationId: conv.id,
    caller: {
      id: me.id,
      display_name: me.display_name,
      avatar_url: me.avatar_url || null,
    },
  });

  if (!delivered) {
    notify("تعذّر إرسال دعوة المكالمة — قد يكون الطرف الآخر غير متصل.");
  }

  // انضم للقناة مباشرة حتى يسمع/يرى فوراً عند قبول الطرف الآخر
  const joined = await safeAsync("calls:join-outgoing", () =>
    joinAgoraChannel({ channel, callType })
  );

  callState.joining = false;

  if (!joined.ok) {
    notify(describeJoinFailure(joined.error));
    await endCall("failed");
    return;
  }

  // مهلة الرنين
  clearTimeout(callState.ringTimer);
  callState.ringTimer = setTimeout(() => {
    if (callState.current && !callState.current.connected) {
      notify("لم يرد الطرف الآخر على المكالمة.");
      endCall("missed");
    }
  }, AGORA.ringTimeoutMs);
}

/* ------------------------------------------------------------
 * 8) تدفق المكالمة الواردة
 * ---------------------------------------------------------- */
async function handleIncomingInvite(payload) {
  if (!payload?.roomId || !payload?.channel) return;

  // مشغول بمكالمة أخرى → ارفض تلقائياً
  if (callState.current || callState.incoming) {
    await sendSignal(payload.caller?.id, "call:decline", {
      roomId: payload.roomId,
      reason: "busy",
    });
    return;
  }

  callState.incoming = payload;

  safeDom("incoming-show", () => {
    const box = ensureIncomingDialog();
    const nameEl = box.querySelector("#incoming-name");
    const subEl = box.querySelector("#incoming-sub");
    const avatarEl = box.querySelector("#incoming-avatar");

    if (nameEl) nameEl.textContent = payload.caller?.display_name || "مكالمة واردة";
    if (subEl) {
      subEl.textContent =
        payload.callType === "video" ? "مكالمة فيديو واردة..." : "مكالمة صوتية واردة...";
    }
    if (avatarEl) avatarEl.src = payload.caller?.avatar_url || "./icons/icon.png";

    box.classList.remove("hidden");
  });

  playRingtone();

  clearTimeout(callState.ringTimer);
  callState.ringTimer = setTimeout(() => {
    if (callState.incoming?.roomId === payload.roomId) {
      hideIncomingDialog();
      logCallEvent(payload.roomId, "missed", {});
      writeCallMessage({
        roomId: payload.roomId,
        conversationId: payload.conversationId,
        callType: payload.callType,
      }, "missed");
      callState.incoming = null;
    }
  }, AGORA.ringTimeoutMs);
}

function hideIncomingDialog() {
  stopRingtone();
  clearTimeout(callState.ringTimer);
  safeDom("incoming-hide", () => {
    document.getElementById("incoming-call")?.classList.add("hidden");
  });
}

async function acceptIncomingCall() {
  const invite = callState.incoming;
  if (!invite) return;

  callState.incoming = null;
  hideIncomingDialog();

  if (!isAgoraConfigured()) {
    notify("مكالمات Agora غير مهيّأة على هذا الجهاز.");
    return;
  }

  callState.current = {
    roomId: invite.roomId,
    channel: invite.channel,
    callType: invite.callType,
    peer: invite.caller,
    conversationId: invite.conversationId,
    direction: "incoming",
    connected: true,
    startedAt: Date.now(),
  };

  setPeerInfo(invite.caller);
  setCallStatus("جارٍ الانضمام...");
  setOverlayVisible(true);
  updateControlsForType(invite.callType);

  await sendSignal(invite.caller?.id, "call:accept", { roomId: invite.roomId });
  await updateCallRoom(invite.roomId, {
    status: "active",
    answered_at: new Date().toISOString(),
  });
  await logCallEvent(invite.roomId, "answered", {});
  await setCallPresence("in_call");

  const joined = await safeAsync("calls:join-incoming", () =>
    joinAgoraChannel({ channel: invite.channel, callType: invite.callType })
  );

  if (!joined.ok) {
    notify(describeJoinFailure(joined.error));
    await endCall("failed");
    return;
  }

  setCallStatus("متصل");
  startDurationTimer();
}

async function declineIncomingCall() {
  const invite = callState.incoming;
  callState.incoming = null;
  hideIncomingDialog();

  if (!invite) return;

  await sendSignal(invite.caller?.id, "call:decline", {
    roomId: invite.roomId,
    reason: "declined",
  });
  await updateCallRoom(invite.roomId, {
    status: "declined",
    ended_at: new Date().toISOString(),
  });
  await logCallEvent(invite.roomId, "declined", {});
}

/* ------------------------------------------------------------
 * 9) أحداث الطرف الآخر
 * ---------------------------------------------------------- */
function handlePeerAccepted(payload) {
  if (!callState.current || callState.current.roomId !== payload?.roomId) return;
  callState.current.connected = true;
  callState.current.startedAt = Date.now();
  clearTimeout(callState.ringTimer);
  setCallStatus("متصل");
  startDurationTimer();
  updateCallRoom(payload.roomId, {
    status: "active",
    answered_at: new Date().toISOString(),
  });
}

function handlePeerDeclined(payload) {
  if (!callState.current || callState.current.roomId !== payload?.roomId) return;
  notify(payload?.reason === "busy" ? "الطرف الآخر مشغول حالياً." : "تم رفض المكالمة.");
  endCall("declined", { silent: true });
}

function handlePeerEnded(payload) {
  if (callState.current && callState.current.roomId === payload?.roomId) {
    endCall("ended", { silent: true });
    return;
  }
  if (callState.incoming && callState.incoming.roomId === payload?.roomId) {
    callState.incoming = null;
    hideIncomingDialog();
  }
}

/* ------------------------------------------------------------
 * 10) إنهاء المكالمة وتنظيف الموارد
 * ---------------------------------------------------------- */
export async function endCall(reason = "ended", { silent = false } = {}) {
  const call = callState.current;

  clearTimeout(callState.ringTimer);
  stopDurationTimer();
  stopRingtone();
  callState.joining = false;

  await leaveAgoraChannel();

  setOverlayVisible(false);
  setCallStatus("");
  safeDom("reset-timer", () => {
    const el = document.getElementById("call-timer");
    if (el) el.textContent = "";
  });

  callState.micMuted = false;
  callState.cameraOff = false;
  callState.current = null;

  await setCallPresence("available");

  if (!call) return;

  if (!silent) {
    await sendSignal(call.peer?.id, "call:end", { roomId: call.roomId });
  }

  await updateCallRoom(call.roomId, {
    status: reason === "ended" ? "ended" : reason,
    ended_at: new Date().toISOString(),
  });
  await logCallEvent(call.roomId, reason, { direction: call.direction });
  const durationSeconds = call.connected && call.startedAt
    ? Math.max(1, Math.floor((Date.now() - call.startedAt) / 1000))
    : 0;
  await writeCallMessage(call, reason === "missed" ? "missed" : "ended", durationSeconds);

  // حرّر قنوات الإشارة بعد اكتمال إرسال call:end
  closeOutboundChannels();
}

/* ------------------------------------------------------------
 * 11) ضوابط واجهة المكالمة
 * ---------------------------------------------------------- */
function updateControlsForType(callType) {
  safeDom("call-controls", () => {
    const isVideo = callType === "video";
    document.getElementById("call-btn-cam")?.classList.toggle("hidden", !isVideo);
    document.getElementById("call-btn-switch")?.classList.toggle("hidden", !isVideo);
    document.getElementById("call-local-video")?.classList.toggle("hidden", !isVideo);
  });
}

async function toggleMicrophone() {
  const track = callState.localAudioTrack;
  if (!track) return;

  callState.micMuted = !callState.micMuted;
  await safeAsync("calls:toggle-mic", () => track.setMuted(callState.micMuted));

  safeDom("mic-btn", () => {
    const btn = document.getElementById("call-btn-mic");
    if (!btn) return;
    btn.textContent = callState.micMuted ? "🔇" : "🎙️";
    btn.classList.toggle("active", callState.micMuted);
  });
}

async function toggleCamera() {
  const track = callState.localVideoTrack;
  if (!track) return;

  callState.cameraOff = !callState.cameraOff;
  await safeAsync("calls:toggle-cam", () => track.setMuted(callState.cameraOff));

  safeDom("cam-btn", () => {
    const btn = document.getElementById("call-btn-cam");
    if (btn) {
      btn.textContent = callState.cameraOff ? "🚫" : "🎥";
      btn.classList.toggle("active", callState.cameraOff);
    }
    document.getElementById("call-local-video")?.classList.toggle("hidden", callState.cameraOff);
  });
}

async function switchCamera() {
  const track = callState.localVideoTrack;
  if (!track) return;

  await safeAsync("calls:switch-cam", async () => {
    const AgoraRTC = await loadAgoraSdk();
    const cameras = await AgoraRTC.getCameras();
    if (!cameras || cameras.length < 2) {
      notify("لا توجد كاميرا أخرى متاحة.");
      return;
    }
    const currentLabel = track.getTrackLabel?.();
    const next = cameras.find((c) => c.label !== currentLabel) || cameras[0];
    await track.setDevice(next.deviceId);
  });
}

/* ------------------------------------------------------------
 * 12) التهيئة العامة + ربط أزرار الواجهة
 * ---------------------------------------------------------- */
export function initCalls(ctx) {
  callState.ctx = ctx;

  ensureCallOverlay();
  ensureIncomingDialog();

  // إنهاء آمن عند إغلاق التبويب حتى لا تبقى غرفة معلّقة
  window.addEventListener("pagehide", () => {
    if (callState.current) {
      try {
        navigator.sendBeacon?.("about:blank");
      } catch {
        /* تجاهل */
      }
      leaveAgoraChannel();
    }
  });

  // Esc لإنهاء المكالمة
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && callState.current) endCall("ended");
  });
}

/** يربط أزرار المكالمة في رأس المحادثة (تُستدعى بعد حقن الـ partial) */
export function wireCallButtons() {
  const audioBtn = document.getElementById("chat-call-audio");
  const videoBtn = document.getElementById("chat-call-video");

  if (audioBtn && !audioBtn.dataset.wired) {
    audioBtn.dataset.wired = "1";
    audioBtn.addEventListener("click", guard("call:start-audio", () => startCall("audio")));
  }

  if (videoBtn && !videoBtn.dataset.wired) {
    videoBtn.dataset.wired = "1";
    videoBtn.addEventListener("click", guard("call:start-video", () => startCall("video")));
  }
}

export function isCallActive() {
  return Boolean(callState.current);
}
