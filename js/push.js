import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getMessaging,
  getToken,
  onMessage,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

// ⚠️ لا يوجد onTokenRefresh في Firebase Web SDK v9+ (modular). استيراده يُسقط
// الوحدة كلها بـ SyntaxError فيتجمّد التطبيق. تدوير التوكن يُعالَج بإعادة
// استدعاء getToken دورياً (syncPushToken) — وهو الأسلوب الموصى به رسمياً.
const onTokenRefresh = null;

const firebaseConfig = {
  apiKey: "AIzaSyDeg6RBNC9bWw1QYxBkYtCuMMFPBzxpw4o",
  authDomain: "studio-6422025604-b97aa.firebaseapp.com",
  projectId: "studio-6422025604-b97aa",
  storageBucket: "studio-6422025604-b97aa.firebasestorage.app",
  messagingSenderId: "599267399266",
  appId: "1:599267399266:web:4cd19dbf69068019f5e33b",
  measurementId: "G-FFX14GZB51"
};
const VAPID_KEY =
  "BGKcsJH4YH7vV384UCmx_FKD0xGiWTNuMA7skLLUWzIodKXTSFLRleq1K0ttPMnXZfzQO42bQig8nSKTSIw1jts";

export const TOKEN_KEY = "fcm_token";
export const TOKEN_SYNC_KEY = "wa_fcm_last_sync";
export const TOKEN_MIN_SYNC_MS = 30 * 60 * 1000; // إعادة تحقق صامتة كل 30 دقيقة على الأكثر

let firebaseApp = null;
let messaging = null;
let syncPushTokenPromise = null;

try {
  firebaseApp = getApps().length
    ? getApps()[0]
    : initializeApp(firebaseConfig);

  messaging = getMessaging(firebaseApp);
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

      // قرار العرض:
      //   • التطبيق في المقدمة ويفتح نفس المحادثة → لا إشعار (التجربة أفضل داخل الواجهة)
      //   • أي حالة أخرى (تبويب في الخلفية، نافذة مغطاة، محادثة أخرى) → إشعار فوري
      // كانت النسخة السابقة تُسقط الإشعار كاملاً متى ما كان التبويب غير مرئي
      // (visibilityState !== "visible") — وهو سبب رئيسي لتوقّف الإشعارات حين
      // يبقى التطبيق في الخلفية. الآن الأصل هو العرض، والاستثناء ضيّق جداً.
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
        try {
          const audio = new Audio(soundUrl);

          audio.volume = 1;

          await audio.play().catch(() => {
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

        if (Notification.permission === "granted") {
          try {
            // استخدم تسجيل Firebase نفسه، لا navigator.serviceWorker.ready؛
            // الأخير قد يعيد الـ App Shell worker المسجّل على النطاق الرئيسي.
            const registration = await getMessagingServiceWorkerRegistration();

            await registration.showNotification(title, {
              body,
              icon: data.icon || new URL("./icons/icon.png", window.location.origin).href,
              badge: new URL("./icons/icon.png", window.location.origin).href,
              tag: conversationId
                ? `conversation-${conversationId}`
                : "whatsapp-web-message",
              renotify: true,
              // الصوت داخل التطبيق مسؤولية الواجهة، لكن إن كان التبويب في
              // الخلفية فلا يمكن تشغيل الصوت دائماً → نُبقي صوت النظام.
              silent: isVisible,
              data: {
                ...data,
                conversationId,
                messageId: data.messageId || data.message_id || "",
              },
              vibrate: [100, 50, 100],
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

      const lastSync = Number(localStorage.getItem(TOKEN_SYNC_KEY) || 0);
      const cached = localStorage.getItem(TOKEN_KEY);
      const needsServerWrite = force || !cached || !lastSync || Date.now() - lastSync > minIntervalMs;

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

      if (obtained && obtained !== cached) {
        console.log("[FCM] توكن جديد — جارٍ تحديث قاعدة البيانات.");
        token = obtained;
        localStorage.setItem(TOKEN_KEY, obtained);
        localStorage.removeItem(TOKEN_SYNC_KEY);
      }

      if (!token) return false;

      if (userId) {
        localStorage.setItem("fcm_user_id", String(userId));
      }

      if (!needsServerWrite) return true;

      const targetUser = userId || localStorage.getItem("fcm_user_id");
      if (!targetUser) return Boolean(token);

      const { supabase } = await import("./supabaseClient.js");

      // ملاحظة: نُرسل الأعمدة الأساسية فقط حتى لا يفشل الإدراج إذا لم تُنفَّذ
      // هجرات لاحقة أضافت أعمدة جديدة إلى fcm_tokens.
      const { error } = await supabase.from("fcm_tokens").upsert(
        {
          user_id: targetUser,
          token,
          platform: detectPlatformLabel(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "token" }
      );

      if (error) {
        console.error("[FCM] فشل حفظ التوكن في Supabase:", error);
        return false;
      }

      localStorage.setItem(TOKEN_SYNC_KEY, String(Date.now()));
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
