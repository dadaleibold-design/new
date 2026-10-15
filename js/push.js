import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getMessaging,
  getToken,
  onMessage,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";
import { buildDeviceInfo, decideServerWrite, getOrCreateDeviceId } from "./push-policy.js";
import { isCallPushType } from "./call-media.js";
import { FIREBASE_CONFIG, VAPID_PUBLIC_KEY, isFirebaseConfigured, missingEnvKeys } from "./config.js";

// ⚠️ لا يوجد onTokenRefresh في Firebase Web SDK v9+ (modular). استيراده يُسقط
// الوحدة كلها بـ SyntaxError فيتجمّد التطبيق. تدوير التوكن يُعالَج بإعادة
// استدعاء getToken دورياً (syncPushToken) — وهو الأسلوب الموصى به رسمياً.
const onTokenRefresh = null;

/**
 * تهيئة Firebase — كل القيم من متغيرات البيئة (js/env.js)، لا شيء ثابت هنا:
 *   VITE_FIREBASE_API_KEY / VITE_FIREBASE_PROJECT_ID /
 *   VITE_FIREBASE_MESSAGING_SENDER_ID / VITE_FIREBASE_APP_ID
 * و authDomain/storageBucket مشتقّان من معرّف المشروع.
 */
const firebaseConfig = { ...FIREBASE_CONFIG };

/** مفتاح VAPID العام (من VITE_VAPID_PUBLIC_KEY) */
const VAPID_KEY = VAPID_PUBLIC_KEY;

export const TOKEN_KEY = "fcm_token";
export const TOKEN_SYNC_KEY = "wa_fcm_last_sync";
export const TOKEN_MIN_SYNC_MS = 30 * 60 * 1000; // إعادة تحقق صامتة كل 30 دقيقة على الأكثر

let firebaseApp = null;
let messaging = null;
let syncPushTokenPromise = null;

try {
  if (!isFirebaseConfigured()) {
    // لا نُسقط التطبيق: الإشعارات تُعطَّل بلطف مع بيان المتغيرات الناقصة
    console.warn(
      "[FCM] إعدادات Firebase ناقصة — الإشعارات معطّلة. المتغيرات الناقصة:",
      missingEnvKeys()
        .filter((k) => k.startsWith("VITE_FIREBASE"))
        .join(", ")
    );
  } else {
    firebaseApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

    messaging = getMessaging(firebaseApp);
  }
} catch (error) {
  console.error("[FCM] Firebase initialization failed:", error);
}

let firebaseServiceWorkerRegistration = null;

async function registerFirebaseServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker غير مدعوم في هذا المتصفح.");
  }

  if (!window.isSecureContext) {
    throw new Error(
      "إشعارات Firebase Web تتطلب HTTPS أو localhost."
    );
  }

  firebaseServiceWorkerRegistration =
    await navigator.serviceWorker.register(
      "./firebase-messaging-sw.js",
      {
        scope: "./firebase-cloud-messaging-push-scope",
        type: "classic",
        updateViaCache: "none",
      }
    );

  // ⚠️ navigator.serviceWorker.ready يخص الـ SW المتحكم بالصفحة (sw.js) وليس
  // عامل Firebase — لذا ننتظر تفعيل تسجيل Firebase نفسه صراحةً، وإلا قد يفشل
  // getToken بـ "no active Service Worker" على أول تفعيل.
  await waitForActiveWorker(firebaseServiceWorkerRegistration);
  console.info("[FCM] firebase-messaging-sw active", {
    scope: firebaseServiceWorkerRegistration.scope,
    state: firebaseServiceWorkerRegistration.active?.state || "unknown",
  });

  // حدّث ملف الـ SW عند كل تفعيل حتى لا يعلق المستخدم على نسخة قديمة
  firebaseServiceWorkerRegistration.update().catch(() => {});

  return firebaseServiceWorkerRegistration;
}

