import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getMessaging,
  getToken,
  onMessage,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

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

let firebaseApp = null;
let messaging = null;

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

    const registration =
      await registerFirebaseServiceWorker();

    let token = null;
    let lastError = null;
    // إعادة محاولة قصيرة: أول getToken بعد التسجيل قد يفشل بسبب سباق تفعيل الـ SW
    for (let attempt = 0; attempt < 3 && !token; attempt += 1) {
      try {
        token = await getToken(messaging, {
          vapidKey: VAPID_KEY,
          serviceWorkerRegistration: registration,
        });
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (!token && lastError) throw lastError;

    if (!token) {
      console.warn(
        "[FCM] لم يتم الحصول على FCM Token."
      );
      return false;
    }

    localStorage.setItem(
      "fcm_token",
      token
    );

    if (userId) {
      localStorage.setItem(
        "fcm_user_id",
        String(userId)
      );
    }

    if (userId) {
      try {
        const { supabase } = await import("./supabaseClient.js");
        const { error } = await supabase.from("fcm_tokens").upsert(
          {
            user_id: userId,
            token,
            platform: detectPlatformLabel(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "token" }
        );
        if (error) {
          console.error("[FCM] فشل حفظ التوكن في Supabase:", error);
        }
      } catch (error) {

        console.error("[FCM] خطأ غير متوقع أثناء حفظ التوكن:", error);
      }
    }

    return true;

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
    const token = localStorage.getItem("fcm_token");
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

    localStorage.removeItem("fcm_token");
    localStorage.removeItem("fcm_user_id");

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
  soundUrl = "./sounds/notification.mp3",
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

      const title =
        notification.title ||
        data.title ||
        "رسالة جديدة";

      const body =
        notification.body ||
        data.body ||
        "لديك رسالة جديدة";

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

      if (
        Notification.permission === "granted" &&
        document.visibilityState === "visible"
      ) {
        try {
          // استخدم تسجيل Firebase نفسه، لا navigator.serviceWorker.ready؛
          // الأخير قد يعيد الـ App Shell worker المسجّل على النطاق الرئيسي.
          const registration =
            firebaseServiceWorkerRegistration ||
            (await navigator.serviceWorker.getRegistration(
              "./firebase-cloud-messaging-push-scope"
            )) ||
            (await navigator.serviceWorker.ready);

          await registration.showNotification(title, {
            body,
            icon: new URL("./icons/icon.png", window.location.origin).href,
            badge: new URL("./icons/icon.png", window.location.origin).href,
            tag: data.conversationId
              ? `conversation-${data.conversationId}`
              : "whatsapp-web-message",
            renotify: true,
            data: {
              ...data,
              conversationId: data.conversationId || data.conversation_id || "",
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

function detectPlatformLabel() {
  const ua = navigator.userAgent || "";
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches ? "-pwa" : "";
  if (/Android/i.test(ua)) return `android${standalone}`;
  if (/iPhone|iPad|iPod/i.test(ua)) return `ios${standalone}`;
  return `web${standalone}`;
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
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

export function getCurrentFcmToken() {
  return localStorage.getItem("fcm_token");
}

export { messaging };
