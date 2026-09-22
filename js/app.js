import { supabase } from "./supabaseClient.js";
import { signUp, signIn, signOut, getCurrentProfile, looksLikeEmail } from "./auth.js";
import { ADMINS, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { applyLanguage } from "./i18n.js";
import {
  cacheMessages,
  getCachedMessages,
  cacheConversationMeta,
  removeCachedMessage,
  cacheContacts,
  getCachedContacts,
  queueOutboxMessage,
  getOutbox,
  removeFromOutbox,
  saveReadState,
  getReadState,
} from "./db.js";
import {
  enablePushNotifications,
  listenForForegroundMessages,
  sendTestNotification,
  syncPushToken,
  watchTokenRefresh,
  isPushReady,
  getLastTokenSyncAt,
} from "./push.js";
import {
  initCalls,
  wireCallButtons,
  subscribeToIncomingCalls,
  unsubscribeFromIncomingCalls,
  isCallActive,
  endCall,
  startCallWith,
} from "./calls.js";
import {
  showPermissionCardIfNeeded,
  ensureNotificationsReady,
  openBackgroundHelp,
  wireBackgroundHelp,
} from "./notifications.js";
import {
  installGlobalErrorBoundary,
  safeAsync,
  safeQuery,
  safeDom,
  safeSync,
  guard,
} from "./safety.js";
import { prepareFileForUpload, MEDIA_PRESETS, formatBytes } from "./media.js";
import {
  createResilientChannel,
  ensureRealtimeConnected,
  startRealtimeWatchdog,
  diagnoseRealtime,
} from "./realtime.js";
import {
  initNotificationRouter,
  setNotificationRouteHandler,
  flushPendingRoutes,
  peekPendingRoute,
  clearPendingRoutes,
  dispatchRoute,
} from "./notification-router.js";

// يُشغَّل عند استيراد الوحدة (قبل boot) حتى لا يضيع نقر إشعار وقع أثناء الإقلاع
initNotificationRouter();

const state = {
  me: null,
  t: null,
  lang: localStorage.getItem("wa_lang") || "ar",
  theme: localStorage.getItem("wa_theme") || "dark",

  contacts: [],
  contactRowsByConversation: {},

  activeConversation: null,
  messages: [],
  reactions: {},
  replyingTo: null,

  msgChannel: null,
  typingChannel: null,
  reactionsChannel: null,
  presenceChannel: null,
  realtimeResubscribePromise: null,
  inboxChannel: null,
  globalMsgChannel: null,

  typingTimeout: null,
  onlineMap: {},
  heartbeatInterval: null,
  contactsRefreshInterval: null,
  contactsRefreshInFlight: false,

  // عدّادات غير المقروء: مصدر واحد للحقيقة في الواجهة (conversationId → عدد)
  unreadByConversation: {},
  subscribedConversationId: null,
  realtimeWatchdog: null,
  tokenRefreshUnsub: null,
  lastCatchUpAt: 0,
  hiddenCatchUpTimer: null,
  focusMessageId: null,

  recording: null,

  isOnline: navigator.onLine,

  clickedWelcomeButtons: new Set(),

  deferredInstallPrompt: null,
  installButton: null,

  mediaUploading: false,
  mediaUploadStatusElement: null,

  foregroundMessagesUnsub: null,

  authRole: localStorage.getItem("wa_auth_role") || "user",
  callsChannel: null,
  callHistoryFilter: "all",
  lastRenderedSignature: "",
  messagesHasMore: false,
  loadingOlder: false,
};

const MESSAGES_PAGE_SIZE = 80;
const MESSAGE_COLUMNS =
  "id,conversation_id,sender_id,content,attachment_url,attachment_type,reply_to_id,status,created_at,message_type,call_id,call_type,call_status,call_caller_id,call_duration_seconds,buttons";

const $ = (sel) => document.querySelector(sel);

async function boot() {
  // حاجز الأخطاء العام: يمنع أي استثناء غير معالج من تجميد/إسقاط الواجهة
  installGlobalErrorBoundary({ notify: (msg) => showAuthError(msg) });

  document.body.setAttribute("data-theme", state.theme);

  safeDom("boot:pwa", () => setupPWAInstallPrompt());

  await safeAsync("boot:partial", () => loadChatPanelPartial(), { retries: 1 });

  state.t = applyLanguage(state.lang);

  // تهيئة وحدة المكالمات مبكراً (دون تحميل SDK — يُحمَّل عند أول مكالمة)
  safeDom("boot:calls", () =>
    initCalls({
      supabase,
      getMe: () => state.me,
      getActiveConversation: () => state.activeConversation,
      notify: (msg) => showAuthError(msg),
      t: () => state.t,
      onCallLogged: () => {
        // حدّث المحادثة المفتوحة وشارة المكالمات الفائتة فور تسجيل المكالمة
        if (state.activeConversation) loadMessages(state.activeConversation.id, { silent: true });
        refreshMissedCallsBadge();
      },
      openConversation: async (peer, conversationId) => {
        await openConversation({ ...peer, _conversationId: conversationId });
      },
    })
  );

  const sessionResult = await safeAsync("boot:session", async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data?.session || null;
  });

  const session = sessionResult.data;

  wireAuthForms();
  wireChrome();

  $("#boot-loading")?.classList.add("hidden");

  if (session) {
    await safeAsync("boot:enterApp", () => enterApp(), {
      onError: () => showAuthError("تعذّر تحميل التطبيق بالكامل — حاول تحديث الصفحة."),
    });
  } else {
    showAuthScreen();
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      state.me = null;
      stopContactsRefreshLoop();
      stopRealtimeWatchdog();
      stopHiddenCatchUp();
      clearPendingRoutes();
      state.unreadByConversation = {};
      try {
        state.tokenRefreshUnsub?.();
      } catch {
        /* تجاهل */
      }
      state.tokenRefreshUnsub = null;
      try {
        state.foregroundMessagesUnsub?.();
      } catch {
        /* تجاهل */
      }
      state.foregroundMessagesUnsub = null;
      try {
        unsubscribeFromIncomingCalls();
      } catch (err) {
        console.error("unsubscribeFromIncomingCalls failed:", err);
      }
      showAuthScreen();
    }
  });

  window.addEventListener("beforeunload", () => {
    // لا يمكن انتظار طلب شبكة هنا؛ نُرسل نبضة keepalive حتى لا يبدو
    // المستخدم "متاحاً" بعد إغلاق التطبيق.
    // (لا تُرسل للمشرف: حضوره ثابت ودائم بالتصميم.)
    if (!state.me || state.me.is_admin) return;
    safeDom("beforeunload:offline", () => updatePresenceOfflineBeacon());
  });

  // ===== دورة حياة التطبيق في الخلفية =====
  // مهم: لا نقطع اتصال Realtime عند الإخفاء. التطبيق في الخلفية يجب أن يبقى
  // مستمعاً (أسرع من الإشعار) — والإشعار يعمل كطبقة ضمان. القطع كان يجعل
  // التطبيق "أصمّ" بعد العودة للمقدمة حتى إعادة الاشتراك.
  document.addEventListener("visibilitychange", async () => {
    if (!state.me) return;

    // لا تُغيّر حالة الاتصال أو تُعِد الاشتراك أثناء مكالمة جارية
    if (isCallActive()) return;

    await safeAsync("visibility", async () => {
      if (document.visibilityState === "hidden") {
        await touchLastSeen(false);
        scheduleHiddenCatchUp();
        return;
      }

      stopHiddenCatchUp();
      await touchLastSeen(true);
      // العودة للمقدمة: أعد بناء الاشتراكات إن ماتت أثناء التجميد،
      // ثم زامن ما فات (الرسائل + العدّادات) قبل أن يرى المستخدم واجهة قديمة.
      if (!diagnoseRealtime(supabase).healthy) await resubscribeRealtime("visible");
      await runCatchUpSync("visible");
    });
  });

  // التبويب المُجمّد (Frozen) لا يستقبل أحداث visibilitychange — هذه الأحداث
  // هي الطريقة الرسمية لمعرفة أن التبويب جُمّد/استُؤنف (Page Lifecycle API).
  document.addEventListener("resume", () => {
    if (!state.me) return;
    safeAsync("lifecycle:resume", async () => {
      await resubscribeRealtime("resume");
      await runCatchUpSync("resume");
    });
  });

  document.addEventListener("freeze", () => {
    // نحفظ آخر ظهور فقط حتى لا يظهر المستخدم "متاحاً" للأبد
    if (state.me) safeAsync("lifecycle:freeze", () => touchLastSeen(false));
  });

  window.addEventListener(
    "online",
    guard("net:online", () => {
      state.isOnline = true;
      updateOfflineBanner();
      flushOutbox();
      flushPendingReads();
      resubscribeRealtime("online");
      startContactsRefreshLoop();
      runCatchUpSync("online", { force: true });
    })
  );

  window.addEventListener(
    "offline",
    guard("net:offline", () => {
      state.isOnline = false;
      updateOfflineBanner();

      // انقطاع الشبكة أثناء مكالمة → أنهِها بلطف بدل تركها معلّقة
      if (isCallActive()) {
        showAuthError("انقطع الاتصال بالإنترنت — تم إنهاء المكالمة.");
        endCall("network_lost", { silent: true });
      }
    })
  );

  updateOfflineBanner();

  // استئناف من bfcache (iOS) — الصفحة كانت مُجمّدة والاتصال قد يكون مات
  window.addEventListener("pageshow", (event) => {
    if (!state.me || isCallActive()) return;
    safeAsync("pageshow", async () => {
      if (!diagnoseRealtime(supabase).healthy) await resubscribeRealtime("pageshow");
      await runCatchUpSync("pageshow", { force: event.persisted });
    });
  });

  window.addEventListener("focus", () => {
    if (!state.me || isCallActive()) return;
    if (document.visibilityState !== "visible") return;
    runCatchUpSync("focus");
  });

  window.addEventListener("popstate", (event) => {
    if (!event.state || !event.state.waChat) {
      closeChatView();
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#back-to-list")) {
      const h = window.history;

      if (h && h.state && h.state.waChat) {
        h.back();
      } else {
        closeChatView();
      }
    }
  });

  refreshPWAInstallButton();
}

window.addEventListener('pageshow', (event) => {
  if (event.persisted && supabase) {
    ensureRealtimeConnected(supabase);
    if (state.me) resubscribeRealtime("pageshow:persisted");
  }
});

// pagehide يقع عند الإخفاء *وعند* الخروج، والفرق في event.persisted:
//   persisted === true  → الصفحة ستُجمَّد وتُستأنف → لا نقطع الاتصال.
//   persisted === false → خروج فعلي → نقطع الاتصال ونُعلن عدم الاتصال.
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  // المشرف يبقى "متصل الآن" دائماً حتى عند الخروج (حضور ثابت بالتصميم)
  if (!state.me?.is_admin) {
    safeAsync("pagehide:last-seen", () => touchLastSeen(false));
  }
  if (supabase?.realtime) supabase.realtime.disconnect();
});

function openConversationUIState(conversationId) {
  document.body.classList.add("viewing-chat");

  // History API قد يكون محدوداً (iframe/sandbox) — لا تدع فشله يمنع فتح المحادثة
  safeDom("history:push", () => {
    const h = window.history;
    if (!h || typeof h.pushState !== "function") return;

    const entry = { waChat: true, conversationId };

    if (h.state && h.state.waChat) {
      h.replaceState(entry, "", "#chat");
    } else {
      h.pushState(entry, "", "#chat");
    }
  });
}

function closeChatView() {
  document.body.classList.remove("viewing-chat");

  $("#chat-panel")?.classList.remove("mobile-visible");
  $("#sidebar")?.classList.remove("mobile-hidden");

  clearChatSearchHighlights();
  document.querySelector("#chat-search-bar")?.classList.add("hidden");
}

function updateOfflineBanner() {
  const banner = $("#offline-banner");

  if (banner) {
    banner.classList.toggle("hidden", state.isOnline);
  }

  updateCallButtonsState();
}

async function loadChatPanelPartial() {
  const res = await fetch("./partials/chat-panel.html", { cache: "no-cache" });

  if (!res.ok) {
    throw new Error(`تعذّر تحميل واجهة المحادثة (${res.status})`);
  }

  const html = await res.text();

  const container = $("#chat-panel-container");

  if (container) {
    container.innerHTML = html;
  }
}

function showAuthScreen() {
  $("#auth-screen")?.classList.remove("hidden");
  $("#app-shell")?.classList.add("hidden");

  refreshPWAInstallButton();
}

async function enterApp() {
  const profileResult = await safeAsync("enterApp:profile", () => getCurrentProfile(), {
    retries: 1,
  });

  state.me = profileResult.data;
  if (state.me?.email && ADMINS.some((admin) => admin.email.toLowerCase() === state.me.email.toLowerCase())) {
    state.me.is_admin = true;
  }

  if (!state.me) {
    showAuthScreen();

    if (!profileResult.ok) {
      showAuthError("تعذّر جلب بيانات الحساب — تحقق من الاتصال ثم أعد المحاولة.");
    }

    return;
  }

  safeDom("enterApp:shell", () => {
    $("#auth-screen")?.classList.add("hidden");
    $("#app-shell")?.classList.remove("hidden");

    const nameEl = $("#my-name");
    if (nameEl) nameEl.textContent = state.me.display_name || "";

    const avatarEl = $("#my-avatar");
    if (avatarEl && state.me.avatar_url) {
      avatarEl.src = state.me.avatar_url;
    }
  });

  applyThemeVars();

  await touchLastSeen(true);

  startHeartbeat();

  await safeAsync("enterApp:contacts", () => loadContacts());
  startContactsRefreshLoop();

  safeDom("enterApp:realtime", () => {
    subscribeGlobalPresence();
    subscribeInboxUpdates();
    subscribeGlobalMessageWatch();
    subscribeToIncomingCalls();
    subscribeCallRoomsWatch();
  });

  // نبضة اليقظة: تكتشف موت اتصال Realtime (تجميد التبويب/Doze) وتُحييه
  startRealtimeWatchdogLoop({
    supabase,
    isEnabled: () => Boolean(state.me) && !isCallActive(),
    onRevive: (reason) => {
      // أثناء مكالمة جارية قناة الإشارات مقدّسة — لا نعيد بناءها
      if (isCallActive()) return Promise.resolve();
      return resubscribeRealtime(`watchdog:${reason}`);
    },
    onConnectionLost: (info) => {
      console.warn("[realtime] فُقد الاتصال:", info);
    },
  });

  // مراقبة تدوير توكن FCM: بدونه يصبح التوكن في قاعدة البيانات غير صالح
  // بصمت فتتوقف إشعارات الخلفية حتى يفتح المستخدم التطبيق من جديد.
  if (!state.tokenRefreshUnsub) {
    state.tokenRefreshUnsub = watchTokenRefresh(state.me.id);
  }

  // الإشعارات: جدّد التوكن بصمت إن كان الإذن ممنوحاً، وإلا اعرض بطاقة الطلب
  safeAsync("enterApp:notifications", async () => {
    const ready = await ensureNotificationsReady(state.me.id);
    if (!ready) {
      setTimeout(() => {
        showPermissionCardIfNeeded({
          userId: state.me?.id,
          notify: (msg) => showAuthError(msg),
        });
      }, 1500);
    }
  });

  refreshMissedCallsBadge();

  if (!state.foregroundMessagesUnsub) {
    try {
      state.foregroundMessagesUnsub = listenForForegroundMessages({
        // قرار عرض الإشعار والتطبيق في المقدمة: يُعرض دائماً إلا إن كان
        // المستخدم يقرأ نفس المحادثة أمام الشاشة (النسخة السابقة كانت
        // تُسقط الإشعار كلياً متى كان التبويب غير مرئي).
        shouldSuppress: ({ viewingThread }) => viewingThread,
        getActiveConversationId: () => state.activeConversation?.id || null,
        onNotification: ({ data }) => {
          // وصول إشعار FCM لجهازنا = الرسالة وصلتنا ⇒ ✓✓ رمادي عند المرسل
          const conversationId =
            data?.conversationId || data?.conversation_id || state.activeConversation?.id || null;
          if (conversationId) markMessagesDelivered(conversationId);
          loadContacts();
        },
      });
    } catch (err) {
      console.error("تعذّر تفعيل استماع رسائل FCM الأمامية:", err);
    }
  }

  // موجّه نقرات الإشعارات: يسجّل المعالج ثم يفرّغ أي نقر معلّق (وصل قبل الجهوزية)
  setNotificationRouteHandler((route) => openRouteFromNotification(route));
  flushPendingRoutes();

  // رسالة وصلت عبر Push والتطبيق في المقدمة → زامن فوراً (Realtime قد يتأخر)
  window.addEventListener("wa-push-delivered", () => {
    runCatchUpSync("push-delivered", { force: true });
  });

  // تغيّر اشتراك Push في المتصفح: التوكن القديم أصبح غير صالح → أعد التسجيل
  window.addEventListener("wa-push-resubscribe", () => {
    safeAsync("push:resubscribe", async () => {
      try {
        localStorage.removeItem("wa_fcm_last_sync");
      } catch {
        /* تجاهل */
      }
      await syncPushToken({ userId: state.me?.id, force: true });
    });
  });

  // إن كان المستخدم قد نقر إشعاراً أثناء إقلاع التطبيق فسجّلناه في الرابط
  handleDeepLinks();

  if (state.isOnline) {
    flushOutbox();

    // تصحيح جماعي لعلامات التسليم عند كل دخول: أي رسالة وصلت أثناء إغلاق
    // التطبيق تنتقل من ✓ إلى ✓✓ حتى لو تأخّر/فُقد إشعارها.
    safeAsync("enterApp:delivered-sweep", () => sweepDeliveredMessages({ force: true }));
  }

  updateUnreadTotals();
}

/**
 * نبضة "آخر ظهور" الخاصة بي.
 *
 * ملاحظة مهمة: للمشرفين لا تُرسَل حالة "غير متصل" إطلاقاً — حضور المشرف
 * ثابت في الواجهة وفي قاعدة البيانات (يُفرض بمُشغِّل على الجدول أيضاً)،
 * فلا يقطع "متصل الآن" عند المستخدم العادي بسبب سكون متصفح المشرف.
 */
async function touchLastSeen(online) {
  if (!state.me || !state.isOnline) return;
  if (!online && state.me.is_admin) return;

  await safeQuery("touchLastSeen", () =>
    supabase
      .from("profiles")
      .update({
        is_online: online,
        last_seen: new Date().toISOString(),
      })
      .eq("id", state.me.id)
  );
}

function startHeartbeat() {
  clearInterval(state.heartbeatInterval);

  state.heartbeatInterval = setInterval(() => {
    // نبضة فقط عند ظهور الصفحة واتصال الشبكة — توفير للبطارية والحزمة
    if (document.visibilityState === "visible" && state.isOnline && state.me) {
      touchLastSeen(true);
    }
  }, 25000);
}

/**
 * مزامنة هادئة لقائمة المحادثات والعدادات.
 * Realtime هو المسار الأسرع، وهذا المسار الاحتياطي يلتقط أي حدث لم يصل
 * بسبب إعادة الاتصال أو تعليق قناة Realtime، من دون لمس نافذة الدردشة.
 */
function startContactsRefreshLoop() {
  stopContactsRefreshLoop();
  if (!state.me) return;

  const tick = () => {
    const hidden = document.visibilityState === "hidden";
    // مؤقت متكيّف: سريع في المقدمة، بطيء في الخلفية (يخنق المتصفح المؤقتات
    // الخلفية أصلاً إلى نبضة/دقيقة، والاستعلام الثقيل كل 3 ثوانٍ هناك كان
    // يستهلك البطارية ويزيد احتمال تجميد التبويب من قِبَل المتصفح).
    state.contactsRefreshInterval = setTimeout(tick, hidden ? 60000 : 5000);

    // أثناء الخفاء: أعد تثبيت حضور المشرفين دورياً حتى تبقى الحالة صحيحة
    // عند أي إعادة رسم أو مزامنة تحدث في الخلفية.
    if (hidden) noteAdminPresenceOnline();

    if (!state.me || !state.isOnline || state.contactsRefreshInFlight) return;
    // أثناء مكالمة جارية لا نُثقل الشبكة/المعالج بمزامنة غير ضرورية
    if (isCallActive()) return;

    state.contactsRefreshInFlight = true;
    Promise.resolve(loadContacts())
      .catch((error) => {
        // لا نعرض خطأ للمستخدم في المزامنة الخلفية؛ الكاش وRealtime
        // يستمران بالعمل، وتُعاد المحاولة في الدورة التالية.
        console.warn("[contacts-sync] background refresh skipped:", error);
      })
      .finally(() => {
        state.contactsRefreshInFlight = false;
      });
  };

  state.contactsRefreshInterval = setTimeout(tick, 4000);
}

function stopContactsRefreshLoop() {
  if (state.contactsRefreshInterval) {
    clearTimeout(state.contactsRefreshInterval);
    clearInterval(state.contactsRefreshInterval);
    state.contactsRefreshInterval = null;
  }
  state.contactsRefreshInFlight = false;
}

/* ------------------------------------------------------------
 * إحياء الاتصال والمزامنة التفاضلية بعد الخلفية/التجميد
 * ---------------------------------------------------------- */

function startRealtimeWatchdogLoop(options) {
  stopRealtimeWatchdog();
  const started = safeSync("watchdog:start", () => startRealtimeWatchdog(options));
  state.realtimeWatchdog = started.data || null;
}

function stopRealtimeWatchdog() {
  if (!state.realtimeWatchdog) return;
  try {
    state.realtimeWatchdog.stop();
  } catch {
    /* تجاهل */
  }
  state.realtimeWatchdog = null;
}

/**
 * مؤقت مزامنة يعمل في الخلفية: كل دقيقتين (بقدر ما يسمح المتصفح) نتحقق من
 * العدّادات. الغرض: إن مُنع الإشعار لأي سبب (حظر نظام، محسّن بطارية، إشعار
 * صامت) يبقى العدّاد صحيحاً عند العودة للتطبيق.
 */
function scheduleHiddenCatchUp() {
  stopHiddenCatchUp();
  state.hiddenCatchUpTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      stopHiddenCatchUp();
      return;
    }
    if (!state.me || !state.isOnline || isCallActive()) return;
    runCatchUpSync("hidden", { light: true });
  }, 120000);
}

function stopHiddenCatchUp() {
  if (state.hiddenCatchUpTimer) {
    clearInterval(state.hiddenCatchUpTimer);
    state.hiddenCatchUpTimer = null;
  }
}