function waitForActiveWorker(registration, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (registration.active) return resolve(registration);
    const worker = registration.installing || registration.waiting;
    if (!worker) return resolve(registration);
    const timer = setTimeout(() => reject(new Error("انتهت مهلة تفعيل Service Worker الخاص بالإشعارات")), timeoutMs);
    const onChange = () => {
      if (worker.state === "activated") {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        resolve(registration);
      } else if (worker.state === "redundant") {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        reject(new Error("فشل تثبيت Service Worker الخاص بالإشعارات"));
      }
    };
    worker.addEventListener("statechange", onChange);
  });
}

export async function enablePushNotifications(userId = null) {
  try {
    if (!messaging) {
      throw new Error("Firebase Messaging غير مهيأ.");
    }

    if (!("Notification" in window)) {
      throw new Error("هذا المتصفح لا يدعم الإشعارات.");
    }

    if (!("serviceWorker" in navigator)) {
      throw new Error("Service Worker غير مدعوم.");
    }

    if (!window.isSecureContext) {
      throw new Error(
        "يجب تشغيل الموقع عبر HTTPS لتفعيل الإشعارات."
      );
    }

    let permission = Notification.permission;

    if (permission !== "granted") {
      permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
      console.warn("[FCM] Notification permission denied.");
      return false;
    }

    return await syncPushToken({ userId, force: true });
  } catch (error) {
    console.error(
      "[FCM] enablePushNotifications:",
      error
    );

    return false;
  }
}

export async function disablePushNotifications() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const userId = localStorage.getItem("fcm_user_id");

    if (token) {
      try {
        const { supabase } = await import("./supabaseClient.js");
        const query = supabase.from("fcm_tokens").delete().eq("token", token);
        const { error } = userId ? await query.eq("user_id", userId) : await query;
        if (error) {
          console.error("[FCM] فشل حذف التوكن من Supabase:", error);
        }
      } catch (error) {
        console.error("[FCM] خطأ غير متوقع أثناء حذف التوكن:", error);
      }
    }

    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("fcm_user_id");
    localStorage.removeItem(TOKEN_SYNC_KEY);

    console.log("[FCM] تم تعطيل الإشعارات محليًا.");

    return true;
  } catch (error) {
    console.error(
      "[FCM] disablePushNotifications:",
      error
    );

    return false;
  }
}

