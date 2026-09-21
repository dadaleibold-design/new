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
  appId: "1:599267399266:web:329e49e24298af60f5e33b"
};

const VAPID_KEY =
  "BAxTu3HSXPEgeTyTRPoXvpkLQWu8llJQfsPEoUr0MDjHKRJ0VSzPFcJw5RFv-s6BTnZYeWEHW8NSQzAjfOxoJfo";

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
      }
    );

  await navigator.serviceWorker.ready;

  return firebaseServiceWorkerRegistration;
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

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });

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
            platform: "web",
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
          const registration = await navigator.serviceWorker.ready;

          await registration.showNotification(title, {
            body,
            icon: "./icons/icon.png",
            badge: "./icons/icon.png",
            tag: "whatsapp-web-message",
            data,
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

export function getCurrentFcmToken() {
  return localStorage.getItem("fcm_token");
}

export { messaging };