/**
 * مزامنة "ما فات" بعد العودة من الخلفية: الرسائل + العدّادات + الإشعارات.
 * @param {string} reason
 * @param {{force?:boolean, light?:boolean}} options
 */
async function runCatchUpSync(reason = "resume", { force = false, light = false } = {}) {
  if (!state.me || !state.isOnline) return;

  const now = Date.now();
  if (!force && now - state.lastCatchUpAt < 1500) return;
  state.lastCatchUpAt = now;

  await safeAsync(`catchup:${reason}`, async () => {
    await flushPendingReads();
    // علّم كل ما وصل إلينا فعلاً كـ"مُسلَّم" (✓✓ رمادي عند المرسل)
    await sweepDeliveredMessages();

    // تحقّق من تحديثات Service Worker (بما فيها worker الإشعارات) — مرة/ساعة
    refreshServiceWorker();

    // بعد الخلفية قد يكون التوكن قد دُوِّر أو حُذف من قاعدة البيانات —
    // نُزامنه بصمت (بحد أدنى 30 دقيقة بين المزامنات الفعلية).
    safeAsync("catchup:push-token", () => syncPushToken({ userId: state.me?.id }));

    if (light) {
      // في الخلفية نكتفي بالعدّادات (استعلام واحد خفيف)
      await refreshUnreadBadges();
      return;
    }

    if (state.activeConversation) {
      const id = state.activeConversation.id;
      await loadMessages(id, { silent: true });
      // ما وصل أثناء الانقطاع يُثبَّت كـ"مُسلَّم"، والقراءة فقط إن كانت الشاشة مرئية
      await markMessagesDelivered(id, { force: true });
      if (document.visibilityState === "visible") {
        await markConversationRead(id, { force: true });
      }
    }

    await loadContacts();
    refreshMissedCallsBadge();
  });
}

/** نبضة keepalive عند إغلاق الصفحة — تُبقي "آخر ظهور" صحيحاً */
function updatePresenceOfflineBeacon() {
  try {
    // المشرف لا يُعلَن "غير متصل" أبداً
    if (state.me?.is_admin) return;

    const session = JSON.parse(localStorage.getItem("wa_browser_session") || "null");
    const token = session?.access_token;
    if (!token || !state.me?.id) return;

    const url = `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(state.me.id)}`;
    fetch(url, {
      method: "PATCH",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ is_online: false, last_seen: new Date().toISOString() }),
    }).catch(() => {});
  } catch {
    /* تجاهل — لا يمكن فعل أكثر من ذلك أثناء الخروج */
  }
}

function applyAuthRole(role) {
  state.authRole = role === "admin" ? "admin" : "user";
  localStorage.setItem("wa_auth_role", state.authRole);
  const isAdmin = state.authRole === "admin";
  const t = state.t || {};

  $("#role-user")?.classList.toggle("active", !isAdmin);
  $("#role-admin")?.classList.toggle("active", isAdmin);

  // الدخول: هاتف للمستخدم، بريد للمشرف
  const loginId = $("#login-identity");
  if (loginId) {
    loginId.type = isAdmin ? "email" : "tel";
    loginId.inputMode = isAdmin ? "email" : "tel";
    loginId.placeholder = isAdmin ? (t.email || "البريد الإلكتروني") : (t.login_phone || "رقم الهاتف");
    loginId.autocomplete = isAdmin ? "email" : "tel";
  }
  const loginHint = $("#login-hint");
  if (loginHint) {
    loginHint.textContent = isAdmin
      ? (t.login_hint_admin || "الدخول بالبريد الإلكتروني للمشرفين المعتمدين فقط")
      : (t.login_hint_user || "الدخول برقم الهاتف للمستخدمين — المشرفون يدخلون بالبريد الإلكتروني");
  }

  // التسجيل: البريد يظهر للمشرف فقط، والهاتف إلزامي للمستخدم
  const email = $("#signup-email");
  const phone = $("#signup-phone");
  if (email) {
    email.classList.toggle("hidden", !isAdmin);
    email.required = isAdmin;
    if (!isAdmin) email.value = "";
  }
  if (phone) {
    phone.required = !isAdmin;
    phone.placeholder = isAdmin ? "رقم الهاتف (اختياري)" : (t.phone || "رقم الهاتف");
  }
  const signupHint = $("#signup-hint");
  if (signupHint) {
    signupHint.textContent = isAdmin
      ? (t.signup_hint_admin || "إنشاء حساب مشرف يتطلب بريداً معتمداً في قائمة المشرفين")
      : (t.signup_hint_user || "التسجيل باسم المستخدم ورقم الهاتف فقط — لا حاجة لبريد إلكتروني");
  }
}

function setAuthBusy(form, busy) {
  const btn = form?.querySelector('button[type="submit"]');
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = "...";
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

function wireAuthForms() {
  $("#tab-login")?.addEventListener("click", () => {
    switchAuthTab("login");
  });

  $("#tab-signup")?.addEventListener("click", () => {
    switchAuthTab("signup");
  });

  $("#role-user")?.addEventListener("click", () => applyAuthRole("user"));
  $("#role-admin")?.addEventListener("click", () => applyAuthRole("admin"));
  applyAuthRole(state.authRole);

  // إن كتب المستخدم "@" في حقل الدخول فهو مشرف — بدّل الوضع تلقائياً
  $("#login-identity")?.addEventListener("input", (e) => {
    const v = e.target.value || "";
    if (looksLikeEmail(v) && state.authRole !== "admin") applyAuthRole("admin");
  });

  $("#login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;

    const identity = $("#login-identity").value.trim();
    const password = $("#login-password").value;

    if (state.authRole === "admin" && !looksLikeEmail(identity)) {
      showAuthError("أدخل البريد الإلكتروني للمشرف.");
      return;
    }
    if (state.authRole === "user" && looksLikeEmail(identity)) {
      applyAuthRole("admin");
    }

    setAuthBusy(form, true);
    try {
      await signIn({ identity, password });
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    } finally {
      setAuthBusy(form, false);
    }
  });

  $("#signup-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;

    const isAdmin = state.authRole === "admin";
    const email = isAdmin ? $("#signup-email").value.trim() : "";
    const password = $("#signup-password").value;
    const displayName = $("#signup-name").value.trim();
    const phone = $("#signup-phone").value.trim();

    if (!displayName) {
      showAuthError("اسم المستخدم مطلوب.");
      return;
    }
    if (isAdmin && !email) {
      showAuthError("بريد المشرف مطلوب لإنشاء حساب مشرف.");
      return;
    }
    if (!isAdmin && !phone) {
      showAuthError("رقم الهاتف مطلوب لإنشاء الحساب.");
      return;
    }

    setAuthBusy(form, true);
    try {
      const result = await signUp({ email, password, displayName, phone });

      if (!result?.session) {
        // تأكيد البريد مفعّل في Supabase (للمشرفين) — لا يمكن الدخول قبل التأكيد
        if (isAdmin) {
          showAuthError("تم إنشاء الحساب — تحقق من بريدك لتأكيده ثم سجّل الدخول.");
          switchAuthTab("login");
          return;
        }
      }

      await signIn({ identity: isAdmin ? email : phone, password });
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    } finally {
      setAuthBusy(form, false);
    }
  });
}

function switchAuthTab(which) {
  $("#tab-login")?.classList.toggle("active", which === "login");
  $("#tab-signup")?.classList.toggle("active", which === "signup");

  $("#login-form")?.classList.toggle("hidden", which !== "login");
  $("#signup-form")?.classList.toggle("hidden", which !== "signup");
}

function showAuthError(msg) {
  const text =
    msg ||
    state.t?.error_generic ||
    "حدث خطأ ما";

  const authScreenVisible =
    !$("#auth-screen")?.classList.contains("hidden");

  if (authScreenVisible) {
    const el = $("#auth-error");

    if (el) {
      el.textContent = text;
      el.classList.remove("hidden");

      setTimeout(() => {
        el.classList.add("hidden");
      }, 4000);
    }
  } else {
    const toast = $("#global-toast");

    if (!toast) return;

    toast.textContent = text;
    toast.classList.remove("hidden");

    clearTimeout(toast._hideTimeout);

    toast._hideTimeout = setTimeout(() => {
      toast.classList.add("hidden");
    }, 5000);
  }
}

function wireChrome() {
  $("#btn-settings")?.addEventListener("click", () => {
    $("#settings-panel")?.classList.toggle("hidden");
  });

  $("#btn-logout")?.addEventListener("click", async () => {
    await signOut(state.me?.id);
    location.reload();
  });

  $("#lang-toggle")?.addEventListener("click", toggleLanguage);
  $("#theme-toggle")?.addEventListener("click", toggleTheme);

  $("#auth-lang-toggle")?.addEventListener(
    "click",
    toggleLanguage
  );

  $("#auth-theme-toggle")?.addEventListener(
    "click",
    toggleTheme
  );

  $("#avatar-input")?.addEventListener(
    "change",
    handleAvatarUpload
  );

  $("#wallpaper-input")?.addEventListener(
    "change",
    handleWallpaperUpload
  );

  $("#btn-enable-push")?.addEventListener(
    "click",
    async () => {
      if (!state.me) return;

      const ok = await enablePushNotifications(
        state.me.id
      );

      if (ok) {
        localStorage.setItem("wa_fcm_last_refresh", String(Date.now()));
        showAuthError("تم تفعيل الإشعارات ✅");
        $("#settings-panel")?.classList.add("hidden");
        openBackgroundHelp();
      } else if ("Notification" in window && Notification.permission === "denied") {
        showAuthError("الإذن مرفوض من المتصفح — فعّله من إعدادات الموقع 🔒 ثم أعد المحاولة.");
        openBackgroundHelp();
      } else {
        showAuthError("تعذّر التفعيل — تحقق من الاتصال وإذن المتصفح ثم أعد المحاولة.");
      }
    }
  );

  $("#btn-test-push")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!state.me) return;
    btn.disabled = true;
    const out = $("#push-diag");
    const lines = [];
    const log = (ok, msg) => {
      lines.push(`${ok === null ? "•" : ok ? "✅" : "❌"} ${msg}`);
      if (out) {
        out.textContent = lines.join("\n");
        out.classList.remove("hidden");
      }
    };
    try {
      log(null, "فحص سلسلة الإشعارات…");
      const secure = window.isSecureContext;
      log(secure, secure ? "اتصال آمن (HTTPS)" : "الموقع ليس HTTPS — الإشعارات لن تعمل");
      const perm = "Notification" in window ? Notification.permission : "unsupported";
      log(perm === "granted", `إذن الإشعارات: ${perm}`);
      if (perm !== "granted") {
        log(null, "اضغط «تفعيل إشعارات الجهاز» أولاً ووافق على الإذن.");
        return;
      }
      const reg = await navigator.serviceWorker?.getRegistration("./firebase-cloud-messaging-push-scope");
      log(!!reg?.active, reg?.active ? "Service Worker الخاص بالإشعارات نشط" : "Service Worker الخاص بالإشعارات غير مسجّل");

      // حالة توكن FCM ومزامنته (سبب شائع لتوقّف إشعارات الخلفية)
      const tokenSyncedAt = getLastTokenSyncAt();
      const syncedMinutes = tokenSyncedAt ? Math.round((Date.now() - tokenSyncedAt) / 60000) : null;
      log(isPushReady(), syncedMinutes === null
        ? "لم تُسجَّل مزامنة توكن مع السيرفر بعد"
        : `آخر مزامنة توكن مع السيرفر قبل ${syncedMinutes} دقيقة`);

      // حالة اتصال Realtime وقنواته (تكشف "الموت الصامت" في الخلفية)
      const rt = diagnoseRealtime(supabase);
      log(rt.healthy, `Realtime: ${rt.connection}${rt.channels.length ? ` — ${rt.channels.length} قناة` : ""}`);
      if (rt.unhealthy.length) {
        log(false, "قنوات متوقفة: " + rt.unhealthy.map((c) => `${c.topic}(${c.state})`).join(", "));
      }
      // إشعار محلي فوري — يثبت أن النظام يعرض الإشعارات أصلاً (بدون سيرفر)
      try {
        await (reg || (await navigator.serviceWorker.ready)).showNotification("🔔 اختبار محلي", {
          body: "إن رأيت هذا الإشعار فالجهاز يسمح بعرض الإشعارات.",
          icon: "./icons/icon.png",
          tag: "local-test",
        });
        log(true, "أُرسل إشعار محلي (يجب أن يظهر الآن)");
      } catch (err) {
        log(false, "فشل الإشعار المحلي: " + (err?.message || err));
      }
      if (!localStorage.getItem("fcm_token")) {
        log(null, "لا يوجد توكن FCM — جارٍ التفعيل…");
        await enablePushNotifications(state.me.id);
      }
      const token = localStorage.getItem("fcm_token");
      log(!!token, token ? `توكن FCM موجود (…${token.slice(-8)})` : "تعذّر الحصول على توكن FCM");
      if (!token) return;
      try {
        const { data: diag, error: diagErr } = await supabase.rpc("push_diagnostics");
        if (diagErr) {
          log(false, "دالة push_diagnostics غير موجودة — نفّذ migration v2.2 في Supabase");
        } else {
          log(!!diag.pg_net_installed, "امتداد pg_net " + (diag.pg_net_installed ? "مفعّل" : "غير مفعّل"));
          log(!!diag.vault_url_set && !!diag.vault_secret_set, "أسرار Vault (SEND_PUSH_URL/SEND_PUSH_SECRET) " + (diag.vault_url_set && diag.vault_secret_set ? "مضبوطة" : "ناقصة"));
          log(!!diag.trigger_messages, "Trigger الرسائل " + (diag.trigger_messages ? "موجود" : "مفقود"));
          log(Number(diag.my_tokens) > 0, `توكنات هذا الحساب في قاعدة البيانات: ${diag.my_tokens}`);
          const last = (diag.last_log || [])[0];
          if (last?.note) log(false, "آخر محاولة إرسال من الـ Trigger: " + last.note);
          else if (last?.status_code && last.status_code !== 200) log(false, `آخر رد لـ send-push على الـ Trigger: HTTP ${last.status_code} ${last.response || ""}`);
          else if (last?.status_code === 200) log(true, "آخر استدعاء للـ Trigger نجح (200)");
        }
      } catch {
        /* تجاهل */
      }
      log(null, "١) المسار المباشر: التطبيق → send-push → FCM…");
      const r = await sendTestNotification();
      log(r.sent > 0, `السيرفر أرسل إلى ${r.sent}/${r.total} جهاز عبر FCM`);
      const failed = (r.results || []).filter((x) => !x.ok);
      if (r.sent > 0 && failed.length) log(null, `حُذف ${failed.length} توكن قديم/ميت تلقائياً`);
      if (r.sent === 0 && failed.length) {
        const e = failed[0].error || "";
        if (/SENDER_ID_MISMATCH|mismatched/i.test(e)) {
          log(false, "FCM: SENDER_ID_MISMATCH — مفتاح VAPID أو appId في push.js لا يخص مشروع Firebase الذي يملك Service Account في send-push");
        } else if (/INVALID_ARGUMENT|not a valid FCM/i.test(e)) {
          log(false, "FCM: التوكن غير صالح — غالباً مفتاح VAPID (Web Push certificate) لا يطابق مشروع Firebase؛ انسخه من Cloud Messaging → Web configuration");
        } else if (/UNREGISTERED/i.test(e)) {
          log(false, "FCM: التوكن ملغى — اضغط «تفعيل إشعارات الجهاز» لإصدار توكن جديد ثم أعد الاختبار");
        } else {
          log(false, `FCM: ${e.slice(0, 200)}`);
        }
      }

      log(null, "٢) مسار الخلفية: قاعدة البيانات → pg_net → send-push (نفس مسار الرسائل الحقيقية)…");
      try {
        const { data: probe, error: probeErr } = await supabase.rpc("push_probe");
        if (probeErr) {
          log(false, "دالة push_probe غير موجودة — نفّذ migration v2.3");
        } else if (!probe?.request_id) {
          log(false, "الـ Trigger لم يستطع استدعاء pg_net — راجع SEND_PUSH_URL/SECRET في Vault");
        } else {
          let res = null;
          for (let i = 0; i < 8; i += 1) {
            await new Promise((ok) => setTimeout(ok, 1200));
            const { data } = await supabase.rpc("push_probe_result", { p_request_id: probe.request_id });
            if (data && !data.pending) {
              res = data;
              break;
            }
          }
          if (!res) {
            log(false, "لم يصل رد من send-push خلال 10 ثوانٍ (timeout) — تحقق أن الرابط في Vault صحيح");
          } else if (res.status_code === 200) {
            log(true, `قاعدة البيانات وصلت إلى send-push بنجاح (200): ${res.response || ""}`);
          } else if (res.status_code === 401 && /NO_AUTH_HEADER|Missing authorization|INVALID_JWT_FORMAT|Bearer/i.test(res.response || "")) {
            log(false, "401 من بوابة Supabase (وليس من الدالة): انشر الدالة بـ --no-verify-jwt ونفّذ migration v2.4 (يضيف ترويسة Authorization)");
          } else if (res.status_code === 401) {
            log(false, "401 من send-push: قيمة SEND_PUSH_SECRET في Vault لا تطابق سر الدالة — وحّدهما ثم أعد النشر");
          } else if (res.status_code === 404) {
            log(false, "404: SEND_PUSH_URL في Vault خاطئ — يجب أن يكون https://<ref>.supabase.co/functions/v1/send-push");
          } else {
            log(false, `رد غير متوقع من send-push: ${res.status_code || res.error} ${res.response || ""}`);
          }
        }
      } catch (err) {
        log(false, "فشل المسبار: " + (err?.message || err));
      }
      log(null, "أغلق التطبيق الآن — يجب أن يصلك إشعاران تجريبيان.");
    } catch (err) {
      const m = err?.message || String(err);
      if (/404|not found/i.test(m)) {
        log(false, "دالة send-push غير منشورة على Supabase (404). نفّذ: supabase functions deploy send-push --no-verify-jwt");
      } else if (/401/.test(m)) {
        log(false, "الدالة ترفض الطلب (401): انشرها بخيار --no-verify-jwt أو عبر supabase/config.toml");
      } else {
        log(false, "فشل: " + m);
      }
    } finally {
      btn.disabled = false;
    }
  });

  $("#btn-call-history")?.addEventListener("click", () => openCallHistory());
  $("#close-call-history")?.addEventListener("click", closeCallHistory);
  $("#call-history-modal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeCallHistory();
  });
  $("#btn-background-help")?.addEventListener("click", () => {
    $("#settings-panel")?.classList.add("hidden");
    openBackgroundHelp();
  });
  wireBackgroundHelp();

  // حذف الصورة الشخصية / خلفية الدردشة (كانت الأزرار موجودة بلا ربط)
  $("#btn-remove-avatar")?.addEventListener(
    "click",
    guard("settings:remove-avatar", () => removeProfileMedia("avatar_url"))
  );

  $("#btn-remove-wallpaper")?.addEventListener(
    "click",
    guard("settings:remove-wallpaper", () => removeProfileMedia("wallpaper_url"))
  );

  // بحث فوري في قائمة جهات الاتصال (كان الحقل بلا ربط)
  $(".search-box input")?.addEventListener(
    "input",
    guard("sidebar:search", (e) => filterContactList(e.target.value))
  );

  // أغلق لوحة الإعدادات عند النقر خارجها
  document.addEventListener("click", (e) => {
    const panel = $("#settings-panel");
    if (!panel || panel.classList.contains("hidden")) return;
    if (e.target.closest("#settings-panel") || e.target.closest("#btn-settings")) return;
    panel.classList.add("hidden");
  });

  wireChatPanel();
  wireEmojiPicker();
}

function closeCallHistory() {
  $("#call-history-modal")?.classList.add("hidden");
}

const CALL_HISTORY_SEEN_KEY = "wa_calls_seen_at";

function callStatusMeta(call, myId) {
  const outgoing = call.caller_id === myId;
  const isVideo = call.call_type === "video";
  const duration = Number(call.duration_seconds || 0);
  const answered = Boolean(call.answered_at) || duration > 0;
  let kind = "completed";
  let label;
  if (call.status === "missed" || (!answered && call.status !== "declined" && call.status !== "active" && call.status !== "ringing")) {
    kind = outgoing ? "unanswered" : "missed";
    label = outgoing ? "لم يتم الرد" : "مكالمة فائتة";
  } else if (call.status === "declined") {
    kind = outgoing ? "unanswered" : "declined";
    label = outgoing ? "مرفوضة" : "تم الرفض";
  } else if (call.status === "active" || call.status === "ringing") {
    kind = "active";
    label = "جارية";
  } else {
    label = isVideo ? "مكالمة فيديو" : "مكالمة صوتية";
  }
  return { outgoing, isVideo, duration, answered, kind, label, missed: kind === "missed" };
}