export function listenForForegroundMessages({
  onNotification = null,
  soundUrl = "./icons/notify.mp3",
  shouldSuppress = null,
  getActiveConversationId = null,
} = {}) {

  if (!messaging) {
    console.warn(
      "[FCM] Messaging غير مهيأ."
    );
    return () => {};
  }

  return onMessage(
    messaging,
    async (payload) => {

      console.log(
        "[FCM] Foreground message:",
        payload
      );

      const notification =
        payload.notification || {};

      const data =
        payload.data || {};

      // 📞 إشعارات المكالمات لا تُعرض ولا تُشغَّل فيها الأصوات هنا:
      //    الرنين داخل التطبيق يملكه calls.js (Realtime + ringtone). نمرّر الحدث
      //    إليه ليقرر (ويمنع التكرار). إشعار النظام يُعرض من SW فقط عند الخلفية.
      if (isCallPushType(data.type)) {
        window.dispatchEvent(
          new CustomEvent("wa-call-push", {
            detail: { type: String(data.type), data },
          })
        );
        return;
      }

      const conversationId = String(data.conversationId || data.conversation_id || "");
      const title =
        notification.title ||
        data.title ||
        "رسالة جديدة";

      const body =
        notification.body ||
        data.body ||
        "لديك رسالة جديدة";

      const isVisible = document.visibilityState === "visible";
      const activeId = typeof getActiveConversationId === "function" ? getActiveConversationId() : null;
      const viewingThread = Boolean(isVisible && conversationId && activeId === conversationId);

      // Suppress the open thread only; hidden pages use system audio, never Audio API.
      let suppress = false;
      if (typeof shouldSuppress === "function") {
        try {
          suppress = Boolean(shouldSuppress({ payload, data, conversationId, viewingThread }));
        } catch (error) {
          console.warn("[FCM] فشل تقييم shouldSuppress:", error);
        }
      } else {
        suppress = viewingThread;
      }

      if (!suppress) {
        if (document.visibilityState === "visible") {
          try {
            const audio = new Audio(soundUrl);

            audio.volume = 1;

            void audio.play().catch(() => {
              console.warn(
                "[FCM] تشغيل الصوت التلقائي محظور من المتصفح."
              );
            });
          } catch (error) {
            console.warn(
              "[FCM] Audio error:",
              error
            );
          }
        }

        if (Notification.permission === "granted") {
          try {
            // استخدم تسجيل Firebase نفسه، لا navigator.serviceWorker.ready؛
            // الأخير قد يعيد الـ App Shell worker المسجّل على النطاق الرئيسي.
            const registration = await getMessagingServiceWorkerRegistration();

            // Recheck after async registration lookup: the page may now be hidden.
            const silent = document.visibilityState === "visible";
            await registration.showNotification(title, {
              body,
              icon: data.icon || new URL("./icons/icon.png", window.location.origin).href,
              badge: new URL("./icons/icon.png", window.location.origin).href,
              tag: conversationId
                ? `chat-${conversationId}`
                : "whatsapp-web-message",
              renotify: true,
              // الصوت داخل التطبيق مسؤولية الواجهة، لكن إن كان التبويب في
              // الخلفية فلا يمكن تشغيل الصوت دائماً → نُبقي صوت النظام.
              silent,
              data: {
                ...data,
                conversationId,
                messageId: data.messageId || data.message_id || "",
              },
              ...(silent ? {} : { vibrate: [100, 50, 100] }),
            });
          } catch (error) {
            console.warn(
              "[FCM] Foreground showNotification error:",
              error
            );
          }
        }
      }

      if (typeof onNotification === "function") {
        onNotification({
          payload,
          title,
          body,
          data,
        });
      }
    }
  );
}

/** يعيد تسجيل الـ Service Worker الخاص بالإشعارات (أو يعيد استخدامه) */
async function getMessagingServiceWorkerRegistration() {
  if (firebaseServiceWorkerRegistration?.active) {
    return firebaseServiceWorkerRegistration;
  }
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker غير مدعوم.");
  }
  try {
    const existing = await navigator.serviceWorker.getRegistration(
      "./firebase-cloud-messaging-push-scope"
    );
    if (existing?.active) {
      firebaseServiceWorkerRegistration = existing;
      return existing;
    }
  } catch {
    /* تجاهل — سنُسجّل من جديد */
  }
  return registerFirebaseServiceWorker();
}

function detectPlatformLabel() {
  const ua = navigator.userAgent || "";
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches ? "-pwa" : "";
  if (/Android/i.test(ua)) return `android${standalone}`;
  if (/iPhone|iPad|iPod/i.test(ua)) return `ios${standalone}`;
  return `web${standalone}`;
}

/**
 * مزامنة توكن FCM مع قاعدة البيانات — دالة القلب في موثوقية إشعارات الخلفية.
 *
 * لماذا نحتاجها؟ توكن FCM ليس ثابتاً:
 *   1) عند تدوير اشتراك Push في المتصفح يُصدر FCM توكن جديداً فوراً.
 *   2) التوكن القديم يصبح غير صالح، فيحذفه Edge Function من `fcm_tokens`
 *      عند استلام 404/410 (UNREGISTERED) — وتتوقّف الإشعارات كلياً.
 *   3) إن كان التطبيق مفتوحاً في الخلفية ولا يُعاد تفعيله، لا يعود التوكن
 *      إلى قاعدة البيانات أبداً؛ لذلك نُزامن: كل عودة للمقدمة، وكل تدوير
 *      توكن (onTokenRefresh)، ودورياً كل 30 دقيقة على الأكثر.
 *
 * @param {{ userId?:string|null, force?:boolean, minIntervalMs?:number }} options
 * @returns {Promise<boolean>} true إن كان التوكن موجوداً ومُسجَّلاً
 */