function formatCallDuration(secs) {
  const s = Number(secs || 0);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatCallDay(date) {
  const d = new Date(date);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return state.lang === "ar" ? "اليوم" : "Today";
  if (same(d, yesterday)) return state.lang === "ar" ? "أمس" : "Yesterday";
  return d.toLocaleDateString(state.lang === "ar" ? "ar-SA" : "en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function formatCallTime(date) {
  return new Date(date).toLocaleTimeString(state.lang === "ar" ? "ar-SA" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** شارة المكالمات الفائتة غير المشاهدة فوق أيقونة السجل */
async function refreshMissedCallsBadge() {
  if (!state.me || !state.isOnline) return;
  const seenAt = localStorage.getItem(CALL_HISTORY_SEEN_KEY) || "1970-01-01T00:00:00Z";
  const { ok, data } = await safeQuery("calls:missed-count", () =>
    supabase
      .from("call_rooms")
      .select("id", { count: "exact", head: false })
      .eq("callee_id", state.me.id)
      .eq("status", "missed")
      .gt("created_at", seenAt)
      .limit(99)
  );
  safeDom("calls:badge", () => {
    const badge = $("#call-history-badge");
    if (!badge) return;
    const n = ok && Array.isArray(data) ? data.length : 0;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.toggle("hidden", n === 0);
  });
}

/** يراقب تغيّرات غرف المكالمات لتحديث الشارة والمحادثة المفتوحة فوراً */
function subscribeCallRoomsWatch() {
  if (!state.me) return;

  teardownChannel("callsChannel");

  state.callsChannel = createResilientChannel(supabase, {
    topic: "call-rooms-watch",
    label: "call-rooms",
    handlers: [
      {
        type: "postgres_changes",
        filter: { event: "*", schema: "public", table: "call_rooms" },
        callback: (payload) => {
          const row = payload.new || payload.old;
          if (!row || !state.me) return;
          if (row.caller_id !== state.me.id && row.callee_id !== state.me.id) return;
          refreshMissedCallsBadge();
          const modal = $("#call-history-modal");
          if (modal && !modal.classList.contains("hidden")) {
            openCallHistory(state.callHistoryFilter, { silent: true });
          }
        },
      },
    ],
    onStatus: (status) => {
      if (status === "SUBSCRIBED") refreshMissedCallsBadge();
    },
  });
}

async function openCallHistory(filter = state.callHistoryFilter || "all", { silent = false } = {}) {
  if (!state.me) return;
  state.callHistoryFilter = filter;
  const modal = $("#call-history-modal");
  const list = $("#call-history-list");
  modal?.classList.remove("hidden");
  if (!list) return;

  // شريط التبويبات (الكل / الفائتة)
  let tabs = modal.querySelector(".call-history-tabs");
  if (!tabs) {
    tabs = document.createElement("div");
    tabs.className = "call-history-tabs";
    tabs.innerHTML = `
      <button type="button" data-filter="all">الكل</button>
      <button type="button" data-filter="missed">الفائتة</button>`;
    modal.querySelector(".modal-header")?.insertAdjacentElement("afterend", tabs);
    tabs.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => openCallHistory(b.dataset.filter))
    );
  }
  tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.filter === filter));

  if (!silent) list.innerHTML = '<div class="call-history-loading">جارٍ تحميل سجل المكالمات...</div>';

  if (!state.isOnline) {
    list.innerHTML = '<div class="call-history-empty">لا يمكن تحميل سجل المكالمات دون اتصال.</div>';
    return;
  }

  const [{ data, error }, { data: hiddenRows, error: hiddenError }] = await Promise.all([
    supabase
      .from("call_rooms")
      .select(
        "id,conversation_id,call_type,caller_id,callee_id,status,started_at,answered_at,ended_at,duration_seconds,created_at, caller:profiles!call_rooms_caller_id_fkey(id,display_name,avatar_url), callee:profiles!call_rooms_callee_id_fkey(id,display_name,avatar_url)"
      )
      .or(`caller_id.eq.${state.me.id},callee_id.eq.${state.me.id}`)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("call_history_hidden").select("room_id").eq("user_id", state.me.id),
  ]);

  if (error) {
    list.innerHTML = '<div class="call-history-empty">تعذّر تحميل سجل المكالمات.</div>';
    return;
  }
  if (hiddenError) console.warn("call_history_hidden:", hiddenError);

  const hiddenIds = new Set((hiddenRows || []).map((row) => row.room_id));
  let calls = (data || []).filter((call) => !hiddenIds.has(call.id));
  const metaById = new Map(calls.map((c) => [c.id, callStatusMeta(c, state.me.id)]));
  if (filter === "missed") calls = calls.filter((c) => metaById.get(c.id)?.missed);

  // اعتبر الفائتة مُشاهدة الآن
  localStorage.setItem(CALL_HISTORY_SEEN_KEY, new Date().toISOString());
  refreshMissedCallsBadge();

  if (!calls.length) {
    list.innerHTML = `<div class="call-history-empty">${state.t?.no_calls || "لا توجد مكالمات بعد."}</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  let lastDay = null;
  calls.forEach((call) => {
    const meta = metaById.get(call.id);
    const peer = meta.outgoing ? call.callee : call.caller;
    const day = formatCallDay(call.created_at);
    if (day !== lastDay) {
      const h = document.createElement("div");
      h.className = "call-history-day";
      h.textContent = day;
      fragment.appendChild(h);
      lastDay = day;
    }
    const row = document.createElement("div");
    row.className = `call-history-row ${meta.kind}`;
    row.dataset.callRow = call.id;
    const dirIcon = meta.missed ? "↙" : meta.outgoing ? "↗" : "↙";
    const dirClass = meta.missed ? "missed" : meta.outgoing ? "out" : "in";
    const durationLabel = meta.duration ? ` · ${formatCallDuration(meta.duration)}` : "";
    const fullDate = new Date(call.created_at).toLocaleString(state.lang === "ar" ? "ar-SA" : "en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    row.innerHTML = `
      <div class="call-history-avatar">${
        peer?.avatar_url ? `<img src="${escapeHtml(peer.avatar_url)}" alt="">` : escapeHtml((peer?.display_name || "?").trim().charAt(0))
      }</div>
      <div class="call-history-main">
        <strong>${escapeHtml(peer?.display_name || "مستخدم")}</strong>
        <span><b class="call-card-dir ${dirClass}">${dirIcon}</b>${meta.isVideo ? "🎥" : "📞"} ${escapeHtml(meta.label)}${durationLabel}</span>
      </div>
      <time datetime="${escapeHtml(call.created_at)}" title="${escapeHtml(fullDate)}">${escapeHtml(formatCallTime(call.created_at))}<br><small>${escapeHtml(
        new Date(call.created_at).toLocaleDateString(state.lang === "ar" ? "ar-SA" : "en-US", { day: "2-digit", month: "2-digit", year: "numeric" })
      )}</small></time>
      <div class="call-history-actions">
        <button type="button" data-call-back="${escapeHtml(call.id)}" title="معاودة الاتصال" aria-label="معاودة الاتصال">${meta.isVideo ? "🎥" : "📞"}</button>
        <button type="button" class="call-history-delete" data-call-delete="${escapeHtml(call.id)}" title="حذف من سجلي" aria-label="حذف المكالمة">🗑️</button>
      </div>`;

    row.querySelector("[data-call-back]")?.addEventListener("click", async () => {
      if (!peer?.id) return;
      closeCallHistory();
      await startCallWith(peer, call.conversation_id, call.call_type);
    });

    row.querySelector("[data-call-delete]")?.addEventListener("click", async (ev) => {
      const button = ev.currentTarget;
      if (!window.confirm("حذف هذه المكالمة من سجلك؟")) return;
      button.disabled = true;
      const { error: deleteError } = await supabase
        .from("call_history_hidden")
        .insert({ user_id: state.me.id, room_id: call.id });
      if (deleteError && deleteError.code !== "23505") {
        button.disabled = false;
        showAuthError("تعذّر حذف المكالمة من السجل.");
        return;
      }
      row.remove();
      if (!list.querySelector("[data-call-row]")) {
        list.innerHTML = `<div class="call-history-empty">${state.t?.no_calls || "لا توجد مكالمات بعد."}</div>`;
      }
    });

    fragment.appendChild(row);
  });

  list.innerHTML = "";
  list.appendChild(fragment);
}

/**
 * فتح محادثة بالمعرّف (من نقر إشعار أو من رابط).
 *
 * يتعامل مع كل الحالات التي كانت تُسقط النقرة بصمت سابقاً:
 *   • التطبيق لم يكتمل تحميله بعد (لا `state.me`) → إعادة محاولة قصيرة.
 *   • استعلام فاشل (شبكة/RLS) → إعادة محاولة بتراجع تدريجي.
 *   • المحادثة غير موجودة/غير مسموحة → تنبيه واضح بدل الصمت.
 *   • المحادثة مفتوحة بالفعل → تمرير مباشر للرسالة + تصفير العدّاد.
 */
async function openConversationById(conversationId, { messageId = null, attempt = 0 } = {}) {
  if (!conversationId) return false;

  if (!state.me) {
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return openConversationById(conversationId, { messageId, attempt: attempt + 1 });
    }
    return false;
  }

  if (state.activeConversation?.id === conversationId) {
    resetUnreadFor(conversationId);
    await markConversationRead(conversationId);
    if (messageId) await scrollToMessage(messageId);
    return true;
  }

  const { ok, data } = await safeQuery("deeplink:conversation", () =>
    supabase
      .from("conversations")
      .select("id,user_id,admin_id")
      .eq("id", conversationId)
      .maybeSingle()
  );

  if (ok && !data) {
    showAuthError("تعذّر فتح المحادثة — قد تكون حُذفت أو لا تملك صلاحية الوصول إليها.");
    return false;
  }

  if (!ok) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      return openConversationById(conversationId, { messageId, attempt: attempt + 1 });
    }
    showAuthError("تعذّر فتح المحادثة من الإشعار — تحقق من الاتصال.");
    return false;
  }

  const otherId = data.user_id === state.me.id ? data.admin_id : data.user_id;

  // الاسم/الصورة من القائمة المحلية إن وُجدت، وإلا من الشبكة
  let peer = state.contacts.find((c) => c.id === otherId) || null;

  if (!peer) {
    const { data: profile } = await safeQuery("deeplink:profile", () =>
      supabase.from("profiles").select("*").eq("id", otherId).maybeSingle()
    );
    peer = profile || null;
  }

  if (!peer) {
    showAuthError("تعذّر تحميل بيانات المحادثة.");
    return false;
  }

  await openConversation({ ...peer, _conversationId: data.id }, { messageId });
  return true;
}

/** يوجّه أي هدف قادم من الإشعار (رسالة/مكالمة) إلى الواجهة الصحيحة */
async function openRouteFromNotification(route) {
  if (!route) return;

  // مكالمة واردة: قناة الإشارات هي المسار الأساسي للرنين، وهذا المسار يضمن
  // أن واجهة المكالمة تُفتح حتى لو كان التطبيق مُغلقاً تماماً.
  if (route.action === "answer" && route.roomId) {
    const handled = await safeAsync("route:call", () =>
      openCallFromNotification(route.roomId, route.conversationId)
    );
    if (handled.data) return;
  }

  if (!route.conversationId) return;

  closeConversationNotifications(route.conversationId);
  resetUnreadFor(route.conversationId);

  await openConversationById(route.conversationId, { messageId: route.messageId });
}

/** يحاول فتح/استئناف واجهة مكالمة واردة من إشعار */
async function openCallFromNotification(roomId, conversationId) {
  const { ok, data } = await safeQuery("route:call-room", () =>
    supabase
      .from("call_rooms")
      .select("id,status,conversation_id,caller_id,callee_id")
      .eq("id", roomId)
      .maybeSingle()
  );

  if (!ok || !data) return false;
  if (!["ringing", "active"].includes(data.status)) return false;

  if (conversationId && state.activeConversation?.id !== conversationId) {
    await openConversationById(conversationId);
  }
  return true;
}

/**
 * مستمع نقرات الإشعارات. المنطق الفعلي انتقل إلى js/notification-router.js
 * (يلتقط الهدف حتى قبل جهوزية التطبيق)، وهذه الدالة تفرّغ أي هدف معلّق.
 */
function handleDeepLinks() {
  if (peekPendingRoute()) flushPendingRoutes();
}

/**
 * هل هذا الطرف مشرف؟ يُستخدم لتثبيت حالة "متصل الآن" وإظهارها دائماً.
 *
 * الشرط يشمل أكثر من مسار حتى لا تعتمد النتيجة على اكتمال حقل واحد:
 *   • البريد مطابق لقائمة المشرفين الثابتة في js/config.js (ADMINS)
 *   • أو حقل is_admin / is_super_admin في الملف الشخصي
 *   • أو بيانات المحادثة القائمة (نفس الحقول)
 */
function isAdminContact(id, profile = null) {
  const candidate = profile || state.contacts?.find((c) => c.id === id) || null;
  const email = String(candidate?.email || "").toLowerCase().trim();

  if (email && ADMINS.some((a) => String(a.email).toLowerCase() === email)) return true;
  if (candidate?.is_admin || candidate?.is_super_admin) return true;

  const known = state.contacts?.find((c) => c.id === id);
  if (known?.is_admin || known?.is_super_admin) return true;
  if (!candidate && !known && !id) return false;

  // المشرفون في هذا التطبيق هم أصحاب الحسابات المعلَّمة في قاعدة البيانات؛
  // إن غاب الحقل تماماً نعتبره مشرفاً إن كان ضمن قسم المشرفين المعروض.
  if (candidate && (candidate._isAdminSection || candidate._adminSection)) return true;
  if (id && state.adminContacts?.some?.((c) => c.id === id)) return true;

  return false;
}

/**
 * تثبيت حضور المشرفين في خريطة الحضور الحالية.
 * يُستدعى قبل كل رسم/مزامنة حتى لا تُسقط أي مزامنة (تحديث دوري، عودة من
 * الخلفية، إعادة اتصال) حالة "متصل الآن" التي يراها المستخدم العادي.
 */
function noteAdminPresenceOnline() {
  (state.contacts || []).forEach((c) => {
    if (c?.id && isAdminContact(c.id, c)) state.onlineMap[c.id] = true;
  });
  if (state.activeConversation?.otherProfile) {
    const peer = state.activeConversation.otherProfile;
    if (peer?.id && isAdminContact(peer.id, peer)) state.onlineMap[peer.id] = true;
  }
}

/** يحذف الصورة الشخصية أو خلفية الدردشة من الملف الشخصي */
async function removeProfileMedia(field) {
  if (!state.me) return;

  const label = field === "avatar_url" ? "الصورة الشخصية" : "خلفية الدردشة";

  const { ok } = await safeQuery("profile:remove-media", () =>
    supabase.from("profiles").update({ [field]: null }).eq("id", state.me.id)
  );

  if (!ok) {
    showAuthError(`تعذّر حذف ${label} — حاول مرة أخرى.`);
    return;
  }

  state.me[field] = null;

  safeDom("profile:remove-media-ui", () => {
    if (field === "avatar_url") {
      const img = $("#my-avatar");
      if (img) img.src = "";
    } else {
      const box = $("#chat-messages");
      if (box) box.style.backgroundImage = "";
    }
  });

  showAuthError(`تم حذف ${label} ✅`);
}

/** تصفية قائمة المحادثات حسب نص البحث */
function filterContactList(rawQuery) {
  const query = (rawQuery || "").trim().toLowerCase();

  safeDom("sidebar:filter", () => {
    let visible = 0;

    document.querySelectorAll("#contact-list-wrap .contact-row").forEach((row) => {
      const name = (row.querySelector(".contact-name")?.textContent || "").toLowerCase();
      const sub = (row.querySelector(".contact-sub")?.textContent || "").toLowerCase();
      const match = !query || name.includes(query) || sub.includes(query);

      row.classList.toggle("hidden", !match);
      if (match) visible += 1;
    });

    // أخفِ العناوين الفارغة أثناء البحث
    ["#admins-section", "#users-section"].forEach((sel, idx) => {
      const section = $(sel);
      const heading = $(idx === 0 ? "#admins-heading" : "#users-heading");
      if (!section || !heading || heading.dataset.forceHidden === "1") return;

      const hasVisible = Boolean(
        section.querySelector(".contact-row:not(.hidden)")
      );
      heading.classList.toggle("hidden", query ? !hasVisible : false);
    });

    let emptyEl = $("#contact-search-empty");

    if (!visible && query) {
      if (!emptyEl) {
        emptyEl = document.createElement("div");
        emptyEl.id = "contact-search-empty";
        emptyEl.className = "contact-search-empty";
        $("#contact-list-wrap")?.appendChild(emptyEl);
      }
      emptyEl.textContent = "لا توجد نتائج مطابقة";
      emptyEl.classList.remove("hidden");
    } else if (emptyEl) {
      emptyEl.classList.add("hidden");
    }
  });
}

function toggleLanguage() {
  state.lang =
    state.lang === "ar"
      ? "en"
      : "ar";

  localStorage.setItem(
    "wa_lang",
    state.lang
  );

  state.t = applyLanguage(state.lang);
}

function toggleTheme() {
  state.theme =
    state.theme === "dark"
      ? "light"
      : "dark";

  localStorage.setItem(
    "wa_theme",
    state.theme
  );

  document.body.setAttribute(
    "data-theme",
    state.theme
  );

  applyThemeVars();
}

function wireChatPanel() {
  $("#composer-form")?.addEventListener(
    "submit",
    async (e) => {
      e.preventDefault();

      if (state.mediaUploading) {
        return;
      }

      const input = $("#composer-input");

      const text =
        input.value.trim();

      if (!text) return;

      input.value = "";

      await sendMessage({
        content: text,
      });
    }
  );

  $("#composer-input")?.addEventListener(
    "input",
    handleTypingInput
  );

  $("#attach-input")?.addEventListener(
    "change",
    handleAttachmentUpload
  );

  $("#reply-preview-cancel")?.addEventListener(
    "click",
    clearReply
  );

  $("#mic-btn")?.addEventListener(
    "click",
    toggleRecording
  );

  $("#recording-cancel")?.addEventListener(
    "click",
    cancelRecording
  );

  // أزرار المكالمات (صوتية/مرئية) بجانب زر البحث في رأس المحادثة
  safeDom("wire:call-buttons", () => wireCallButtons());

  // النقر خارج أي رسالة يخفي أزرار الإجراءات
  $("#chat-messages")?.addEventListener("click", (e) => {
    if (!e.target.closest(".bubble-row")) closeAllMessageActions();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllMessageActions();
  });

  // زر البحث داخل المحادثة
  $("#chat-search-toggle")?.addEventListener(
    "click",
    guard("chat:search-toggle", toggleChatSearch)
  );

  updateCallButtonsState();
}

/* ------------------------------------------------------------
 * البحث داخل الرسائل
 * ---------------------------------------------------------- */
function toggleChatSearch() {
  const bar = ensureChatSearchBar();

  const willShow = bar.classList.contains("hidden");

  bar.classList.toggle("hidden", !willShow);

  if (willShow) {
    bar.querySelector("input")?.focus();
  } else {
    clearChatSearchHighlights();
  }
}

function ensureChatSearchBar() {
  let bar = document.querySelector("#chat-search-bar");

  if (bar) return bar;

  bar = document.createElement("div");
  bar.id = "chat-search-bar";
  bar.className = "chat-search-bar hidden";
  bar.innerHTML = `
    <input type="search" id="chat-search-input" placeholder="ابحث في الرسائل..." autocomplete="off" />
    <span id="chat-search-count" class="chat-search-count"></span>
    <button type="button" id="chat-search-close" aria-label="إغلاق">✕</button>
  `;

  const header = document.querySelector(".chat-header");
  header?.insertAdjacentElement("afterend", bar);

  bar
    .querySelector("#chat-search-input")
    ?.addEventListener("input", guard("chat:search", (e) => runChatSearch(e.target.value)));

  bar.querySelector("#chat-search-close")?.addEventListener("click", () => {
    bar.classList.add("hidden");
    clearChatSearchHighlights();
  });

  return bar;
}

function clearChatSearchHighlights() {
  safeDom("search:clear", () => {
    document
      .querySelectorAll(".bubble-row.search-hit, .bubble-row.search-dim")
      .forEach((el) => el.classList.remove("search-hit", "search-dim"));

    const count = document.querySelector("#chat-search-count");
    if (count) count.textContent = "";
  });
}

function runChatSearch(rawQuery) {
  const query = (rawQuery || "").trim().toLowerCase();

  if (!query) {
    clearChatSearchHighlights();
    return;
  }

  safeDom("search:run", () => {
    const rows = document.querySelectorAll(".bubble-row");
    let hits = 0;
    let firstHit = null;

    rows.forEach((row) => {
      const text = (row.textContent || "").toLowerCase();
      const match = text.includes(query);

      row.classList.toggle("search-hit", match);
      row.classList.toggle("search-dim", !match);

      if (match) {
        hits += 1;
        if (!firstHit) firstHit = row;
      }
    });

    const count = document.querySelector("#chat-search-count");
    if (count) count.textContent = hits ? `${hits} نتيجة` : "لا نتائج";

    firstHit?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

/** يُفعّل/يُعطّل أزرار المكالمة حسب وجود محادثة نشطة واتصال بالإنترنت */
function updateCallButtonsState() {
  safeDom("call-buttons-state", () => {
    const enabled = Boolean(state.activeConversation?.otherProfile?.id) && state.isOnline;

    ["#chat-call-audio", "#chat-call-video"].forEach((sel) => {
      const btn = $(sel);
      if (btn) btn.disabled = !enabled;
    });
  });
}

function applyThemeVars() {
  if (state.me?.wallpaper_url) {
    const chatMessages = $("#chat-messages");

    if (chatMessages) {
      chatMessages.style.backgroundImage =
        `url("${state.me.wallpaper_url}")`;
    }
  }
}

// يمنع تشغيل loadContacts عشرات المرات عند تدفّق أحداث الـ presence
let loadContactsPending = null;
let loadContactsTimer = null;

async function loadContacts() {
  // إزالة الارتداد (debounce): تجميع النداءات المتقاربة في نداء واحد
  if (loadContactsTimer) clearTimeout(loadContactsTimer);

  if (loadContactsPending) return loadContactsPending;

  loadContactsPending = new Promise((resolve) => {
    loadContactsTimer = setTimeout(async () => {
      loadContactsTimer = null;
      try {
        await loadContactsInternal();
      } catch (error) {
        // لا تترك الوعد معلّقاً؛ الدورة التالية تعيد المحاولة بهدوء.
        console.warn("[contacts] refresh failed:", error);
      } finally {
        loadContactsPending = null;
        resolve();
      }
    }, 150);
  });

  return loadContactsPending;
}

async function loadContactsInternal() {
  if (!state.me) return;

  if (!state.isOnline) {
    const cached = await safeAsync("contacts:cache", () => getCachedContacts(), {
      fallback: [],
    });

    renderContactsFromCache(cached.data || []);

    return;
  }

  const result = await safeAsync("contacts:network", () => loadContactsFromNetwork());

  if (!result.ok) {
    const cached = await safeAsync("contacts:cache-fallback", () => getCachedContacts(), {
      fallback: [],
    });

    renderContactsFromCache(cached.data || []);
  }
}

function renderContactsFromCache(cached) {
  state.contactRowsByConversation = {};

  const list = $("#contact-list");

  if (!list) return;

  list.innerHTML = "";

  $("#admins-heading")?.classList.add("hidden");
  $("#admins-section")?.classList.add("hidden");

  $("#users-heading")?.classList.add("hidden");
  $("#users-section")?.classList.add("hidden");

  const fragment = document.createDocumentFragment();

  [...(cached || [])].sort(sortByLatestInteraction).forEach((c) => {
    try {
      fragment.appendChild(
        buildContactRow(c, {
          withUnread: true,
        })
      );
    } catch (err) {
      console.error("buildContactRow failed:", c?.id, err);
    }
  });

  list.appendChild(fragment);

  updateUnreadTotals();
}

async function loadContactsFromNetwork() {
  state.contactRowsByConversation = {};

  if (!state.me.is_admin) {
    // المستخدم العادي: قائمة المشرفين + عدّاد غير المقروء + ترتيب حسب آخر تفاعل
    const [{ data: adminProfiles }, { data: myConvs }] = await Promise.all([
      supabase.from("profiles").select("*").in("email", ADMINS.map((a) => a.email)),
      supabase
        .from("conversations")
        .select("id, admin_id, last_message, last_message_at")
        .eq("user_id", state.me.id),
    ]);

    const convByAdmin = new Map((myConvs || []).map((c) => [c.admin_id, c]));
    const convIds = (myConvs || []).map((c) => c.id);
    const unreadByConversation = await fetchUnreadCounts(convIds);

    state.contacts = (adminProfiles || [])
      .map((a) => {
        const conv = convByAdmin.get(a.id);
        return {
          ...a,
          _conversationId: conv?.id || null,
          _unread: conv ? unreadByConversation.get(conv.id) || 0 : 0,
          _lastMessage: conv?.last_message || "",
          _lastAt: conv?.last_message_at || null,
        };
      })
      .sort(sortByLatestInteraction);
    state.staffIds = new Set(state.contacts.map((a) => a.id));

    $("#contact-list").innerHTML = "";

    $("#admins-heading")?.classList.add("hidden");
    $("#admins-section")?.classList.add("hidden");

    $("#users-heading")?.classList.add("hidden");
    $("#users-section")?.classList.add("hidden");

    const frag = document.createDocumentFragment();
    state.contacts.forEach((c) => {
      frag.appendChild(buildContactRow(c, { withUnread: true }));
    });
    $("#contact-list").appendChild(frag);

    await safeAsync("cacheContacts", () => cacheContacts(state.contacts));
  } else {
    $("#contact-list").innerHTML = "";

    $("#admins-heading")?.classList.remove("hidden");
    $("#admins-section")?.classList.remove("hidden");

    $("#users-heading")?.classList.remove("hidden");
    $("#users-section")?.classList.remove("hidden");

    const {
      data: otherAdmins,
    } = await supabase
      .from("profiles")
      .select("*")
      .eq("is_admin", true)
      .neq("id", state.me.id);

    let convsQuery = supabase
      .from("conversations")
      .select(
        state.me.is_super_admin
          ? "*, user:profiles!conversations_user_id_fkey(*), owner_admin:profiles!conversations_admin_id_fkey(id, display_name, avatar_url)"
          : "*, user:profiles!conversations_user_id_fkey(*)"
      )
      .order("last_message_at", {
        ascending: false,
        nullsFirst: false,
      });

    if (!state.me.is_super_admin) {
      convsQuery = convsQuery.eq("admin_id", state.me.id);
    }

    let {
      data: convs,
      error: convsError,
    } = await convsQuery;

    if (convsError) {
      console.error("تعذّر جلب المحادثات:", convsError);
      // احتياط: إن فشل الـ join المزدوج (اسم FK مختلف) اجلب بدون owner_admin
      const fallback = await supabase
        .from("conversations")
        .select("*, user:profiles!conversations_user_id_fkey(*)")
        .order("last_message_at", { ascending: false, nullsFirst: false });
      convs = fallback.data || [];
      convsError = fallback.error;
    }

    // السوبر أدمن: اسم المشرف المالك لكل محادثة (من الـ join أو من قائمة المشرفين)
    const adminNameById = new Map((otherAdmins || []).map((a) => [a.id, a.display_name]));
    adminNameById.set(state.me.id, state.me.display_name);
    (convs || []).forEach((c) => {
      if (!c.owner_admin && c.admin_id) {
        const name = adminNameById.get(c.admin_id);
        if (name) c.owner_admin = { id: c.admin_id, display_name: name };
      }
    });

    const conversationIds = (convs || []).map((conversation) => conversation.id);
    const unreadByConversation = await fetchUnreadCounts(conversationIds);

    // محادثات المشرف الحالي مع المشرفين الآخرين (هو الطرف user_id فيها) — لترتيبهم حسب آخر تفاعل
    const { data: adminConvs } = await supabase
      .from("conversations")
      .select("id, admin_id, user_id, last_message, last_message_at")
      .or(`user_id.eq.${state.me.id},admin_id.eq.${state.me.id}`);
    const adminConvByPeer = new Map();
    (adminConvs || []).forEach((c) => {
      const peer = c.user_id === state.me.id ? c.admin_id : c.user_id;
      adminConvByPeer.set(peer, c);
    });
    const adminConvIds = [...adminConvByPeer.values()].map((c) => c.id).filter((id) => !conversationIds.includes(id));
    const adminUnread = await fetchUnreadCounts(adminConvIds);

    const userContacts = (convs || []).map((c) => ({
      ...c.user,
      _conversationId: c.id,
      _unread: unreadByConversation.get(c.id) || 0,
      _lastMessage: c.last_message,
      _lastAt: c.last_message_at || null,
      _ownerAdminName:
        state.me.is_super_admin && c.owner_admin?.id !== state.me.id
          ? c.owner_admin?.display_name
          : null,
    }));

    const adminContacts = (otherAdmins || [])
      .map((a) => {
        const conv = adminConvByPeer.get(a.id);
        return {
          ...a,
          _conversationId: conv?.id || null,
          _unread: conv ? adminUnread.get(conv.id) || unreadByConversation.get(conv.id) || 0 : 0,
          _lastMessage: conv?.last_message || "",
          _lastAt: conv?.last_message_at || null,
        };
      })
      .sort(sortByLatestInteraction);

    // المشرفون الذين يملكون محادثات المستخدمين في وضع السوبر أدمن قد يتكرّرون — لا مشكلة، القائمة منفصلة
    userContacts.sort(sortByLatestInteraction);

    // مرجع موحّد لكل جهات الاتصال (يُستخدم لتحديد جانب الفقاعة، أسماء المرسلين، الإشعارات)
    state.contacts = [...adminContacts, ...userContacts];
    state.staffIds = new Set([state.me.id, ...adminContacts.map((a) => a.id)]);

    // قبل أي رسم: ثبّت حضور المشرفين، فلا تُسقط أي مزامنة "متصل الآن"
    noteAdminPresenceOnline();

    $("#admins-section").innerHTML = "";
    const adminsFrag = document.createDocumentFragment();
    adminContacts.forEach((c) => {
      adminsFrag.appendChild(buildContactRow(c, { withUnread: true }));
    });
    $("#admins-section").appendChild(adminsFrag);
    renderAdminsSectionHeader(adminContacts);

    $("#users-section").innerHTML = "";
    const usersFrag = document.createDocumentFragment();
    userContacts.forEach((c) => {
      usersFrag.appendChild(buildContactRow(c, { withUnread: true }));
    });
    $("#users-section").appendChild(usersFrag);

    await Promise.all(
      (convs || []).map((conversation) =>
        safeAsync("cacheConversationMeta", () => cacheConversationMeta(conversation))
      )
    );

    await safeAsync("cacheContacts:admin", () =>
      cacheContacts([
        ...adminContacts,
        ...userContacts,
      ])
    );
  }

  // إجماليات الأقسام + شارة أيقونة التطبيق بعد كل تحديث للقائمة
  updateUnreadTotals();
}

/**
 * عدد الرسائل غير المقروءة (الواردة من الطرف الآخر) لكل محادثة.
 *
 * المسار المفضّل: دالة `unread_counts` في قاعدة البيانات (تجميع في الخادم —
 * بايتات أقل ونتيجة أدق من سحب آلاف الصفوف وحسابها في المتصفح).
 * المسار الاحتياطي: العدّ في العميل (يعمل حتى قبل تنفيذ migration v2.1).
 */
async function fetchUnreadCounts(conversationIds) {
  const map = new Map();
  const ids = (conversationIds || []).filter(Boolean);
  if (!ids.length || !state.me) return map;

  const rpc = await safeQuery("unread:rpc", () =>
    supabase.rpc("unread_counts", { p_conversation_ids: ids })
  );

  if (rpc.ok && Array.isArray(rpc.data)) {
    rpc.data.forEach((row) => {
      if (!row?.conversation_id) return;
      map.set(row.conversation_id, Number(row.unread) || 0);
    });
    return map;
  }

  const { data, error } = await supabase
    .from("messages")
    .select("conversation_id")
    .in("conversation_id", ids)
    .neq("sender_id", state.me.id)
    .neq("status", "read")
    .limit(5000);

  if (error) {
    console.warn("[unread] count failed:", error);
    return map;
  }
  for (const row of data || []) {
    map.set(row.conversation_id, (map.get(row.conversation_id) || 0) + 1);
  }
  return map;
}

/**
 * مصدر واحد للحقيقة لعدّاد غير المقروء في الواجهة.
 * يحدّث: شارة الصف + إجماليات الأقسام + شارة التطبيق على أيقونة النظام.
 */
function setConversationUnread(conversationId, value, { preview = undefined } = {}) {
  if (!conversationId) return;

  const count = Math.max(0, Number(value) || 0);

  if (count === 0) delete state.unreadByConversation[conversationId];
  else state.unreadByConversation[conversationId] = count;

  const row = state.contactRowsByConversation[conversationId];
  if (row) {
    row.dataset.unread = String(count);
    let badge = row.querySelector(".unread-badge");
    if (count === 0) {
      badge?.remove();
    } else {
      if (!badge) {
        badge = document.createElement("div");
        badge.className = "unread-badge";
        row.appendChild(badge);
      }
      badge.textContent = String(count);
    }
    if (preview !== undefined) {
      const sub = row.querySelector(".contact-sub");
      if (sub) sub.textContent = preview || "";
    }
  }

  updateUnreadTotals();
}

function unreadTotalFor(conversationIds) {
  return (conversationIds || []).reduce(
    (sum, id) => sum + (state.unreadByConversation[id] || 0),
    0
  );
}

/** إجمالي غير المقروء في كل المحادثات المعروفة */
function totalUnreadCount() {
  return Object.values(state.unreadByConversation).reduce(
    (sum, n) => sum + (Number(n) || 0),
    0
  );
}

/** يحدّث ترويسة الأقسام (شارة المشرفين) وشارة أيقونة التطبيق */
function updateUnreadTotals() {
  safeDom("unread:totals", () => {
    const adminSectionIds = [...document.querySelectorAll("#admins-section .contact-row")]
      .map((row) => row.dataset.conversationId)
      .filter(Boolean);
    const adminUnread = unreadTotalFor(adminSectionIds);

    const toggle = $("#admins-heading")?.querySelector("#admins-toggle");
    if (toggle) {
      let badge = toggle.querySelector(".section-unread");
      if (adminUnread > 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "unread-badge section-unread";
          toggle.querySelector(".section-toggle-title")?.after(badge);
        }
        badge.textContent = String(adminUnread);
      } else {
        badge?.remove();
      }
    }

    // شارة أيقونة التطبيق على نظام التشغيل (Badging API)
    const total = totalUnreadCount();
    try {
      if (typeof navigator.setAppBadge === "function") {
        const result = total > 0 ? navigator.setAppBadge(total) : navigator.clearAppBadge?.();
        if (result && typeof result.catch === "function") result.catch(() => {});
      }
    } catch {
      /* غير مدعومة */
    }
  });
}

/**
 * إعادة حساب العدّادات من قاعدة البيانات لمجموعة محادثات (أو لكل المعروض)
 * وتحديث الواجهة — تُستدعى بعد أي تغيير حالة (read) أو عودة من الخلفية.
 */
async function refreshUnreadBadges(conversationIds = null) {
  if (!state.me || !state.isOnline) return null;

  const ids = (conversationIds?.length
    ? conversationIds
    : Object.keys(state.contactRowsByConversation)
  ).filter(Boolean);

  if (!ids.length) return null;

  const map = await fetchUnreadCounts(ids);

  // ما لم يعد في الخريطة يعني أنه قُرئ → صفر
  ids.forEach((id) => setConversationUnread(id, map.get(id) || 0));

  return map;
}

/** تصفير فوري لعدّاد محادثة (عند النقر/الفتح) قبل انتظار أي طلب شبكة */
function resetUnreadFor(conversationId, options = {}) {
  if (!conversationId) return;
  setConversationUnread(conversationId, 0, options);
}

/** ترتيب حسب آخر تفاعل: الأحدث أولاً، ثم من لديه محادثة، ثم أبجدياً */
function sortByLatestInteraction(a, b) {
  const ta = a._lastAt ? Date.parse(a._lastAt) : 0;
  const tb = b._lastAt ? Date.parse(b._lastAt) : 0;
  if (tb !== ta) return tb - ta;
  if ((b._unread || 0) !== (a._unread || 0)) return (b._unread || 0) - (a._unread || 0);
  return String(a.display_name || "").localeCompare(String(b.display_name || ""), "ar");
}

const ADMINS_COLLAPSED_KEY = "wa_admins_collapsed";

/**
 * رأس قسم المشرفين قابل للطي: للسوبر أدمن مطويّ افتراضياً (يشغل سطراً واحداً)
 * مع زر لإظهار القائمة الكاملة بضغطة واحدة. للمشرف العادي مفتوح افتراضياً.
 */
function renderAdminsSectionHeader(adminContacts) {
  const heading = $("#admins-heading");
  const section = $("#admins-section");
  if (!heading || !section) return;

  const stored = localStorage.getItem(ADMINS_COLLAPSED_KEY);
  const collapsed = stored === null ? Boolean(state.me?.is_super_admin) : stored === "1";
  const totalUnread = adminContacts.reduce((n, c) => n + (c._unread || 0), 0);
  const online = adminContacts.filter((c) => c.id && state.onlineMap[c.id]).length;

  heading.classList.add("collapsible");
  heading.innerHTML = `
    <button type="button" class="section-toggle" id="admins-toggle" aria-expanded="${!collapsed}" aria-controls="admins-section">
      <span class="section-toggle-title">${escapeHtml(state.t?.admins || "المشرفون")} <small>(${adminContacts.length})</small></span>
      ${online ? `<span class="section-online">● ${online}</span>` : ""}
      ${totalUnread ? `<span class="unread-badge section-unread">${totalUnread}</span>` : ""}
      <span class="section-chevron" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
    </button>`;

  section.classList.toggle("collapsed", collapsed);

  heading.querySelector("#admins-toggle")?.addEventListener("click", () => {
    const nowCollapsed = !section.classList.contains("collapsed");
    section.classList.toggle("collapsed", nowCollapsed);
    localStorage.setItem(ADMINS_COLLAPSED_KEY, nowCollapsed ? "1" : "0");
    const btn = heading.querySelector("#admins-toggle");
    btn?.setAttribute("aria-expanded", String(!nowCollapsed));
    const chev = heading.querySelector(".section-chevron");
    if (chev) chev.textContent = nowCollapsed ? "▸" : "▾";
  });
}

function buildContactRow(c, opts) {
  const row =
    document.createElement("div");

  row.className = "contact-row" + (c.is_blocked ? " blocked-user" : "");

  const initials =
    (c.display_name || "?")
      .trim()
      .charAt(0);

  // المشرف يظهر "متصل الآن" دائماً وثابتاً (نقطة خضراء) — لا يعتمد على
  // نجاح نبضة الحضور ولا على ظهوره في قناة الحضور.
  const adminPeer = isAdminContact(c.id, c);
  if (adminPeer && c.id) state.onlineMap[c.id] = true;

  const online =
    Boolean(c.id) &&
    Boolean(adminPeer || state.onlineMap[c.id]);

  row.innerHTML = `
    <div class="avatar">
      ${
        c.avatar_url
          ? `<img src="${escapeHtml(c.avatar_url)}" alt="">`
          : initials
      }

      ${
        online
          ? '<span class="dot-online"></span>'
          : ""
      }
    </div>

    <div class="contact-info">
      <div class="contact-name">
        ${escapeHtml(c.display_name)}
        ${
          c._ownerAdminName
            ? `<span class="owner-admin-badge">${escapeHtml(c._ownerAdminName)}</span>`
            : ""
        }
      </div>

      <div class="contact-sub">
        ${escapeHtml(c._lastMessage || "")}
      </div>
    </div>

    ${c._lastAt ? `<div class="contact-time">${escapeHtml(formatContactTime(c._lastAt))}</div>` : ""}

    ${
      opts.withUnread && c._unread
        ? `<div class="unread-badge">${c._unread}</div>`
        : ""
    }
    ${state.me.is_admin && !c.is_admin ? `<div class="admin-user-actions"><button type="button" data-admin-action="block" title="${c.is_blocked ? "إلغاء الحظر" : "حظر المستخدم"}">${c.is_blocked ? "✅" : "⛔"}</button><button type="button" data-admin-action="delete" title="حذف المستخدم">🗑️</button></div>` : ""}
  `;

  row.querySelectorAll("[data-admin-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!state.me.is_admin) return;
      const action = button.dataset.adminAction;
      if (action === "block") {
        const blocking = !c.is_blocked;
        if (!window.confirm(blocking ? `حظر ${c.display_name || "المستخدم"}؟ لن يتمكن من الدخول.` : `إلغاء حظر ${c.display_name || "المستخدم"}؟`)) return;
        const { error } = await supabase.rpc("admin_set_user_blocked", { p_user_id: c.id, p_blocked: blocking });
        if (error) {
          showAuthError("تعذّر تنفيذ الحظر — تأكد من تطبيق sql/schema.sql وصلاحيات المشرف.");
          return;
        }
        c.is_blocked = blocking;
        button.textContent = blocking ? "✅" : "⛔";
        button.title = blocking ? "إلغاء الحظر" : "حظر المستخدم";
        row.classList.toggle("blocked-user", blocking);
        showAuthError(blocking ? "تم حظر المستخدم." : "تم إلغاء الحظر.");
        return;
      }
      if (action === "delete" && window.confirm(`حذف ${c.display_name || "المستخدم"} نهائياً مع جميع محادثاته ورسائله؟`)) {
        const { data: deleted, error } = await supabase.rpc("admin_delete_user", { p_user_id: c.id });
        if (!error && deleted) {
          showAuthError(`تم الحذف: ${deleted.messages ?? 0} رسالة، ${deleted.conversations ?? 0} محادثة، ${deleted.call_rooms ?? 0} مكالمة، ${deleted.storage_objects ?? 0} ملف`);
        }
        if (error) {
          console.error("admin_delete_user failed:", error);
          const detail = error.message || error.details || error.code || "";
          showAuthError(
            /PGRST202|schema cache/i.test(detail)
              ? "دالة admin_delete_user غير موجودة — نفّذ sql/migrations/2026-09-21_v2_2_admin_delete_push.sql"
              : `تعذّر حذف المستخدم: ${detail}`
          );
          return;
        }
        row.remove();
        showAuthError("تم حذف المستخدم.");
      }
    });
  });

  row.addEventListener("click", () => {
    // تصفير العدّاد لحظة النقر — قبل أي عمل غير متزامن داخل openConversation.
    // (المطلوب: يزول العدّاد بمجرد فتح المحادثة لا بعد جهوزية الشبكة).
    if (c._conversationId) resetUnreadFor(c._conversationId);
    openConversation(c);
  });

  if (
    opts.withUnread &&
    c._conversationId
  ) {
    row.dataset.conversationId =
      c._conversationId;

    row.dataset.unread =
      String(c._unread || 0);

    state.contactRowsByConversation[
      c._conversationId
    ] = row;

    // زامِن خريطة العدّادات مع ما رُسم فعلاً (مصدر واحد للحقيقة)
    if (c._unread) state.unreadByConversation[c._conversationId] = c._unread;
    else delete state.unreadByConversation[c._conversationId];
  }

  return row;
}

function formatContactTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const locale = state.lang === "ar" ? "ar-SA" : "en-US";
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  const y = new Date();
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return state.lang === "ar" ? "أمس" : "Yesterday";
  return d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

/**
 * زيادة فورية لعدّاد غير المقروء عند وصول رسالة (قبل أي طلب شبكة).
 * المصدر الرسمي للعدّاد يبقى قاعدة البيانات، ويُصحَّح عبر refreshUnreadBadges.
 */
function bumpUnreadBadge(conversationId, preview) {
  if (state.activeConversation?.id === conversationId && document.visibilityState === "visible") {
    return;
  }

  const row =
    state.contactRowsByConversation[
      conversationId
    ];

  if (!row) {
    // المحادثة غير معروضة (جديدة) → أعد بناء القائمة ثم صحّح العدّاد
    loadContacts();
    setTimeout(() => refreshUnreadBadges([conversationId]), 700);
    return;
  }

  const current =
    (state.unreadByConversation[conversationId] ??
      parseInt(row.dataset.unread || "0", 10)) + 1;

  setConversationUnread(conversationId, current, { preview });

  // انقل المحادثة إلى أعلى قائمتها (آخر تفاعل) وحدّث وقتها
  if (preview !== undefined) {
    let timeEl = row.querySelector(".contact-time");
    if (!timeEl) {
      timeEl = document.createElement("div");
      timeEl.className = "contact-time";
      row.appendChild(timeEl);
    }
    timeEl.textContent = formatContactTime(new Date().toISOString());
  }
  const parent = row.parentElement;
  if (parent && parent.firstElementChild !== row) parent.prepend(row);
}

function clearUnreadBadge(conversationId) {
  if (!conversationId) return;
  setConversationUnread(conversationId, 0);
}

function escapeHtml(str) {
  const d =
    document.createElement("div");

  d.textContent =
    str || "";

  return d.innerHTML;
}

async function openConversation(otherProfile, { messageId = null } = {}) {
  if (!otherProfile.id) {
    showAuthError(
      "هذا المشرف لم يُنشئ حسابه في التطبيق بعد، لا يمكن بدء محادثة معه حالياً."
    );

    return;
  }

  try {
    $("#chat-empty-state")?.classList.add(
      "hidden"
    );

    $("#chat-active")?.classList.remove(
      "hidden"
    );

    clearReply();

    let conversationId =
      otherProfile._conversationId;

    if (!conversationId) {
      const userId =
        state.me.is_admin
          ? otherProfile.id
          : state.me.id;

      const adminId =
        state.me.is_admin
          ? state.me.id
          : otherProfile.id;

      const {
        data: existing,
        error: selectErr,
      } = await supabase
        .from("conversations")
        .select("*")
        .eq("user_id", userId)
        .eq("admin_id", adminId)
        .maybeSingle();

      if (selectErr) {
        throw selectErr;
      }

      if (existing) {
        conversationId =
          existing.id;
      } else {
        const {
          data: created,
          error,
        } = await supabase
          .from("conversations")
          .insert({
            user_id: userId,
            admin_id: adminId,
          })
          .select()
          .single();

        if (error) {
          throw error;
        }

        conversationId =
          created.id;
      }
    }

    state.activeConversation = {
      id: conversationId,
      otherProfile,
      adminId: state.me.is_admin && !otherProfile.is_admin ? state.me.id : otherProfile.is_admin ? otherProfile.id : null,
      userId: !state.me.is_admin ? state.me.id : !otherProfile.is_admin ? otherProfile.id : null,
    };
    state.messagesHasMore = false;
    state.loadingOlder = false;

    // ⚡️ تصفير العدّاد فور فتح المحادثة — قبل أي طلب شبكة.
    // الشرط الوحيد لتصفير العدّاد هو فتح المحادثة، والقيمة النهائية
    // تُثبَّت في قاعدة البيانات بعد قليل عبر markConversationRead.
    resetUnreadFor(conversationId);
    closeConversationNotifications(conversationId);

    openConversationUIState(
      conversationId
    );

    $("#chat-header-name").textContent =
      otherProfile.display_name;
    if (otherProfile._ownerAdminName) {
      const badge = document.createElement("span");
      badge.className = "owner-admin-badge";
      badge.textContent = otherProfile._ownerAdminName;
      $("#chat-header-name").appendChild(badge);
    }

    $("#chat-header-avatar").src =
      otherProfile.avatar_url || "";

    await refreshPresenceLabel(
      otherProfile.id
    );

    // صفّر العدّاد فوراً (تفاؤلياً) قبل أي نداء شبكة
    clearUnreadBadge(conversationId);
    closeConversationNotifications(conversationId);

    await loadMessages(
      conversationId
    );

    await loadReactionsForConversation();

    subscribeToConversation(
      conversationId
    );

    await markConversationRead(
      conversationId,
      { force: true }
    );

    // نقر الإشعار: تمرير إلى الرسالة التي أحدثته مع تمييز مؤقت. قد تكون
    // أحدث من آخر مزامنة أو أقدم من الصفحة المحمّلة، لذا نحاول مرتين.
    if (messageId) {
      state.focusMessageId = messageId;
      safeAsync("deeplink:focus", async () => {
        const found = await scrollToMessage(messageId);
        if (found) return;
        await new Promise((resolve) => setTimeout(resolve, 800));
        await loadMessages(conversationId, { silent: true });
        state.focusMessageId = null;
        await scrollToMessage(messageId, { attempts: 5 });
      });
    }

    // فعّل أزرار المكالمة الآن بعد توفّر محادثة نشطة
    safeDom("open:call-buttons", () => {
      wireCallButtons();
      updateCallButtonsState();
    });
  } catch (err) {
    console.error(
      "openConversation failed:",
      err
    );

    showAuthError(
      "تعذّر فتح المحادثة: " +
        (err?.message ||
          "خطأ غير معروف") +
        " — تأكد من تشغيل sql/schema.sql بالكامل ومن صحة SUPABASE_URL/ANON_KEY في js/config.js"
    );

    closeChatView();
  }
}

/**
 * تحميل الرسائل — استراتيجية "Cache-first ثم مزامنة تفاضلية":
 *  1) اعرض النسخة المخزّنة في IndexedDB فوراً (صفر انتظار، وتعمل دون اتصال).
 *  2) إن كانت الكاش موجودة: اجلب من الشبكة فقط الرسائل الأحدث/المحدَّثة بعد
 *     آخر created_at معروف (delta sync) بدل إعادة تحميل 500 رسالة كل مرة.
 *  3) إن كانت الكاش فارغة: اجلب آخر صفحة (MESSAGES_PAGE_SIZE) بترتيب تنازلي
 *     ثم اعكسها — أسرع بكثير من جلب كل التاريخ.
 *  4) تحميل الأقدم عند التمرير للأعلى (loadOlderMessages).
 */
async function loadMessages(conversationId, { silent = false } = {}) {
  const box = $("#chat-messages");

  // 1) الكاش
  const cachedResult = await safeAsync(
    "loadMessages:cache",
    () => getCachedMessages(conversationId),
    { fallback: [] }
  );
  const cached = cachedResult.data || [];

  const readStateResult = await safeAsync(
    "loadMessages:read-state",
    () => getReadState(conversationId),
    { fallback: null }
  );

  if (state.activeConversation?.id !== conversationId) return;

  if (cached.length && !silent) {
    state.messages = cached;
    state.messagesHasMore = cached.length >= MESSAGES_PAGE_SIZE;
    renderMessages({ keepScroll: false });
    if (box && typeof readStateResult.data?.scroll_top === "number" && !state.isOnline) {
      box.scrollTop = readStateResult.data.scroll_top;
    }
  }

  if (!state.isOnline) {
    if (!cached.length && !silent) {
      state.messages = [];
      renderMessages();
    }
    return;
  }

  // 2/3) الشبكة
  const latestCachedAt = cached.length ? cached[cached.length - 1].created_at : null;
  const deltaMode = Boolean(latestCachedAt) && cached.length > 0;

  const { ok, data } = await safeQuery(
    "loadMessages:network",
    () => {
      let q = supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("conversation_id", conversationId);
      if (deltaMode) {
        // الرسائل الجديدة + أي تحديثات حالة (read/delivered) على آخر 60 رسالة
        const since = cached[Math.max(0, cached.length - 60)].created_at;
        q = q.gte("created_at", since).order("created_at", { ascending: true }).limit(500);
      } else {
        q = q.order("created_at", { ascending: false }).limit(MESSAGES_PAGE_SIZE);
      }
      return q;
    },
    null
  );

  if (!ok || !Array.isArray(data)) {
    if (!cached.length && !silent) showAuthError("تعذّر تحميل الرسائل — تحقق من الاتصال.");
    return;
  }

  // تجاهل الرد إن غُيّرت المحادثة أثناء انتظار الشبكة (سباق حالة)
  if (state.activeConversation?.id !== conversationId) return;

  let merged;
  if (deltaMode) {
    const byId = new Map(cached.map((m) => [m.id, m]));
    data.forEach((m) => byId.set(m.id, m));
    // أزل الرسائل المحلية المؤقتة التي وصلت نسختها الحقيقية
    const pending = state.messages.filter((m) => m._pending && !byId.has(m.id));
    merged = [...byId.values(), ...pending].sort((a, b) => a.created_at.localeCompare(b.created_at));
    // حذف على الخادم: رسائل كانت ضمن نافذة الدلتا ولم تعد موجودة
    const since = cached[Math.max(0, cached.length - 60)].created_at;
    const serverIds = new Set(data.map((m) => m.id));
    const removed = cached.filter((m) => m.created_at >= since && !serverIds.has(m.id) && !String(m.id).startsWith("local-"));
    if (removed.length) {
      merged = merged.filter((m) => !removed.some((r) => r.id === m.id));
      removed.forEach((r) => safeAsync("cache:prune", () => removeCachedMessage(r.id)));
    }
    state.messagesHasMore = state.messagesHasMore || cached.length >= MESSAGES_PAGE_SIZE;
  } else {
    merged = [...data].reverse();
    state.messagesHasMore = data.length >= MESSAGES_PAGE_SIZE;
  }

  const changed = messagesSignature(merged) !== messagesSignature(state.messages);
  state.messages = merged;
  if (changed || !silent) renderMessages({ keepScroll: silent });

  await safeAsync("loadMessages:persist", () => cacheMessages(conversationId, merged.filter((m) => !m._pending)));
  await safeAsync("loadMessages:save-state", () =>
    saveReadState(conversationId, {
      last_message_id: merged.at(-1)?.id || readStateResult.data?.last_message_id || null,
      last_message_at: merged.at(-1)?.created_at || readStateResult.data?.last_message_at || null,
      scroll_top: box?.scrollTop || 0,
    })
  );
}

function messagesSignature(list) {
  return (list || []).map((m) => `${m.id}:${m.status}:${m.content?.length || 0}`).join("|");
}

/** تحميل صفحة أقدم عند التمرير لأعلى المحادثة */
async function loadOlderMessages() {
  const conv = state.activeConversation;
  const box = $("#chat-messages");
  if (!conv || !box || state.loadingOlder || !state.messagesHasMore || !state.isOnline) return;
  const oldest = state.messages.find((m) => !m._pending);
  if (!oldest) return;

  state.loadingOlder = true;
  const prevHeight = box.scrollHeight;

  const { ok, data } = await safeQuery(
    "loadOlderMessages",
    () =>
      supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("conversation_id", conv.id)
        .lt("created_at", oldest.created_at)
        .order("created_at", { ascending: false })
        .limit(MESSAGES_PAGE_SIZE),
    null
  );

  state.loadingOlder = false;
  if (!ok || !Array.isArray(data) || state.activeConversation?.id !== conv.id) return;

  state.messagesHasMore = data.length >= MESSAGES_PAGE_SIZE;
  if (!data.length) return;

  const existing = new Set(state.messages.map((m) => m.id));
  const older = data.reverse().filter((m) => !existing.has(m.id));
  state.messages = [...older, ...state.messages];
  renderMessages({ keepScroll: true });
  // حافظ على موضع القراءة
  box.scrollTop = box.scrollHeight - prevHeight;
  await safeAsync("cache:older", () => cacheMessages(conv.id, older));
}

async function loadReactionsForConversation() {
  state.reactions = {};

  const ids =
    state.messages.map(
      (m) => m.id
    );

  if (!ids.length) {
    return;
  }

  const {
    data,
  } = await supabase
    .from("message_reactions")
    .select("*")
    .in(
      "message_id",
      ids
    );

  (data || []).forEach((r) => {
    if (
      !state.reactions[
        r.message_id
      ]
    ) {
      state.reactions[
        r.message_id
      ] = [];
    }

    state.reactions[
      r.message_id
    ].push(r);
  });

  renderMessages();
}

function renderMessages({ keepScroll = false } = {}) {
  const box =
    $("#chat-messages");

  if (!box) return;

  // لا نرسم بدون ملف شخصي محمّل (يمنع قراءة state.me.id على null)
  if (!state.me) return;

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const prevScrollTop = box.scrollTop;

  box.innerHTML = "";

  if (!Array.isArray(state.messages) || !state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.textContent =
      state.t?.no_messages || "لا توجد رسائل بعد. ابدأ المحادثة الآن.";
    box.appendChild(empty);

    return;
  }

  // الرسم عبر DocumentFragment: إعادة تدفّق (reflow) واحدة بدل واحدة لكل رسالة
  const fragment = document.createDocumentFragment();

  if (state.messagesHasMore) {
    const more = document.createElement("div");
    more.className = "load-older";
    more.innerHTML = '<button type="button" class="load-older-btn">تحميل رسائل أقدم</button>';
    more.querySelector("button")?.addEventListener("click", () => loadOlderMessages());
    fragment.appendChild(more);
  }

  let lastDay = null;
  state.messages.forEach((m) => {
    try {
      const day = new Date(m.created_at).toDateString();
      if (day !== lastDay) {
        const sep = document.createElement("div");
        sep.className = "day-separator";
        sep.innerHTML = `<span>${escapeHtml(formatCallDay(m.created_at))}</span>`;
        fragment.appendChild(sep);
        lastDay = day;
      }
      fragment.appendChild(
        m.message_type === "call" ? buildCallBubble(m) : buildMessageBubble(m)
      );
    } catch (err) {
      // فقاعة تالفة يجب ألّا تُسقط المحادثة كلها
      console.error("buildMessageBubble failed for message:", m?.id, err);
    }
  });

  box.appendChild(fragment);

  if (!box.dataset.scrollWired) {
    box.dataset.scrollWired = "1";
    box.addEventListener("scroll", () => {
      if (box.scrollTop < 80) loadOlderMessages();
      clearTimeout(box._saveScrollTimer);
      box._saveScrollTimer = setTimeout(() => {
        if (state.activeConversation) {
          safeAsync("scroll:save", () =>
            saveReadState(state.activeConversation.id, { scroll_top: box.scrollTop })
          );
        }
      }, 400);
    }, { passive: true });
  }

  if (keepScroll && !nearBottom) {
    box.scrollTop = prevScrollTop;
  } else {
    box.scrollTop = box.scrollHeight;
  }
}

/** بطاقة سجل المكالمة داخل المحادثة (مكالمة فائتة / مدة المكالمة) */
function buildCallBubble(m) {
  const row = document.createElement("div");
  row.className = "bubble-row call-row";
  row.dataset.messageId = m.id;

  const callerId = m.call_caller_id || m.sender_id;
  const outgoing = bubbleSideFor(callerId) === "mine";
  const isVideo = m.call_type === "video" || /فيديو/.test(m.content || "");
  const duration = Number(m.call_duration_seconds || 0);
  let status = m.call_status;
  if (!status) {
    // توافق مع بطاقات قديمة بلا call_status
    status = /فائتة/.test(m.content || "") ? "missed" : duration ? "ended" : "ended";
  }
  const answered = status === "ended" && duration > 0;

  let kind = "completed";
  let title;
  if (status === "missed") {
    kind = outgoing ? "unanswered" : "missed";
    title = outgoing ? (isVideo ? "مكالمة فيديو لم يُرد عليها" : "مكالمة صوتية لم يُرد عليها") : (isVideo ? "مكالمة فيديو فائتة" : "مكالمة صوتية فائتة");
  } else if (status === "declined") {
    kind = outgoing ? "unanswered" : "declined";
    title = outgoing ? "تم رفض المكالمة" : (isVideo ? "مكالمة فيديو مرفوضة" : "مكالمة صوتية مرفوضة");
  } else if (status === "failed" || status === "network_lost") {
    kind = "unanswered";
    title = "مكالمة لم تكتمل";
  } else {
    title = isVideo ? "مكالمة فيديو" : "مكالمة صوتية";
  }
  if (!answered && kind === "completed") {
    kind = "unanswered";
  }

  const time = new Date(m.created_at).toLocaleTimeString(state.lang === "ar" ? "ar-SA" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dirIcon = kind === "missed" ? "↙" : outgoing ? "↗" : "↙";
  const dirClass = kind === "missed" ? "missed" : outgoing ? "out" : "in";
  const dirLabel = outgoing ? "صادرة" : "واردة";
  const sub = answered ? `المدة ${formatCallDuration(duration)}` : kind === "missed" ? "اضغط لمعاودة الاتصال" : kind === "unanswered" ? "لم يتم الرد" : "";
  const canCallBack = Boolean(state.activeConversation?.otherProfile?.id) && state.isOnline;

  row.innerHTML = `
    <div class="bubble">
      <div class="call-card ${kind} ${outgoing ? "mine" : ""}">
        <div class="call-card-icon">${isVideo ? "🎥" : "📞"}</div>
        <div class="call-card-title">${escapeHtml(title)}</div>
        <div class="call-card-sub"><span class="call-card-dir ${dirClass}">${dirIcon} ${dirLabel}</span>${sub ? `<span>· ${escapeHtml(sub)}</span>` : ""}</div>
        ${canCallBack ? `<button type="button" class="call-card-callback" title="معاودة الاتصال" aria-label="معاودة الاتصال">${isVideo ? "🎥" : "📞"}</button>` : ""}
        <div class="call-card-time">${time}</div>
      </div>
    </div>`;

  row.querySelector(".call-card-callback")?.addEventListener("click", () => {
    startCallWith(state.activeConversation.otherProfile, state.activeConversation.id, isVideo ? "video" : "audio");
  });

  if (state.me.is_admin) {
    // المشرف يستطيع حذف بطاقة المكالمة كأي رسالة (RLS: حذف المشرفين فقط)
    row.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      if (!window.confirm("حذف سجل هذه المكالمة من المحادثة؟")) return;
      const { error } = await supabase.from("messages").delete().eq("id", m.id);
      if (error) {
        showAuthError("لا يمكن حذف الرسالة.");
        return;
      }
      state.messages = state.messages.filter((x) => x.id !== m.id);
      await safeAsync("cache:delete-message", () => removeCachedMessage(m.id));
      renderMessages({ keepScroll: true });
    });
  }

  return row;
}

/** يخفي أزرار الإجراءات ولوحة التفاعل لكل الرسائل */
function closeAllMessageActions() {
  document.querySelectorAll(".bubble-row.selected").forEach((r) => r.classList.remove("selected"));
  document.querySelectorAll(".quick-react-panel:not(.hidden)").forEach((p) => p.classList.add("hidden"));
}

function findMessageById(id) {
  return state.messages.find(
    (m) => m.id === id
  );
}

/** تهيئة معرّف للاستخدام داخل محدّد CSS بأمان */
function selectorSafeId(id) {
  const value = String(id || "");
  try {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  } catch {
    /* تجاهل */
  }
  return value.replace(/["\\\]]/g, "\\$&");
}

/**
 * يمرّر نافذة الدردشة إلى الرسالة التي أحدثت الإشعار ويميّزها لحظياً —
 * هذا ما يجعل نقر الإشعار ينقل المستخدم إلى "سياق" الرسالة لا إلى آخر الصفحة.
 * إن كانت الرسالة أقدم من الصفحة المحمّلة تُحمَّل صفحات أقدم تدريجياً (بحد أقصى).
 */
async function scrollToMessage(messageId, { attempts = 3 } = {}) {
  if (!messageId) return false;

  const box = $("#chat-messages");
  if (!box) return false;

  const selector = `.bubble-row[data-message-id="${selectorSafeId(messageId)}"]`;
  let row = box.querySelector(selector);

  for (let i = 0; i < attempts && !row && state.messagesHasMore; i += 1) {
    await safeAsync("scrollToMessage:older", () => loadOlderMessages());
    row = box.querySelector(selector);
  }

  if (!row) {
    console.warn("[deeplink] الرسالة غير موجودة في الصفحة الحالية:", messageId);
    return false;
  }

  // التمييز أولاً (لا يعتمد على دعم scrollIntoView في كل بيئة)
  safeDom("scrollToMessage:highlight", () => {
    row.classList.add("flash-message");
    setTimeout(() => row.classList.remove("flash-message"), 2400);
  });

  safeDom("scrollToMessage:scroll", () => {
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      const box = $("#chat-messages");
      if (box) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2);
    }
  });

  return true;
}

function messagePreviewText(m) {
  if (!m) return "";

  if (m.content) {
    return m.content;
  }

  if (
    m.attachment_type ===
    "image"
  ) {
    return "📷 صورة";
  }

  if (
    m.attachment_type ===
    "audio"
  ) {
    return "🎤 رسالة صوتية";
  }

  if (
    m.attachment_type ===
    "file"
  ) {
    return "📎 ملف";
  }

  return "";
}

/**
 * جانب الفقاعة: فقاعات المشرفين/الإدارة (بمن فيهم أنا إن كنت مشرفاً) في جهة،
 * وفقاعات المستخدم العادي في الجهة الأخرى — حتى عندما يشاهد السوبر أدمن محادثة مشرف آخر.
 */
function isStaffSender(senderId) {
  if (senderId === state.me.id) return Boolean(state.me.is_admin || state.me.is_super_admin);
  const conv = state.activeConversation;
  if (conv?.otherProfile?.id === senderId) {
    return Boolean(conv.otherProfile.is_admin || conv.otherProfile.is_super_admin);
  }
  if (conv?.adminId && senderId === conv.adminId) return true;
  if (conv?.userId && senderId === conv.userId) return false;
  if (state.staffIds?.has(senderId)) return true;
  const c = state.contacts.find((x) => x.id === senderId);
  return Boolean(c?.is_admin || c?.is_super_admin);
}

function bubbleSideFor(senderId) {
  const iAmStaff = Boolean(state.me.is_admin || state.me.is_super_admin);
  const senderIsStaff = isStaffSender(senderId);
  // "mine" = نفس فريقي (يمين للمشرفين، يمين للمستخدم عن نفسه)
  return senderIsStaff === iAmStaff ? "mine" : "theirs";
}

function buildMessageBubble(m) {
  const mine =
    m.sender_id ===
    state.me.id;

  const side = bubbleSideFor(m.sender_id);
  const showSenderName = side === "mine" && !mine;

  const div =
    document.createElement("div");

  div.className =
    `bubble-row ${side}${mine ? " own" : ""}`;

  div.dataset.messageId =
    m.id;

  const time =
    new Date(
      m.created_at
    ).toLocaleTimeString(
      state.lang === "ar"
        ? "ar-SA"
        : "en-US",
      {
        hour: "2-digit",
        minute: "2-digit",
      }
    );

  // الحالات: pending = محفوظة محلياً (✓) | sent/delivered = وصلت السيرفر أو
  // وصل إشعارها (✓✓ رمادي) | read = قُرئت فعلاً (✓✓ أزرق) | failed = فشل الإرسال
  const ticks =
    mine
      ? m._failed || m.status === "failed"
        ? '<span class="ticks ticks-failed" title="تعذّر الإرسال">⚠</span>'
        : renderTicks(m.status)
      : "";

  const quoted =
    m.reply_to_id
      ? findMessageById(
          m.reply_to_id
        )
      : null;

  const quotedHtml =
    quoted
      ? `<div class="quoted-reply">${escapeHtml(
          messagePreviewText(
            quoted
          )
        )}</div>`
      : "";

  let attach = "";

  if (m.attachment_url) {
    if (
      m.attachment_type ===
      "image"
    ) {
      attach = `
        <img
          class="msg-attachment"
          src="${escapeHtml(
            m.attachment_url
          )}"
          alt=""
          loading="lazy"
          decoding="async"
        >
      `;
    } else if (
      m.attachment_type ===
      "audio"
    ) {
      attach = `
        <audio
          class="msg-audio"
          controls
          preload="metadata"
          src="${escapeHtml(
            m.attachment_url
          )}"
        ></audio>
      `;
    } else {
      attach = `
        <a
          class="msg-file"
          href="${escapeHtml(
            m.attachment_url
          )}"
          target="_blank"
          rel="noopener noreferrer"
        >
          📎 ${state.t.attach}
        </a>
      `;
    }
  }

  const reactions =
    state.reactions[
      m.id
    ] || [];

  const grouped = {};

  reactions.forEach((r) => {
    grouped[r.emoji] =
      grouped[r.emoji] || {
        count: 0,
        mine: false,
      };

    grouped[
      r.emoji
    ].count += 1;

    if (
      r.user_id ===
      state.me.id
    ) {
      grouped[
        r.emoji
      ].mine = true;
    }
  });

  const reactionsHtml =
    Object.keys(grouped).length
      ? `
        <div class="reaction-bar">
          ${Object.entries(
            grouped
          )
            .map(
              ([emoji, g]) =>
                `
                <span
                  class="reaction-chip ${
                    g.mine
                      ? "mine"
                      : ""
                  }"
                  data-emoji="${escapeHtml(
                    emoji
                  )}"
                >
                  ${emoji} ${g.count}
                </span>
              `
            )
            .join("")}
        </div>
      `
      : "";

  let buttonsHtml = "";

  if (
    !mine &&
    Array.isArray(m.buttons) &&
    m.buttons.length
  ) {
    const used =
      state.clickedWelcomeButtons.has(
        m.id
      );

    buttonsHtml = `
      <div class="msg-buttons">
        ${m.buttons
          .map(
            (b) =>
              `
              <button
                type="button"
                class="msg-btn"
                data-value="${escapeHtml(
                  b.value
                )}"
                ${
                  used
                    ? "disabled"
                    : ""
                }
              >
                ${escapeHtml(
                  b.label
                )}
              </button>
            `
          )
          .join("")}
      </div>
    `;
  }

  const senderLabel = showSenderName
    ? `<div class="bubble-sender">${escapeHtml(
        (state.contacts.find((x) => x.id === m.sender_id) || state.activeConversation?.otherProfile || {}).display_name ||
          state.activeConversation?.otherProfile?._ownerAdminName ||
          "مشرف"
      )}</div>`
    : "";

  div.innerHTML = `
    <div class="bubble">
      ${senderLabel}

      <div class="bubble-actions">
        <button
          class="bubble-action-reply"
          title="${state.t.reply}"
          type="button"
        >
          ↩
        </button>

        <button
          class="bubble-action-react"
          title="React"
          type="button"
        >
          😊
        </button>
        ${state.me.is_admin ? '<button class="bubble-action-delete" title="حذف الرسالة" type="button">🗑️</button>' : ""}
      </div>

      ${quotedHtml}

      ${attach}

      ${
        m.content
          ? `<div class="bubble-text">${escapeHtml(
              m.content
            )}</div>`
          : ""
      }

      <div class="bubble-meta">
        <span class="bubble-time">
          ${time}
        </span>
        ${ticks}
      </div>

      ${reactionsHtml}

      ${buttonsHtml}

      <div class="quick-react-panel hidden"></div>

    </div>
  `;

  div
    .querySelectorAll(".msg-btn")
    .forEach((btn) => {
      btn.addEventListener(
        "click",
        async () => {
          if (btn.disabled) {
            return;
          }

          state.clickedWelcomeButtons.add(
            m.id
          );

          div
            .querySelectorAll(
              ".msg-btn"
            )
            .forEach(
              (b) =>
                (b.disabled = true)
            );

          await sendMessage({
            content:
              btn.dataset.value,
          });
        }
      );
    });

  div
    .querySelector(
      ".bubble-action-reply"
    )
    ?.addEventListener(
      "click",
      () => {
        setReplyTarget(m);
        closeAllMessageActions();
      }
    );

  // الإجراءات مخفية افتراضياً — تظهر عند النقر على الرسالة نفسها فقط
  const bubbleEl = div.querySelector(".bubble");
  bubbleEl?.addEventListener("click", (e) => {
    if (e.target.closest(".bubble-actions, .quick-react-panel, .reaction-chip, .msg-btn, a, audio, .msg-attachment")) return;
    const wasSelected = div.classList.contains("selected");
    closeAllMessageActions();
    if (!wasSelected) div.classList.add("selected");
  });

  div.querySelector(".bubble-action-delete")?.addEventListener("click", async () => {
    if (!state.me.is_admin || !window.confirm("حذف الرسالة؟")) return;
    const { error } = await supabase.from("messages").delete().eq("id", m.id);
    if (error) {
      showAuthError("لا يمكن حذف الرسالة.");
      return;
    }
    state.messages = state.messages.filter((message) => message.id !== m.id);
    await safeAsync("cache:delete-message", () => removeCachedMessage(m.id));
    renderMessages();
  });

  const reactBtn =
    div.querySelector(
      ".bubble-action-react"
    );

  const quickPanel =
    div.querySelector(
      ".quick-react-panel"
    );

  const quickEmojis = [
    "❤️",
    "👍",
    "😂",
    "😮",
    "😢",
    "🙏",
  ];

  if (quickPanel) {
    quickPanel.innerHTML =
      quickEmojis
        .map(
          (e) =>
            `
            <span
              class="quick-react-opt"
              data-emoji="${e}"
            >
              ${e}
            </span>
          `
        )
        .join("");

    reactBtn?.addEventListener(
      "click",
      () => {
        quickPanel.classList.toggle(
          "hidden"
        );
      }
    );

    quickPanel.addEventListener(
      "click",
      (e) => {
        const emoji =
          e.target.dataset
            .emoji;

        if (emoji) {
          toggleReaction(
            m.id,
            emoji
          );

          closeAllMessageActions();
        }
      }
    );
  }

  div
    .querySelectorAll(
      ".reaction-chip"
    )
    .forEach((chip) => {
      chip.addEventListener(
        "click",
        () => {
          toggleReaction(
            m.id,
            chip.dataset.emoji
          );
        }
      );
    });

  wireSwipeToReply(
    div,
    m
  );

  return div;
}

function wireSwipeToReply(
  row,
  message
) {
  const bubble =
    row.querySelector(
      ".bubble"
    );

  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  let horizontalLock = false;

  const THRESHOLD = 60;

  row.addEventListener(
    "touchstart",
    (e) => {
      startX =
        e.touches[0].clientX;

      startY =
        e.touches[0].clientY;

      dx = 0;
      dragging = true;
      horizontalLock = false;
    },
    {
      passive: true,
    }
  );

  row.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;

      const touch =
        e.touches[0];

      const deltaX =
        touch.clientX -
        startX;

      const deltaY =
        touch.clientY -
        startY;

      if (!horizontalLock) {
        if (
          Math.abs(deltaX) >
            10 ||
          Math.abs(deltaY) >
            10
        ) {
          horizontalLock =
            Math.abs(
              deltaX
            ) >
            Math.abs(
              deltaY
            );
        }

        if (!horizontalLock) {
          return;
        }
      }

      e.preventDefault();

      dx = Math.max(
        -90,
        Math.min(
          90,
          deltaX
        )
      );

      bubble.style.transform =
        `translateX(${dx}px)`;

      bubble.style.transition =
        "none";

      row.classList.toggle(
        "swipe-armed",
        Math.abs(dx) >
          THRESHOLD
      );
    },
    {
      passive: false,
    }
  );

  row.addEventListener(
    "touchend",
    () => {
      if (!dragging) {
        return;
      }

      dragging = false;

      bubble.style.transition =
        "transform .2s ease";

      bubble.style.transform =
        "translateX(0)";

      row.classList.remove(
        "swipe-armed"
      );

      if (
        horizontalLock &&
        Math.abs(dx) >
          THRESHOLD
      ) {
        setReplyTarget(
          message
        );

        if (
          navigator.vibrate
        ) {
          navigator.vibrate(
            15
          );
        }
      }

      dx = 0;
    }
  );
}

/**
 * علامات حالة الرسالة (Ticks) — القاعدة المعتمدة:
 *
 *   ✓   صح واحد        : الرسالة حُفظت محلياً فقط — التطبيق أوفلاين أو في
 *                        الخلفية بلا ارتباط (لم يستلمها السيرفر بعد).
 *   ✓✓  صحّان رماديان  : السيرفر استلم الرسالة، أو وصل الإشعار لجهاز المستقبِل.
 *   ✓✓  صحّان أزرقان   : الطرف الآخر فتح المحادثة وقرأ الرسالة فعلاً.
 *
 * الحالات التي تصل من قاعدة البيانات: sent | delivered | read
 * والحالة المحلية الوحيدة قبل الإرسال الفعلي: pending (صندوق الصادر).
 */
function renderTicks(status) {
  const normalized = String(status || "").toLowerCase();

  // ✓✓ أزرق: قرأها الطرف الآخر فعلاً
  if (normalized === "read") {
    return `
      <span class="ticks ticks-read" title="تم القراءة">
        ✓✓
      </span>
    `;
  }

  // ✓✓ رمادي: وصلت السيرفر أو وصل إشعارها إلى جهاز المستقبِل
  if (normalized === "delivered" || normalized === "sent") {
    return `
      <span class="ticks ticks-delivered" title="${
        normalized === "delivered" ? "تم التسليم" : "أُرسلت"
      }">
        ✓✓
      </span>
    `;
  }

  // ✓ واحد: محفوظة محلياً (أوفلاين / في الخلفية) ولم يصلها السيرفر بعد
  return `
    <span class="ticks ticks-pending" title="في انتظار الإرسال">
      ✓
    </span>
  `;
}

function setReplyTarget(m) {
  state.replyingTo = m;

  $("#reply-preview-text").textContent =
    messagePreviewText(m);

  $("#reply-preview-bar")?.classList.remove(
    "hidden"
  );

  $("#composer-input")?.focus();
}

function clearReply() {
  state.replyingTo = null;

  $("#reply-preview-bar")?.classList.add(
    "hidden"
  );
}

async function toggleReaction(
  messageId,
  emoji
) {
  const existing =
    (
      state.reactions[
        messageId
      ] || []
    ).find(
      (r) =>
        r.user_id ===
          state.me.id &&
        r.emoji === emoji
    );

  if (existing) {
    await supabase
      .from(
        "message_reactions"
      )
      .delete()
      .eq(
        "id",
        existing.id
      );
  } else {
    await supabase
      .from(
        "message_reactions"
      )
      .insert({
        message_id:
          messageId,
        user_id:
          state.me.id,
        emoji,
      });
  }

  await loadReactionsForConversation();
}

function getSafeFileExtension(
  file,
  forcedExtension = null
) {
  if (forcedExtension) {
    return forcedExtension
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase();
  }

  const mime =
    (
      file?.type ||
      ""
    ).toLowerCase();

  const mimeMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",

    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
  };

  if (mimeMap[mime]) {
    return mimeMap[mime];
  }

  const originalName =
    file?.name || "";

  const match =
    originalName.match(
      /\.([a-zA-Z0-9]+)$/
    );

  if (match) {
    const ext =
      match[1]
        .toLowerCase()
        .replace(
          /[^a-z0-9]/g,
          ""
        );

    if (ext) {
      return ext;
    }
  }

  return "bin";
}

function createUploadUUID() {
  if (
    window.crypto &&
    typeof window.crypto.randomUUID ===
      "function"
  ) {
    return window.crypto.randomUUID();
  }

  return (
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
  ).replace(
    /[xy]/g,
    (c) => {
      const r =
        Math.random() * 16 | 0;

      const v =
        c === "x"
          ? r
          : (r & 0x3) | 0x8;

      return v.toString(16);
    }
  );
}

async function uploadMediaToSupabase(
  file,
  options = {}
) {
  if (!file) {
    throw new Error(
      "لم يتم اختيار ملف"
    );
  }

  if (!state.me) {
    throw new Error(
      "يجب تسجيل الدخول أولاً"
    );
  }

  if (!state.isOnline) {
    throw new Error(
      "لا يمكن رفع الوسائط أثناء عدم الاتصال بالإنترنت"
    );
  }

  const bucket =
    options.bucket ||
    "attachments";

  const folder =
    options.folder ||
    state.me.id;

  // ---- ضغط/تحسين الوسائط قبل الرفع (يوفّر الحزمة والذاكرة والتخزين) ----
  let uploadFile = file;
  let forcedExtension = options.extension;

  if (options.compress !== false) {
    const prepared = await prepareFileForUpload(file, options.compressOptions || {});

    uploadFile = prepared.file;

    if (prepared.extension) {
      forcedExtension = prepared.extension;
    }

    if (prepared.changed) {
      const saved = prepared.originalSize - prepared.size;
      const pct = prepared.originalSize
        ? Math.round((saved / prepared.originalSize) * 100)
        : 0;

      console.info(
        `[media] ضُغطت الصورة: ${formatBytes(prepared.originalSize)} → ${formatBytes(
          prepared.size
        )} (توفير ${pct}%)`
      );
    }
  }

  const extension =
    getSafeFileExtension(
      uploadFile,
      forcedExtension
    );

  const uuid =
    createUploadUUID();

  const storagePath =
    `${folder}/${uuid}.${extension}`;

  const contentType =
    uploadFile.type ||
    options.contentType ||
    "application/octet-stream";

  const {
    error,
  } = await supabase
    .storage
    .from(bucket)
    .upload(
      storagePath,
      uploadFile,
      {
        // الوسائط ثابتة المحتوى (اسم عشوائي فريد) → تخزين مؤقت طويل
        cacheControl:
          "31536000",
        contentType,
        upsert: false,
      }
    );

  if (error) {
    throw error;
  }

  const {
    data: publicData,
  } =
    supabase
      .storage
      .from(bucket)
      .getPublicUrl(
        storagePath
      );

  const publicUrl =
    publicData?.publicUrl;

  if (!publicUrl) {
    throw new Error(
      "تم رفع الملف ولكن تعذر الحصول على الرابط العام"
    );
  }

  return {
    path: storagePath,
    publicUrl,
    contentType,
    extension,
    size: uploadFile.size,
  };
}

function getMediaUploadStatusElement() {
  if (
    state.mediaUploadStatusElement &&
    document.body.contains(
      state.mediaUploadStatusElement
    )
  ) {
    return state.mediaUploadStatusElement;
  }

  let el =
    document.querySelector(
      "#media-upload-status"
    );

  if (!el) {
    el =
      document.createElement(
        "div"
      );

    el.id =
      "media-upload-status";

    el.className =
      "media-upload-status hidden";

    el.setAttribute(
      "role",
      "status"
    );

    el.setAttribute(
      "aria-live",
      "polite"
    );

    const composer =
      document.querySelector(
        "#composer-form"
      );

    if (composer) {
      composer.appendChild(
        el
      );
    } else {
      document.body.appendChild(
        el
      );
    }
  }

  state.mediaUploadStatusElement =
    el;

  return el;
}

function setMediaUploadingState(
  active,
  message = ""
) {
  state.mediaUploading =
    active;

  const status =
    getMediaUploadStatusElement();

  status.textContent =
    message ||
    "جاري رفع الوسائط...";

  status.classList.toggle(
    "hidden",
    !active
  );

  const attachInput =
    $("#attach-input");

  if (attachInput) {
    attachInput.disabled =
      active;
  }

  const micBtn =
    $("#mic-btn");

  if (micBtn) {
    micBtn.disabled =
      active;
  }

  const submitBtn =
    $("#composer-form button[type='submit']");

  if (submitBtn) {
    submitBtn.disabled =
      active;
  }

  document.body.classList.toggle(
    "media-uploading",
    active
  );
}

async function sendMessage({
  content,
  attachmentFile = null,
  attachmentType = null,
  attachmentUrl = null,
  attachmentExtension = null,
}) {
  const conv =
    state.activeConversation;

  if (!conv) return;

  if (state.mediaUploading) {
    return;
  }

  const replyToId =
    state.replyingTo?.id ||
    null;

  if (
    !state.isOnline &&
    !attachmentFile &&
    !attachmentUrl
  ) {
    const optimistic = {
      id: `local-${Date.now()}`,
      conversation_id:
        conv.id,
      sender_id:
        state.me.id,
      content:
        content || null,
      attachment_url:
        null,
      attachment_type:
        null,
      reply_to_id:
        replyToId,
      status:
        "pending",
      created_at:
        new Date().toISOString(),
      _pending:
        true,
    };

    state.messages.push(
      optimistic
    );

    renderMessages();

    const queued = await safeAsync("outbox:queue", () =>
      queueOutboxMessage({
        conversation_id: conv.id,
        sender_id: state.me.id,
        content: content || null,
        attachment_url: null,
        attachment_type: null,
        reply_to_id: replyToId,
      })
    );

    if (!queued.ok) {
      // التخزين المحلي غير متاح → أبلغ المستخدم بدل الإيهام بالإرسال
      optimistic.status = "failed";
      optimistic._failed = true;
      renderMessages();

      showAuthError(
        "تعذّر حفظ الرسالة للإرسال لاحقاً — أعد المحاولة بعد عودة الاتصال."
      );
    }

    clearReply();

    return;
  }

  if (
    !state.isOnline &&
    attachmentFile
  ) {
    showAuthError(
      "لا يمكن رفع الصورة أو الوسائط بدون اتصال بالإنترنت. أعد المحاولة بعد عودة الاتصال."
    );

    return;
  }

  let finalAttachmentUrl =
    attachmentUrl;

  let finalAttachmentType =
    attachmentType;

  if (attachmentFile) {
    try {
      const isImage =
        attachmentType ===
        "image";

      const isAudio =
        attachmentType ===
        "audio";

      setMediaUploadingState(
        true,
        isImage
          ? "جاري رفع الصورة، يرجى الانتظار..."
          : isAudio
          ? "جاري رفع الرسالة الصوتية، يرجى الانتظار..."
          : "جاري رفع الملف، يرجى الانتظار..."
      );

      const uploaded =
        await uploadMediaToSupabase(
          attachmentFile,
          {
            bucket:
              "attachments",
            folder:
              state.me.id,
            extension:
              attachmentExtension,
            contentType:
              attachmentFile.type,
            // لا تضغط الرسائل الصوتية (مضغوطة أصلاً) — الصور فقط
            compress:
              attachmentType !== "audio",
            compressOptions:
              MEDIA_PRESETS.attachment,
          }
        );

      finalAttachmentUrl =
        uploaded.publicUrl;

      finalAttachmentType =
        attachmentType ||
        (
          attachmentFile.type.startsWith(
            "image/"
          )
            ? "image"
            : attachmentFile.type.startsWith(
                "audio/"
              )
            ? "audio"
            : "file"
        );
    } catch (error) {
      console.error(
        "Media upload failed:",
        error
      );

      showAuthError(
        "فشل رفع الوسائط: " +
          (
            error?.message ||
            "خطأ غير معروف"
          )
      );

      return;
    } finally {
      setMediaUploadingState(
        false
      );
    }
  }

  if (
    attachmentFile &&
    !finalAttachmentUrl
  ) {
    showAuthError(
      "لم يكتمل رفع الوسائط، لذلك لم يتم إرسال الرسالة."
    );

    return;
  }

  // إرسال متفائل (Optimistic UI): تظهر الرسالة فوراً بعلامة 🕓 ثم تُستبدل
  // بنسخة الخادم عند وصول حدث Realtime أو رد الإدراج — يزيل الإحساس بالتأخير.
  const optimisticId = `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const optimistic = {
    id: optimisticId,
    conversation_id: conv.id,
    sender_id: state.me.id,
    content: content || null,
    attachment_url: finalAttachmentUrl || null,
    attachment_type: finalAttachmentType || null,
    reply_to_id: replyToId,
    status: "pending",
    created_at: new Date().toISOString(),
    _pending: true,
  };
  state.messages.push(optimistic);
  renderMessages();
  clearReply();

  const {
    data: inserted,
    error,
  } = await supabase
    .from("messages")
    .insert({
      conversation_id:
        conv.id,
      sender_id:
        state.me.id,
      content:
        content || null,
      attachment_url:
        finalAttachmentUrl ||
        null,
      attachment_type:
        finalAttachmentType ||
        null,
      reply_to_id:
        replyToId,
      status:
        "sent",
    })
    .select(MESSAGE_COLUMNS)
    .maybeSingle();

  if (error) {
    // فشل شبكة → خزّن في صندوق الصادر ليُرسل تلقائياً لاحقاً
    const networkish = /failed to fetch|network|timeout|abort/i.test(error.message || "") || !navigator.onLine;
    if (networkish) {
      const queued = await safeAsync("outbox:queue-fallback", () =>
        queueOutboxMessage({
          conversation_id: conv.id,
          sender_id: state.me.id,
          content: content || null,
          attachment_url: finalAttachmentUrl || null,
          attachment_type: finalAttachmentType || null,
          reply_to_id: replyToId,
        })
      );
      if (queued.ok) {
        showAuthError("تعذّر الإرسال الآن — ستُرسل الرسالة تلقائياً عند استقرار الاتصال.");
        return;
      }
    }
    state.messages = state.messages.filter((m) => m.id !== optimisticId);
    renderMessages({ keepScroll: true });
    showAuthError(error.message);
    return;
  }

  if (state.activeConversation?.id === conv.id) {
    const idx = state.messages.findIndex((m) => m.id === optimisticId);
    const already = inserted && state.messages.some((m) => m.id === inserted.id);
    if (idx > -1) {
      if (inserted && !already) state.messages[idx] = inserted;
      else state.messages.splice(idx, 1);
      renderMessages({ keepScroll: true });
    }
    if (inserted) safeAsync("cache:sent", () => cacheMessages(conv.id, [inserted]));
  }

  const preview =
    content ||
    messagePreviewText({
      attachment_type:
        finalAttachmentType,
    });

  try {
    const { error: convUpdateError } = await supabase
      .from("conversations")
      .update({
        last_message:
          preview,
        last_message_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        conv.id
      );

    if (convUpdateError) {
      console.error(
        "تعذّر تحديث معاينة آخر رسالة:",
        convUpdateError
      );
    }
  } catch (err) {
    console.error(
      "خطأ شبكة أثناء تحديث المحادثة:",
      err
    );
  }

  await setTyping(false);
}