export async function syncPushToken({ userId = null, force = false, minIntervalMs = TOKEN_MIN_SYNC_MS } = {}) {
  if (syncPushTokenPromise) return syncPushTokenPromise;

  syncPushTokenPromise = (async () => {
    try {
      if (!messaging) return false;
      if (!("Notification" in window) || Notification.permission !== "granted") return false;
      if (!("serviceWorker" in navigator) || !window.isSecureContext) return false;

      // المستخدم المسجَّل سابقاً على هذا المتصفح (قبل هذه المزامنة)
      const previousUser = localStorage.getItem("fcm_user_id");
      const lastSync = Number(localStorage.getItem(TOKEN_SYNC_KEY) || 0);
      const cached = localStorage.getItem(TOKEN_KEY);

      let registration = null;
      try {
        registration = await getMessagingServiceWorkerRegistration();
      } catch (error) {
        console.warn("[FCM] تعذّر تجهيز Service Worker:", error);
      }

      let token = cached;
      let obtained = null;

      if (registration) {
        for (let attempt = 0; attempt < 2 && !obtained; attempt += 1) {
          try {
            obtained = await getToken(messaging, {
              vapidKey: VAPID_KEY,
              serviceWorkerRegistration: registration,
            });
          } catch (error) {
            console.warn(`[FCM] getToken فشل (محاولة ${attempt + 1}):`, error);
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }

      // التدوير يُكتشف هنا — قبل قرار الكتابة (كان القرار سابقاً يُحسب قبله فيتأخر الحفظ)
      const tokenChanged = Boolean(obtained && obtained !== cached);
      if (tokenChanged) {
        console.log("[FCM] توكن جديد لهذا المتصفح (تدوير) — سيُحفظ في الخادم فوراً.");
        token = obtained;
        localStorage.setItem(TOKEN_KEY, obtained);
        localStorage.removeItem(TOKEN_SYNC_KEY);
      }

      if (!token) return false;

      // تغيّر المستخدم على نفس المتصفح (تسجيل دخول بحساب آخر) → نقل التوكن للحساب الجديد
      const userChanged = Boolean(userId) && String(userId) !== previousUser;
      const decision = decideServerWrite({
        force,
        tokenChanged,
        userChanged,
        hasCachedToken: Boolean(cached),
        lastSyncAt: lastSync,
        now: Date.now(),
        minIntervalMs,
      });

      const targetUser = userId ? String(userId) : previousUser;
      if (!decision.write) {
        console.info(`[FCM] التوكن مُسجَّل مسبقاً — لا حاجة للكتابة (${decision.reason}).`);
        return true;
      }
      if (!targetUser) return Boolean(token);

      const { supabase } = await import("./supabaseClient.js");

      // هوية الجهاز الثابتة (لكل متصفح) + معلومات وصفية — تسمح بتمييز أجهزة المستخدم الواحد
      const platform = detectPlatformLabel();
      const deviceId = getOrCreateDeviceId(localStorage, () => crypto.randomUUID());
      const deviceInfo = buildDeviceInfo({
        platform,
        userAgent: navigator.userAgent || "",
        standalone: Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches),
        language: navigator.language || "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      });

      console.log(
        `[FCM] تسجيل جهاز للمستخدم ${String(targetUser).slice(0, 8)}… ` +
          `device=${deviceId ? deviceId.slice(0, 8) : "none"} platform=${platform} سبب=${decision.reason}`
      );

      // تسجيل التوكن عبر RPC آمنة (SECURITY DEFINER) تنقل التوكن إلى المستخدم الحالي
      // مباشرة وتُرجع الإجراء (inserted | refreshed | moved) — upsert عادي كانت ستحجبه RLS بصمت.
      let { data: rpcResult, error } = await supabase.rpc("register_fcm_token", {
        p_token: token,
        p_platform: platform,
        p_device_id: deviceId,
        p_device_info: deviceInfo,
      });

      // توافق رجعي: قبل تطبيق الهجرة v2.6/v2.7 تكون الدالة غير موجودة → upsert عادي
      if (error && /PGRST202|42883|schema cache|does not exist/i.test(`${error.code || ""} ${error.message || ""}`)) {
        console.warn("[FCM] دالة register_fcm_token غير متاحة — رجوع إلى upsert مباشر.");
        rpcResult = null;
        ({ error } = await supabase.from("fcm_tokens").upsert(
          {
            user_id: targetUser,
            token,
            platform,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "token" }
        ));
      }

      if (error) {
        console.error("[FCM] فشل حفظ التوكن في Supabase:", error);
        return false;
      }

      // لا نحدّث fcm_user_id إلا بعد نجاح الكتابة: فشل الشبكة يجعل المحاولة التالية تعيد الكتابة
      localStorage.setItem("fcm_user_id", String(targetUser));
      localStorage.setItem(TOKEN_SYNC_KEY, String(Date.now()));

      const action = rpcResult?.action || "upserted";
      console.info(
        `[FCM] token ${action} — user=${String(targetUser).slice(0, 8)}… ` +
          `device=${deviceId ? deviceId.slice(0, 8) : "none"} ` +
          `removedRotated=${rpcResult?.rotated_removed ?? 0} (…${token.slice(-8)})`
      );
      return true;
    } catch (error) {
      console.error("[FCM] syncPushToken:", error);
      return false;
    } finally {
      syncPushTokenPromise = null;
    }
  })();

  return syncPushTokenPromise;
}

/**
 * يراقب تدوير التوكن من Firebase ويعيد تسجيله فوراً.
 * بدونه: التوكن الموجود في قاعدة البيانات يصبح غير صالح بهدوء، ثم يُحذف،
 * فتتوقف إشعارات الخلفية حتى يفتح المستخدم التطبيق مرة أخرى.
 * @returns {() => void} دالة إلغاء المراقبة
 */
export function watchTokenRefresh(userId = null) {
  if (!messaging || typeof onTokenRefresh !== "function") return () => {};

  try {
    return onTokenRefresh(messaging, async () => {
      console.log("[FCM] تم تدوير التوكن — إعادة التسجيل على السيرفر.");
      try {
        localStorage.removeItem(TOKEN_SYNC_KEY);
        await syncPushToken({ userId: userId || localStorage.getItem("fcm_user_id"), force: true });
      } catch (error) {
        console.error("[FCM] فشل تسجيل التوكن المُدوَّر:", error);
      }
    });
  } catch (error) {
    console.warn("[FCM] تعذّر تفعيل مراقبة تدوير التوكن:", error);
    return () => {};
  }
}

/** هل سلسلة الإشعارات جاهزة فعلاً (إذن + SW + توكن)؟ */
export function isPushReady() {
  try {
    return Boolean(
      messaging &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      "serviceWorker" in navigator &&
      localStorage.getItem(TOKEN_KEY)
    );
  } catch {
    return false;
  }
}

/** وقت آخر مزامنة ناجحة مع السيرفر (ملّي ثانية) */
export function getLastTokenSyncAt() {
  try {
    return Number(localStorage.getItem(TOKEN_SYNC_KEY) || 0);
  } catch {
    return 0;
  }
}

/**
 * إرسال إشعار تجريبي لنفس الجهاز عبر Edge Function — يتحقق من السلسلة
 * كاملة (توكن → send-push → FCM → Service Worker) بدون انتظار رسالة حقيقية.
 */
export async function sendTestNotification() {
  const { supabase } = await import("./supabaseClient.js");
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./config.js");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("سجّل الدخول أولاً.");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ type: "test" }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.error || json?.results?.find?.((r) => !r.ok)?.error || json?.message || "";
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  return json;
}

export function getCurrentFcmToken() {
  return localStorage.getItem("fcm_token");
}

export { messaging };