async function handleAttachmentUpload(e) {
  const file =
    e.target.files?.[0];

  const resetInput = () => {
    e.target.value = "";
  };

  if (
    !file ||
    !state.activeConversation
  ) {
    resetInput();
    return;
  }

  if (state.mediaUploading) {
    resetInput();
    return;
  }

  let type = "file";

  if (
    file.type &&
    file.type.startsWith(
      "image/"
    )
  ) {
    type = "image";
  } else if (
    file.type &&
    file.type.startsWith(
      "audio/"
    )
  ) {
    type = "audio";
  }

  await sendMessage({
    content: null,
    attachmentFile: file,
    attachmentType: type,
  });

  resetInput();
}

async function handleAvatarUpload(e) {
  const file =
    e.target.files?.[0];

  if (!file) return;

  try {
    setMediaUploadingState(
      true,
      "جاري رفع الصورة الشخصية..."
    );

    const uploaded =
      await uploadMediaToSupabase(
        file,
        {
          bucket:
            "avatars",
          folder:
            state.me.id,
          compressOptions:
            MEDIA_PRESETS.avatar,
        }
      );

    await supabase
      .from("profiles")
      .update({
        avatar_url:
          uploaded.publicUrl,
      })
      .eq(
        "id",
        state.me.id
      );

    state.me.avatar_url =
      uploaded.publicUrl;

    if ($("#my-avatar")) {
      $("#my-avatar").src =
        uploaded.publicUrl;
    }
  } catch (error) {
    console.error(
      "Avatar upload failed:",
      error
    );

    showAuthError(
      "فشل رفع الصورة الشخصية: " +
        (
          error?.message ||
          "خطأ غير معروف"
        )
    );
  } finally {
    setMediaUploadingState(
      false
    );

    e.target.value = "";
  }
}

async function handleWallpaperUpload(e) {
  const file =
    e.target.files?.[0];

  if (!file) return;

  try {
    setMediaUploadingState(
      true,
      "جاري رفع خلفية المحادثة..."
    );

    const uploaded =
      await uploadMediaToSupabase(
        file,
        {
          bucket:
            "wallpapers",
          folder:
            state.me.id,
          compressOptions:
            MEDIA_PRESETS.wallpaper,
        }
      );

    await supabase
      .from("profiles")
      .update({
        wallpaper_url:
          uploaded.publicUrl,
      })
      .eq(
        "id",
        state.me.id
      );

    state.me.wallpaper_url =
      uploaded.publicUrl;

    applyThemeVars();
  } catch (error) {
    console.error(
      "Wallpaper upload failed:",
      error
    );

    showAuthError(
      "فشل رفع خلفية المحادثة: " +
        (
          error?.message ||
          "خطأ غير معروف"
        )
    );
  } finally {
    setMediaUploadingState(
      false
    );

    e.target.value = "";
  }
}

async function toggleRecording() {
  if (state.recording) {
    await stopAndSendRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (!state.activeConversation) {
    return;
  }

  if (
    !navigator.mediaDevices ||
    !window.MediaRecorder
  ) {
    showAuthError(
      "التسجيل الصوتي غير مدعوم في هذا المتصفح"
    );

    return;
  }

  if (!state.isOnline) {
    showAuthError(
      "لا يمكن رفع الرسالة الصوتية أثناء عدم الاتصال بالإنترنت."
    );

    return;
  }

  try {
    const stream =
      await navigator.mediaDevices.getUserMedia(
        {
          audio: true,
        }
      );

    const mediaRecorder =
      new MediaRecorder(
        stream
      );

    const chunks = [];

    mediaRecorder.ondataavailable =
      (e) => {
        if (e.data?.size) {
          chunks.push(
            e.data
          );
        }
      };

    mediaRecorder.start();

    state.recording = {
      mediaRecorder,
      chunks,
      stream,
      seconds: 0,
      timerInterval:
        null,
    };

    $("#recording-bar")?.classList.remove(
      "hidden"
    );

    $("#composer-input")?.classList.add(
      "hidden"
    );

    $("#mic-btn").textContent =
      "✅";

    $("#mic-btn")?.classList.add(
      "recording-active"
    );

    state.recording.timerInterval =
      setInterval(() => {
        if (!state.recording) {
          return;
        }

        state.recording.seconds +=
          1;

        const mm =
          String(
            Math.floor(
              state.recording
                .seconds /
                60
            )
          ).padStart(
            2,
            "0"
          );

        const ss =
          String(
            state.recording
              .seconds %
              60
          ).padStart(
            2,
            "0"
          );

        $("#recording-timer").textContent =
          `${mm}:${ss}`;
      }, 1000);
  } catch (err) {
    console.error(
      "Microphone error:",
      err
    );

    showAuthError(
      "لم يتم منح إذن الوصول للميكروفون"
    );
  }
}

async function stopAndSendRecording() {
  const rec =
    state.recording;

  if (!rec) return;

  const blob =
    await finalizeRecording(
      rec
    );

  resetRecordingUI();

  if (!blob) return;

  await sendMessage({
    content: null,
    attachmentFile: blob,
    attachmentType: "audio",
    attachmentExtension:
      "webm",
  });
}

function cancelRecording() {
  const rec =
    state.recording;

  if (!rec) return;

  finalizeRecording(
    rec,
    true
  );

  resetRecordingUI();
}

function finalizeRecording(
  rec,
  discard = false
) {
  return new Promise(
    (resolve) => {
      clearInterval(
        rec.timerInterval
      );

      rec.mediaRecorder.onstop =
        () => {
          rec.stream
            .getTracks()
            .forEach((t) =>
              t.stop()
            );

          if (discard) {
            resolve(null);
            return;
          }

          const mime =
            rec.mediaRecorder
              .mimeType ||
            "audio/webm";

          resolve(
            new Blob(
              rec.chunks,
              {
                type: mime,
              }
            )
          );
        };

      if (
        rec.mediaRecorder
          .state !==
        "inactive"
      ) {
        rec.mediaRecorder.stop();
      } else {
        resolve(null);
      }
    }
  );
}

function resetRecordingUI() {
  state.recording = null;

  $("#recording-bar")?.classList.add(
    "hidden"
  );

  if (
    $("#recording-timer")
  ) {
    $("#recording-timer").textContent =
      "00:00";
  }

  $("#composer-input")?.classList.remove(
    "hidden"
  );

  if ($("#mic-btn")) {
    $("#mic-btn").textContent =
      "🎤";

    $("#mic-btn").classList.remove(
      "recording-active"
    );
  }
}

async function flushOutbox() {
  if (!state.me || !state.isOnline) return;

  const result = await safeAsync("outbox:read", () => getOutbox(), { fallback: [] });

  const pending = result.data || [];

  if (!pending.length) {
    return;
  }

  for (const item of pending) {
    const {
      local_id,
      queued_at,
      ...msg
    } = item;

    const {
      error,
    } = await supabase
      .from("messages")
      .insert({
        ...msg,
        status: "sent",
      });

    if (!error) {
      await safeAsync("outbox:remove", () => removeFromOutbox(local_id));

      await supabase
        .from("conversations")
        .update({
          last_message:
            msg.content ||
            messagePreviewText({
              attachment_type:
                msg.attachment_type,
            }),

          last_message_at:
            new Date().toISOString(),
        })
        .eq(
          "id",
          msg.conversation_id
        );
    }
  }

  if (state.activeConversation) {
    state.messages =
      state.messages.filter(
        (m) =>
          !m._pending
      );

    await loadMessages(
      state.activeConversation
        .id
    );
  }
}

/** يغلق قناة (مرنة أو خام) بأمان ويُفرّغ مكانها في الحالة */
function teardownChannel(key) {
  const holder = state[key];
  if (!holder) return;

  state[key] = null;

  try {
    if (typeof holder.stop === "function") {
      holder.stop(); // قناة مرنة: تُلغي إعادة المحاولات وتُغلق القناة الداخلية
    } else {
      supabase.removeChannel(holder);
    }
  } catch (error) {
    console.warn(`[realtime] تعذّر إغلاق ${key}:`, error);
  }
}

/**
 * إعادة بناء كل اشتراكات Realtime بعد انقطاع/تجميد.
 * تُستدعى عند: العودة للمقدمة، resume، عودة الشبكة، أو نبضة اليقظة.
 * مُسلسَلة عبر realtimeResubscribePromise لمنع إنشاء قنوات بنفس الـ topic بالتوازي.
 */
function resubscribeRealtime(reason = "manual") {
  if (!state.me) return Promise.resolve();
  if (state.realtimeResubscribePromise) return state.realtimeResubscribePromise;

  console.log(`[realtime] إعادة بناء الاشتراكات (${reason})`);

  state.realtimeResubscribePromise = (async () => {
    // 0) تأكد أن الاتصال الأساسي حيّ قبل إعادة الاشتراك
    ensureRealtimeConnected(supabase);

    // removeChannel غير متزامنة — لا نربط مستمعي قناة جديدة قبل إغلاق القديمة
    teardownChannel("presenceChannel");
    subscribeGlobalPresence();

    teardownChannel("inboxChannel");
    subscribeInboxUpdates();

    teardownChannel("globalMsgChannel");
    subscribeGlobalMessageWatch();

    if (!isCallActive()) {
      teardownChannel("callsChannel");
      subscribeCallRoomsWatch();

      try {
        unsubscribeFromIncomingCalls();
        subscribeToIncomingCalls();
      } catch (error) {
        console.warn("[realtime] تعذّر إعادة الاشتراك بقناة المكالمات:", error);
      }
    }

    if (state.activeConversation) {
      state.subscribedConversationId = null;
      subscribeToConversation(state.activeConversation.id);
      await loadMessages(state.activeConversation.id, { silent: true });
    }
  })()
    .catch((error) => {
      console.warn("[realtime] فشل إعادة بناء الاشتراكات:", error);
    })
    .finally(() => {
      state.realtimeResubscribePromise = null;
    });

  return state.realtimeResubscribePromise;
}

/**
 * الاشتراك في قنوات المحادثة المفتوحة (رسائل + "يكتب الآن" + تفاعلات).
 *
 * كل قناة تُبنى عبر createResilientChannel: إن سقطت (CHANNEL_ERROR/TIMED_OUT)
 * تُعاد تلقائياً بخلفية تصاعدية بدل أن تبقى المحادثة "صامتة" حتى يتفاعل
 * المستخدم. والاشتراك متكرّر الأمان (idempotent) لنفس المحادثة.
 */
function subscribeToConversation(
  conversationId
) {
  if (!conversationId || !state.me) return;

  // نفس المحادثة وقناة حيّة → لا تُهدر إعادة اشتراك
  if (state.subscribedConversationId === conversationId && state.msgChannel?.channel) {
    return;
  }

  teardownChannel("msgChannel");
  teardownChannel("typingChannel");
  teardownChannel("reactionsChannel");

  state.subscribedConversationId = conversationId;

  const isActive = () => state.activeConversation?.id === conversationId;

  state.msgChannel = createResilientChannel(supabase, {
    topic: `messages:${conversationId}`,
    label: `messages:${conversationId}`,
    handlers: [
      {
        type: "postgres_changes",
        filter: {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        callback: async (payload) => {
          if (!payload?.new || !isActive()) return;

          const exists = state.messages.some((m) => m.id === payload.new.id);

          if (!exists) {
            // أزل النسخة المحلية المؤقتة المطابقة (نفس المحتوى من نفس المرسل)
            if (payload.new.sender_id === state.me.id) {
              const i = state.messages.findIndex(
                (m) => m._pending && m.content === payload.new.content
              );
              if (i > -1) state.messages.splice(i, 1);
            }
            state.messages.push(payload.new);
            state.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
          }

          // إن كانت رسالة الإشعار المفتوح قد وصلت للتوّ → مرّر إليها
          if (state.focusMessageId && payload.new.id === state.focusMessageId) {
            state.focusMessageId = null;
            setTimeout(() => scrollToMessage(payload.new.id), 60);
          }

          renderMessages();

          cacheMessages(conversationId, [payload.new]);

          if (payload.new.sender_id !== state.me.id) {
            if (payload.new.message_type !== "call") playNotificationSound();

            if (document.visibilityState === "visible") {
              // فتح المحادثة = قراءة: صفّر العدّاد فوراً وثبّتها على الخادم
              await markConversationRead(conversationId);
            } else {
              // التبويب مخفي: وصلت الرسالة إلينا فعلاً ⇒ "تم التسليم" فقط،
              // ولا نعلن القراءة قبل أن يرى المستخدم الشاشة.
              await markMessagesDelivered(conversationId);
            }
          }
        },
      },
      {
        type: "postgres_changes",
        filter: {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        callback: (payload) => {
          if (!payload?.new || !isActive()) return;

          const idx = state.messages.findIndex((m) => m.id === payload.new.id);

          if (idx > -1) {
            state.messages[idx] = payload.new;
            cacheMessages(conversationId, [payload.new]);
          }

          renderMessages({ keepScroll: true });
        },
      },
      {
        type: "postgres_changes",
        filter: {
          event: "DELETE",
          schema: "public",
          table: "messages",
        },
        callback: (payload) => {
          const id = payload.old?.id;
          if (!id) return;
          const before = state.messages.length;
          state.messages = state.messages.filter((m) => m.id !== id);
          safeAsync("cache:rt-delete", () => removeCachedMessage(id));
          if (state.messages.length !== before) renderMessages({ keepScroll: true });
        },
      },
    ],
    onStatus: (status, error) => {
      if (status === "SUBSCRIBED") {
        // بعد كل (إعادة) اتصال: اسحب ما فات في هذه المحادثة فوراً
        if (isActive() && state.isOnline) {
          safeAsync("thread:resync", async () => {
            await loadMessages(conversationId, { silent: true });
            await markConversationRead(conversationId, { force: true });
          });
        }
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[realtime] قناة المحادثة ${conversationId}: ${status}`, error || "");
      }
    },
  });

  state.typingChannel = createResilientChannel(supabase, {
    topic: `typing:${conversationId}`,
    label: `typing:${conversationId}`,
    handlers: [
      {
        type: "postgres_changes",
        filter: {
          event: "*",
          schema: "public",
          table: "typing_status",
          filter: `conversation_id=eq.${conversationId}`,
        },
        callback: (payload) => {
          const row = payload.new;
          if (row && row.user_id !== state.me.id && isActive()) {
            $("#typing-indicator")?.classList.toggle("hidden", !row.is_typing);
          }
        },
      },
    ],
    onStatus: (status) => {
      // مؤشّر "يكتب الآن" يجب ألّا يبقى عالقاً بعد انقطاع القناة
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        safeDom("typing:reset", () => $("#typing-indicator")?.classList.add("hidden"));
      }
    },
  });

  state.reactionsChannel = createResilientChannel(supabase, {
    topic: `reactions:${conversationId}`,
    label: `reactions:${conversationId}`,
    handlers: [
      {
        type: "postgres_changes",
        filter: {
          event: "*",
          schema: "public",
          table: "message_reactions",
        },
        callback: (payload) => {
          const row = payload.new || payload.old;
          if (row && isActive() && state.messages.some((m) => m.id === row.message_id)) {
            loadReactionsForConversation();
          }
        },
      },
    ],
  });
}

const PENDING_READS_KEY = "wa_pending_reads";
const readRequestsInFlight = new Map();
const unreadReconcileQueue = new Set();
let unreadReconcileTimer = null;

function loadPendingReads() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_READS_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function savePendingReads(set) {
  try {
    localStorage.setItem(PENDING_READS_KEY, JSON.stringify([...set].slice(-40)));
  } catch {
    /* التخزين ممتلئ/معطّل — نتجاهل */
  }
}

function queuePendingRead(conversationId) {
  if (!conversationId) return;
  const pending = loadPendingReads();
  if (!pending.has(conversationId)) {
    pending.add(conversationId);
    savePendingReads(pending);
  }
}

function unqueuePendingRead(conversationId) {
  const pending = loadPendingReads();
  if (pending.delete(conversationId)) savePendingReads(pending);
}

/** يحدّث حالة الرسائل محلياً إلى "مقروءة" فتظهر علامتا القراءة فوراً */
function markLocalMessagesRead(conversationId) {
  if (!state.me) return;

  const updated = [];
  state.messages.forEach((m) => {
    if (m.conversation_id === conversationId && m.sender_id !== state.me.id && m.status !== "read") {
      m.status = "read";
      updated.push(m);
    }
  });

  if (!updated.length) return;

  safeAsync("cache:read-status", () => cacheMessages(conversationId, updated));

  if (state.activeConversation?.id === conversationId) {
    renderMessages({ keepScroll: true });
  }
}

/**
 * تصفير عدّاد غير المقروء لمحادثة + إبلاغ الخادم بأن الرسائل قُرئت.
 *
 * الترتيب مقصود:
 *   1) تصفير فوري في الواجهة (شارة + إجماليات) — لا ينتظر الشبكة إطلاقاً.
 *   2) إغلاق إشعارات هذه المحادثة من شريط النظام.
 *   3) تسجيل "نية القراءة" في localStorage — فإن فشل الطلب أو كان الجهاز
 *      دون اتصال تُنفَّذ عند أول عودة للشبكة (flushPendingReads).
 *   4) طلب تحديث واحد لكل محادثة (مع منع الطلبات المتزامنة المكرّرة).
 *
 * @returns {Promise<boolean>} نجاح التثبيت على الخادم
 */
async function markConversationRead(conversationId, { force = false } = {}) {
  if (!conversationId || !state.me) return false;

  resetUnreadFor(conversationId);
  closeConversationNotifications(conversationId);
  queuePendingRead(conversationId);

  if (!state.isOnline) return false;

  const inFlight = readRequestsInFlight.get(conversationId);
  if (inFlight && !force) return inFlight;

  const task = (async () => {
    // المسار المفضّل: دالة SQL واحدة تُعيد عدد الرسائل التي صُفّرت (ذرّية)
    const rpc = await safeQuery("markRead:rpc", () =>
      supabase.rpc("mark_conversation_read", { p_conversation_id: conversationId })
    );

    if (rpc.ok && rpc.data !== null && rpc.data !== undefined) {
      unqueuePendingRead(conversationId);
      markLocalMessagesRead(conversationId);
      return true;
    }

    // المسار الاحتياطي (لو لم تُنفَّذ migration v2.3 بعد)
    const { ok, error } = await safeQuery("markRead", () =>
      supabase
        .from("messages")
        .update({ status: "read" })
        .eq("conversation_id", conversationId)
        .neq("sender_id", state.me.id)
        .neq("status", "read")
    );

    if (!ok) {
      console.warn("[unread] فشل تثبيت القراءة — ستُعاد المحاولة تلقائياً:", error?.message || error);
      return false;
    }

    unqueuePendingRead(conversationId);
    markLocalMessagesRead(conversationId);
    return true;
  })()
    .catch((err) => {
      console.warn("[unread] خطأ شبكة أثناء تثبيت القراءة:", err);
      return false;
    })
    .finally(() => readRequestsInFlight.delete(conversationId));

  readRequestsInFlight.set(conversationId, task);
  return task;
}

/**
 * ✓✓ رمادي (تم التسليم): يثبّت أن رسائل هذه المحادثة الواردة إلينا وصلت
 * فعلاً إلى هذا الجهاز (Realtime، أو مزامنة العودة، أو وصول إشعار FCM).
 *
 * لماذا نثبّتها على السيرفر؟ لأن المرسل يرى العلامات من قاعدة البيانات؛
 * فبدون هذا التحديث تبقى رسائله على ✓ واحد رغم وصولها فعلاً.
 */
const deliveredRequestsInFlight = new Map();

async function markMessagesDelivered(conversationId, { force = false } = {}) {
  if (!conversationId || !state.me || !state.isOnline) return false;
  if (!force && deliveredRequestsInFlight.has(conversationId)) {
    return deliveredRequestsInFlight.get(conversationId);
  }

  const task = (async () => {
    // المسار المفضّل: دالة واحدة ذرّية (migration v2.4)
    const rpc = await safeQuery("delivered:rpc", () =>
      supabase.rpc("mark_messages_delivered", { p_conversation_id: conversationId })
    );

    if (rpc.ok && rpc.data !== null && rpc.data !== undefined) return true;

    // مسار احتياطي: تحديث مباشر لا يمسّ إلا الرسائل الواردة غير المسلَّمة
    const { ok, error } = await safeQuery("delivered:update", () =>
      supabase
        .from("messages")
        .update({ status: "delivered" })
        .eq("conversation_id", conversationId)
        .neq("sender_id", state.me.id)
        .eq("status", "sent")
    );

    if (!ok) {
      console.warn("[status] تعذّر تثبيت حالة التسليم:", error?.message || error);
      return false;
    }
    return true;
  })()
    .catch(() => false)
    .finally(() => {
      // امنع تكرار الطلب لنفس المحادثة خلال 10 ثوانٍ (كل رسالة تُطلق الطلب)
      setTimeout(() => deliveredRequestsInFlight.delete(conversationId), 10000);
    });

  deliveredRequestsInFlight.set(conversationId, task);
  return task;
}

/**
 * تصحيح جماعي لعلامات التسليم بعد أي انقطاع/سكون: أي رسالة واردة إلينا
 * وبقيت على ✓ واحد تُعلَّم ✓✓. تُستدعى عند الدخول وعند كل مزامنة عودة.
 */
let lastDeliveredSweepAt = 0;

async function sweepDeliveredMessages({ force = false } = {}) {
  if (!state.me || !state.isOnline) return false;
  if (!force && Date.now() - lastDeliveredSweepAt < 60000) return false;
  lastDeliveredSweepAt = Date.now();

  const rpc = await safeQuery("delivered:sweep", () =>
    supabase.rpc("mark_all_messages_delivered")
  );
  if (rpc.ok) return true;

  // مسار احتياطي (قبل تنفيذ الترقية): لكل محادثة معروفة على حدة
  const ids = Object.keys(state.contactRowsByConversation || {});
  for (const id of ids.slice(0, 20)) {
    await markMessagesDelivered(id, { force: true });
  }
  return false;
}

/** ينفّذ عمليات القراءة المؤجّلة (بعد عودة الشبكة أو العودة للمقدمة) */
async function flushPendingReads() {
  if (!state.me || !state.isOnline) return 0;

  const pending = [...loadPendingReads()];
  if (!pending.length) return 0;

  let done = 0;
  for (const conversationId of pending.slice(0, 10)) {
    const ok = await markConversationRead(conversationId, { force: true });
    if (ok) done += 1;
  }
  return done;
}

function handleTypingInput() {
  setTyping(true);

  clearTimeout(
    state.typingTimeout
  );

  state.typingTimeout =
    setTimeout(
      () =>
        setTyping(false),
      2000
    );
}

async function setTyping(
  isTyping
) {
  const conv =
    state.activeConversation;

  if (!conv || !state.me || !state.isOnline) return;

  await safeQuery("setTyping", () =>
    supabase
    .from("typing_status")
    .upsert(
      {
        conversation_id:
          conv.id,
        user_id:
          state.me.id,
        is_typing:
          isTyping,
        updated_at:
          new Date().toISOString(),
      },
      {
        onConflict:
          "conversation_id,user_id",
      }
    )
  );
}

function subscribeGlobalPresence() {
  // Realtime throws when .on() is called after subscribe(). This guard also
  // prevents duplicate channels during repeated visibility/network events.
  if (state.presenceChannel || !state.me) return;

  state.presenceChannel = createResilientChannel(supabase, {
    topic: "presence:global",
    label: "presence",
    config: { config: { presence: { key: state.me.id } } },
    handlers: [
      {
        type: "presence",
        filter: { event: "sync" },
        // القناة تُمرَّر كوسيط ثانٍ — مهم لأن القناة تُبنى من جديد عند الإحياء
        callback: (payload, channel) => {
          let presState = {};
          try {
            presState = channel?.presenceState?.() || {};
          } catch {
            presState = {};
          }

          state.onlineMap = {};
          Object.keys(presState).forEach((id) => {
            state.onlineMap[id] = true;
          });

          // حضور المشرفين ثابت: نُثبّته هنا فيبقى "متصل الآن" ظاهراً عند
          // المستخدم العادي حتى لو خرج المشرف من قناة الحضور (سكون/خلفية).
          (state.contacts || []).forEach((c) => {
            if (c?.id && isAdminContact(c.id, c)) state.onlineMap[c.id] = true;
          });
          if (state.activeConversation?.otherProfile?.id) {
            const peer = state.activeConversation.otherProfile;
            if (isAdminContact(peer.id, peer)) state.onlineMap[peer.id] = true;
          }

          loadContacts();
          if (state.activeConversation) {
            refreshPresenceLabel(state.activeConversation.otherProfile.id);
          }
        },
      },
      {
        type: "presence",
        filter: { event: "leave" },
        callback: async ({ leftPresences = [] }) => {
          if (!state.activeConversation) return;

          const leftIds = leftPresences.map((presence) => presence.key).filter(Boolean);

          // مغادرة مشرف لقناة الحضور لا تعني أنه غير متصل: تُهمَل ولا تُغيّر
          // الحالة الظاهرة للمستخدم العادي.
          leftIds.forEach((id) => {
            if (isAdminContact(id)) state.onlineMap[id] = true;
          });

          if (
            leftIds.includes(state.activeConversation.otherProfile.id) &&
            !isAdminContact(state.activeConversation.otherProfile.id)
          ) {
            await refreshPresenceLabel(state.activeConversation.otherProfile.id);
          }
        },
      },
    ],
    onStatus: async (status, error, channel) => {
      if (status !== "SUBSCRIBED") {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[realtime] قناة الحضور:", status, error || "");
        }
        return;
      }

      // أعِد تسجيل الحضور بعد كل (إعادة) اشتراك — بدونه يبقى المستخدم
      // يبدو "غير متصل" للآخرين بعد أي انقطاع للقناة.
      try {
        const result = await channel.track({ online_at: new Date().toISOString() });
        if (result?.error) console.warn("[realtime] تعذّر تحديث حالة الحضور:", result.error);
      } catch (trackError) {
        console.warn("[realtime] خطأ في تتبّع الحضور:", trackError);
      }
    },
  });
}

async function refreshPresenceLabel(
  otherId
) {
  const label =
    $("#chat-header-status");

  if (!label) return;

  // "متصل الآن" ثابت ودائم لكل مشرف — لا يعتمد على قناة الحضور وحدها (قد
  // تتأخر أو تُقطع نبضتها عند سكون متصفح المشرف) بل على كونه مشرفاً.
  const peer =
    state.activeConversation?.otherProfile ||
    state.contacts?.find((c) => c.id === otherId) ||
    null;

  if (isAdminContact(otherId, peer)) {
    state.onlineMap[otherId] = true;
    label.textContent = state.t?.online || "متصل الآن";
    return;
  }

  if (
    state.onlineMap[
      otherId
    ]
  ) {
    label.textContent =
      state.t.online;

    return;
  }

  let profile = null;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("last_seen")
      .eq(
        "id",
        otherId
      )
      .single();

    if (error) {
      console.error("refreshPresenceLabel failed:", error);
    } else {
      profile = data;
    }
  } catch (err) {
    console.error("refreshPresenceLabel network error:", err);
  }

  if (profile?.last_seen) {
    const d =
      new Date(
        profile.last_seen
      );

    const time =
      d.toLocaleTimeString(
        state.lang ===
          "ar"
          ? "ar-SA"
          : "en-US",
        {
          hour:
            "2-digit",
          minute:
            "2-digit",
        }
      );

    const dateLabel =
      d.toDateString() ===
      new Date().toDateString()
        ? time
        : d.toLocaleDateString(
            state.lang ===
              "ar"
              ? "ar-SA"
              : "en-US"
          ) +
          " " +
          time;

    label.textContent =
      `${state.t.last_seen} ${dateLabel}`;
  } else {
    label.textContent =
      "";
  }
}

function subscribeInboxUpdates() {
  if (!state.me) return;

  state.inboxChannel = createResilientChannel(supabase, {
    topic: "inbox-updates",
    label: "inbox",
    handlers: [
      {
        type: "postgres_changes",
        filter: { event: "*", schema: "public", table: "conversations" },
        callback: (payload) => {
          const row = payload.new;
          if (row && (row.user_id === state.me.id || row.admin_id === state.me.id)) {
            // محادثة جديدة/تحديث آخر رسالة → أعِد الترتيب مع تصحيح العدّادات
            loadContacts();
          }
        },
      },
    ],
  });
}

/**
 * مراقبة كل الرسائل (عبر RLS: محادثات المستخدم فقط) — شبكة أمان لمؤشّر
 * غير المقروء وإن لم تكن المحادثة مفتوحة.
 *
 * ثلاثة أنواع أحداث:
 *   INSERT → زيادة فورية للعدّاد + صوت + إشعار نظام (إن لم تكن المحادثة مفتوحة).
 *   UPDATE → تغيّر حالة الرسالة (read/delivered) → إعادة احتساب العدّاد
 *            (يُهمّ عند فتح المحادثة من جهاز/تبويب آخر).
 *   DELETE → حذف إداري → إزالة أثر الرسالة من العدّاد.
 */
function subscribeGlobalMessageWatch() {
  if (!state.me) return;

  const reconcile = (conversationIds) => {
    const ids = [...new Set((conversationIds || []).filter(Boolean))];
    if (ids.length) scheduleUnreadReconcile(ids);
  };

  state.globalMsgChannel = createResilientChannel(supabase, {
    topic: "global-messages-watch",
    label: "global-messages",
    handlers: [
      {
        type: "postgres_changes",
        filter: { event: "INSERT", schema: "public", table: "messages" },
        callback: (payload) => {
          const msg = payload.new;
          if (!msg || msg.sender_id === state.me.id) return;

          const viewingThisThread =
            state.activeConversation &&
            msg.conversation_id === state.activeConversation.id &&
            document.visibilityState === "visible";

          // وصلتنا الرسالة فعلاً عبر Realtime ⇒ ✓✓ رمادي عند المرسل
          markMessagesDelivered(msg.conversation_id);

          if (viewingThisThread) {
            // المستخدم يقرأ المحادثة الآن → لا شارة ولا إزعاج
            resetUnreadFor(msg.conversation_id);
            markConversationRead(msg.conversation_id);
            return;
          }

          // RLS تضمن أن الرسائل الواصلة هنا تخص محادثات المستخدم فقط
          bumpUnreadBadge(msg.conversation_id, messagePreviewText(msg));

          if (msg.message_type !== "call") {
            playNotificationSound();
            void showLocalMessageNotification(msg);
          }
        },
      },
      {
        type: "postgres_changes",
        filter: { event: "UPDATE", schema: "public", table: "messages" },
        callback: (payload) => {
          const msg = payload.new;
          if (!msg || msg.sender_id === state.me.id) return; // رسائلي أنا → لا عدّاد
          reconcile([msg.conversation_id]);
        },
      },
      {
        type: "postgres_changes",
        filter: { event: "DELETE", schema: "public", table: "messages" },
        callback: (payload) => {
          const row = payload.old;
          if (!row) return;
          reconcile([row.conversation_id]);
        },
      },
    ],
    onStatus: (status, error) => {
      if (status === "SUBSCRIBED") {
        // بعد كل (إعادة) اشتراك: صحّح العدّادات (قد تكون تغيّرت أثناء الانقطاع)
        reconcile(Object.keys(state.contactRowsByConversation));
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("[realtime] قناة مراقبة الرسائل العامة:", status, error || "");
      }
    },
  });
}

/**
 * تصحيح مؤجَّل للعدّادات — يجمع الأحداث المتلاحقة (كثرة تحديثات الحالة)
 * في طلب واحد بعد 500 مللي ثانية بدل إغراق الشبكة.
 */
function scheduleUnreadReconcile(conversationIds) {
  (conversationIds || []).forEach((id) => unreadReconcileQueue.add(id));

  if (unreadReconcileTimer) return;
  unreadReconcileTimer = setTimeout(() => {
    unreadReconcileTimer = null;
    const ids = [...unreadReconcileQueue];
    unreadReconcileQueue.clear();
    if (!ids.length) return;
    safeAsync("unread:reconcile", () => refreshUnreadBadges(ids));
  }, 500);
}

/**
 * إشعار مرئي عبر Service Worker عند وصول رسالة لحظية (Realtime) والتطبيق مفتوح
 * لكن في تبويب آخر/محادثة أخرى — لا يعتمد على FCM، ويُلغى عند فتح المحادثة.
 */
async function showLocalMessageNotification(msg) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker) return;

    // لا تُزعج المستخدم وهو يقرأ نفس المحادثة أمام الشاشة
    if (
      state.activeConversation?.id === msg.conversation_id &&
      document.visibilityState === "visible"
    ) {
      return;
    }

    const sender = state.contacts.find((c) => c.id === msg.sender_id);
    const title = sender?.display_name || "رسالة جديدة";
    const body = messagePreviewText(msg) || "لديك رسالة جديدة";
    const reg =
      (await navigator.serviceWorker.getRegistration("./firebase-cloud-messaging-push-scope")) ||
      (await navigator.serviceWorker.getRegistration()) ||
      (await navigator.serviceWorker.ready);

    // فرصة أخيرة قبل العرض: قد يكون إشعار FCM وصل في نفس اللحظة وبنفس الـ tag
    const tag = `conversation-${msg.conversation_id}`;
    try {
      const existing = await reg.getNotifications({ tag });
      if (existing?.length) return;
    } catch {
      /* getNotifications غير مدعومة في بعض المتصفحات */
    }

    await reg.showNotification(title, {
      body,
      icon: sender?.avatar_url || "./icons/icon.png",
      badge: "./icons/icon.png",
      tag,
      renotify: true,
      // الصوت مسؤولية التطبيق حين يكون ظاهراً، أما في الخلفية فيجب أن
      // يُصدر النظام صوتاً وإلا بدا الإشعار صامتاً بلا معنى.
      silent: document.visibilityState === "visible",
      data: {
        conversationId: msg.conversation_id,
        messageId: msg.id,
        senderId: msg.sender_id,
        type: "new_message",
      },
    });
  } catch (err) {
    console.warn("showLocalMessageNotification failed:", err);
  }
}

async function closeConversationNotifications(conversationId) {
  try {
    if (!("serviceWorker" in navigator)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      const list = await reg.getNotifications({ tag: `conversation-${conversationId}` });
      list.forEach((n) => n.close());
    }
  } catch {
    /* تجاهل */
  }
}

function playNotificationSound() {
  const audio =
    $("#notification-sound");

  if (!audio) return;

  try {
    // لا تقطع نغمة رنين مكالمة جارية
    if (audio.loop) return;

    audio.currentTime = 0;

    const promise = audio.play();

    if (promise && typeof promise.catch === "function") {
      promise.catch(() => {});
    }
  } catch (err) {
    console.warn("playNotificationSound failed:", err);
  }
}

function wireEmojiPicker() {
  const btn =
    $("#emoji-toggle");

  const panel =
    $("#emoji-panel");

  if (!btn || !panel) {
    return;
  }

  if (
    panel.dataset.wired ===
    "1"
  ) {
    return;
  }

  panel.dataset.wired =
    "1";

  const emojis = [
    "😀",
    "😃",
    "😄",
    "😁",
    "😆",
    "😅",
    "😂",
    "🤣",
    "🥲",
    "🥹",
    "☺️",
    "😊",
    "😇",
    "🙂",
    "🙃",
    "😉",
    "😌",
    "😍",
    "🥰",
    "😘",
    "😗",
    "😙",
    "😚",
    "😋",
    "😛",
    "😝",
    "😜",
    "🤪",
    "🤨",
    "🧐",
    "🤓",
    "😎",
    "🥸",
    "🤩",
    "🥳",
    "😏",
    "😒",
    "😞",
    "😔",
    "😟",
    "😕",
    "🙁",
    "☹️",
    "😣",
    "😖",
    "😫",
    "😩",
    "🥺",
    "😢",
    "😭",
    "😮‍💨",
    "😤",
    "😠",
    "😡",
    "🤬",
    "🤯",
    "😳",
    "🥵",
    "🥶",
    "😱",
    "😨",
    "😰",
    "😥",
    "😓",
    "🫣",
    "🤗",
    "🫡",
    "🤔",
    "🤫",
    "🫠",
    "🤥",
    "😶",
    "😶‍🌫️",
    "😐",
    "😑",
    "😬",
    "🫨",
    "😯",
    "😦",
    "😧",
    "😮",
    "😲",
    "🥱",
    "😴",
    "🤤",
    "😪",
    "😵",
    "😵‍💫",
    "🤐",
    "🥴",
    "🤢",
    "🤮",
    "🤧",
    "😷",
    "🤒",

    "👍",
    "👎",
    "👏",
    "🙌",
    "🫶",
    "👐",
    "🤲",
    "🤝",
    "🙏",
    "✍️",
    "💅",
    "🤳",
    "💪",
    "🦾",
    "🖐️",
    "✋",
    "🤚",
    "👋",
    "🤙",
    "🤌",
    "🤏",
    "👌",
    "🫰",
    "✌️",
    "🤞",
    "🤟",
    "🤘",
    "👈",
    "👉",
    "👆",
    "🖕",
    "👇",
    "☝️",
    "🫵",
    "🤜",
    "🤛",

    "❤️",
    "🧡",
    "💛",
    "💚",
    "💙",
    "💜",
    "🖤",
    "🤍",
    "🤎",
    "💔",
    "❤️‍🔥",
    "❤️‍🩹",
    "❣️",
    "💕",
    "💞",
    "💓",
    "💗",
    "💖",
    "💘",
    "💝",
    "🫀",
    "✨",
    "💥",
    "🔥",

    "🎉",
    "🎊",
    "🎈",
    "🎂",
    "🎁",
    "⭐",
    "🌟",
    "💫",
    "💯",
    "✅",
    "❌",
    "⚠️",
    "☕",
    "🍕",
    "🍔",
    "🍟",
    "⚽",
    "🏀",
    "🚀",
    "📱",
    "💻",
    "📸",
    "🎵",
    "🎧",
  ];

  panel.innerHTML =
    emojis
      .map(
        (e) =>
          `<span class="emoji-opt">${e}</span>`
      )
      .join("");

  btn.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();

      panel.classList.toggle(
        "hidden"
      );
    }
  );

  panel.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();

      if (
        e.target.classList.contains(
          "emoji-opt"
        )
      ) {
        $("#composer-input").value +=
          e.target.textContent;

        panel.classList.add(
          "hidden"
        );

        $("#composer-input")?.focus();
      }
    }
  );

  document.addEventListener(
    "click",
    (e) => {
      if (
        !panel.classList.contains(
          "hidden"
        ) &&
        !panel.contains(
          e.target
        ) &&
        e.target !== btn
      ) {
        panel.classList.add(
          "hidden"
        );
      }
    }
  );
}

function setupPWAInstallPrompt() {
  window.addEventListener(
    "beforeinstallprompt",
    (event) => {

      event.preventDefault();

      state.deferredInstallPrompt =
        event;

      refreshPWAInstallButton();
    }
  );

  window.addEventListener(
    "appinstalled",
    () => {
      state.deferredInstallPrompt =
        null;

      hidePWAInstallButton();
    }
  );

  window.addEventListener(
    "DOMContentLoaded",
    () => {
      refreshPWAInstallButton();
    }
  );
}

function getOrCreatePWAInstallButton() {
  let button =
    document.querySelector(
      "#install-app-btn"
    );

  if (!button) {
    button =
      document.querySelector(
        "#pwa-install-btn"
      );
  }

  if (!button) {
    const authScreen =
      $("#auth-screen");

    if (!authScreen) {
      return null;
    }

    const wrapper =
      document.createElement(
        "div"
      );

    wrapper.className =
      "pwa-install-wrapper";

    wrapper.innerHTML = `
      <button
        type="button"
        id="install-app-btn"
        class="pwa-install-btn hidden"
      >
        📲 تثبيت التطبيق
      </button>
    `;

    authScreen.appendChild(
      wrapper
    );

    button =
      wrapper.querySelector(
        "#install-app-btn"
      );
  }

  if (
    button &&
    !button.dataset.wired
  ) {
    button.dataset.wired =
      "1";

    button.addEventListener(
      "click",
      installPWA
    );
  }

  state.installButton =
    button;

  return button;
}

function refreshPWAInstallButton() {
  const button =
    getOrCreatePWAInstallButton();

  if (!button) return;

  const installed =
    isPWAInstalled();

  const canInstall =
    !!state.deferredInstallPrompt;

  const authVisible =
    !$("#auth-screen")?.classList.contains(
      "hidden"
    );

  if (
    canInstall &&
    !installed &&
    authVisible
  ) {
    button.classList.remove(
      "hidden"
    );

    button.disabled =
      false;

    button.setAttribute(
      "aria-label",
      "تثبيت التطبيق"
    );
  } else {
    button.classList.add(
      "hidden"
    );
  }
}

function isPWAInstalled() {
  const standalone =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: standalone)"
    ).matches;

  const fullscreen =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: fullscreen)"
    ).matches;

  const minimalUi =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: minimal-ui)"
    ).matches;

  const iosStandalone =
    window.navigator.standalone ===
    true;

  return (
    standalone ||
    fullscreen ||
    minimalUi ||
    iosStandalone
  );
}

async function installPWA() {
  const prompt =
    state.deferredInstallPrompt;

  if (!prompt) {
    return;
  }

  const button =
    state.installButton ||
    getOrCreatePWAInstallButton();

  if (button) {
    button.disabled =
      true;

    button.textContent =
      "جاري فتح التثبيت...";
  }

  try {
    await prompt.prompt();

    const result =
      await prompt.userChoice;

    if (
      result?.outcome ===
      "accepted"
    ) {
      state.deferredInstallPrompt =
        null;

      hidePWAInstallButton();
    } else {

      state.deferredInstallPrompt =
        null;

      hidePWAInstallButton();
    }
  } catch (error) {
    console.error(
      "PWA install failed:",
      error
    );

    state.deferredInstallPrompt =
      null;

    hidePWAInstallButton();
  }
}

function hidePWAInstallButton() {
  const button =
    state.installButton ||
    document.querySelector(
      "#install-app-btn, #pwa-install-btn"
    );

  if (!button) return;

  button.classList.add(
    "hidden"
  );
}

/**
 * تسجيل Service Worker الواجهة (App Shell).
 *   • updateViaCache:"none" → المتصفح لا يستخدم نسخة مخزّنة من ملف الـ SW
 *     نفسه، فيصل أي إصلاح فوراً بدل أن يعلق المستخدم على نسخة قديمة لأسابيع.
 *   • عند توفّر نسخة جديدة نُفعّلها فوراً (SKIP_WAITING) حتى لا تنتظر
 *     إغلاق كل التبويبات — وهو سبب شائع لبقاء الأعطال بعد النشر.
 */
function registerAppShellWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker
    .register("./sw.js", { updateViaCache: "none" })
    .then((registration) => {
      registration.addEventListener?.("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    })
    .catch(() => {});
}

/** يطلب من المتصفح التحقق من وجود تحديث للـ SW (مرة كل ساعة كحد أقصى) */
function refreshServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const last = Number(localStorage.getItem("wa_sw_check_at") || 0);
  if (Date.now() - last < 60 * 60 * 1000) return;
  try {
    localStorage.setItem("wa_sw_check_at", String(Date.now()));
  } catch {
    /* تجاهل */
  }
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => registration?.update())
    .catch(() => {});
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", registerAppShellWorker);
}

/**
 * مقبض تشخيصي للدعم الفني (ويُستخدم في الاختبارات الآلية).
 * لا يكشف أي بيانات حسّاسة — فقط حالة الاتصال والعدّادات، لتشخيص مشاكل
 * "الإشعار لا يصل" أو "العدّاد لا يتصفّر" من وحدة تحكم المتصفح مباشرة:
 *   __waDiagnostics()
 */
window.__waDiagnostics = () => ({
  online: state.isOnline,
  visibility: document.visibilityState,
  me: state.me ? { id: state.me.id, is_admin: Boolean(state.me.is_admin) } : null,
  activeConversationId: state.activeConversation?.id || null,
  subscribedConversationId: state.subscribedConversationId,
  unread: { ...state.unreadByConversation },
  unreadTotal: totalUnreadCount(),
  pendingReads: [...loadPendingReads()],
  realtime: diagnoseRealtime(supabase),
  push: {
    ready: isPushReady(),
    lastTokenSyncAt: getLastTokenSyncAt(),
    foregroundListener: Boolean(state.foregroundMessagesUnsub),
  },
  background: {
    watchdogRunning: Boolean(state.realtimeWatchdog),
    hiddenCatchUpRunning: Boolean(state.hiddenCatchUpTimer),
  },
  // حالة الحضور الظاهرة (المشرفون مثبَّتون على "متصل الآن" دائماً)
  presence: {
    onlineIds: Object.keys(state.onlineMap || {}),
    adminPresenceForced: (state.contacts || [])
      .filter((c) => isAdminContact(c.id, c))
      .map((c) => c.id),
  },
});

// إقلاع آمن: وحدات ES تُنفَّذ مؤجَّلة، وقد يكون DOMContentLoaded قد أُطلق
// بالفعل (خصوصاً مع الـ Service Worker والتخزين المؤقت) فلا يُستدعى boot أبداً.
// لذلك نتحقق من جاهزية المستند بدل الاعتماد على الحدث وحده.
let bootStarted = false;

function startApp() {
  if (bootStarted) return;
  bootStarted = true;

  boot().catch((err) => {
    console.error("Fatal boot error:", err);

    // آخر خط دفاع: لا تترك المستخدم أمام شاشة تحميل لا تنتهي
    document.querySelector("#boot-loading")?.classList.add("hidden");
    document.querySelector("#auth-screen")?.classList.remove("hidden");

    const el = document.querySelector("#auth-error");
    if (el) {
      el.textContent = "تعذّر تشغيل التطبيق — يرجى تحديث الصفحة.";
      el.classList.remove("hidden");
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp, { once: true });
} else {
  startApp();
}
