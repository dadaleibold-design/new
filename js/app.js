import { supabase } from "./supabaseClient.js";
import { signUp, signIn, signOut, getCurrentProfile } from "./auth.js";
import { ADMINS } from "./config.js";
import { applyLanguage } from "./i18n.js";
import {
  cacheMessages,
  getCachedMessages,
  cacheContacts,
  getCachedContacts,
  queueOutboxMessage,
  getOutbox,
  removeFromOutbox,
} from "./db.js";
import {
  enablePushNotifications,
  disablePushNotifications,
  listenForForegroundMessages,
} from "./push.js";
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
  inboxChannel: null,
  globalMsgChannel: null,

  typingTimeout: null,
  onlineMap: {},
  heartbeatInterval: null,

  recording: null,

  isOnline: navigator.onLine,

  clickedWelcomeButtons: new Set(),

  deferredInstallPrompt: null,
  installButton: null,

  mediaUploading: false,
  mediaUploadStatusElement: null,

  foregroundMessagesUnsub: null,
};

const $ = (sel) => document.querySelector(sel);

async function boot() {
  document.body.setAttribute("data-theme", state.theme);

  setupPWAInstallPrompt();

  await loadChatPanelPartial();

  state.t = applyLanguage(state.lang);

  const {
    data: { session },
  } = await supabase.auth.getSession();

  wireAuthForms();
  wireChrome();

  $("#boot-loading")?.classList.add("hidden");

  if (session) {
    await enterApp();
  } else {
    showAuthScreen();
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      state.me = null;
      showAuthScreen();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (state.me) {
      navigator.sendBeacon &&
        navigator.sendBeacon("about:blank");
    }
  });

  document.addEventListener("visibilitychange", async () => {
    if (!state.me) return;

    if (document.visibilityState === "hidden") {
      await touchLastSeen(false);
    } else {
      await touchLastSeen(true);
      resubscribeRealtime();
    }
  });

  window.addEventListener("online", () => {
    state.isOnline = true;
    updateOfflineBanner();
    flushOutbox();
    resubscribeRealtime();
  });

  window.addEventListener("offline", () => {
    state.isOnline = false;
    updateOfflineBanner();
  });

  updateOfflineBanner();

  window.addEventListener("popstate", (event) => {
    if (!event.state || !event.state.waChat) {
      closeChatView();
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#back-to-list")) {
      if (history.state && history.state.waChat) {
        history.back();
      } else {
        closeChatView();
      }
    }
  });

  refreshPWAInstallButton();
}

window.addEventListener('pageshow', (event) => {
  if (event.persisted && supabase) {
    supabase.realtime.connect();
  }
});

window.addEventListener('pagehide', () => {
  if (supabase && supabase.realtime) {
    supabase.realtime.disconnect();
  }
});

function openConversationUIState(conversationId) {
  document.body.classList.add("viewing-chat");

  if (history.state && history.state.waChat) {
    history.replaceState(
      {
        waChat: true,
        conversationId,
      },
      "",
      "#chat"
    );
  } else {
    history.pushState(
      {
        waChat: true,
        conversationId,
      },
      "",
      "#chat"
    );
  }
}

function closeChatView() {
  document.body.classList.remove("viewing-chat");

  $("#chat-panel")?.classList.remove("mobile-visible");
  $("#sidebar")?.classList.remove("mobile-hidden");
}

function updateOfflineBanner() {
  const banner = $("#offline-banner");

  if (!banner) return;

  banner.classList.toggle("hidden", state.isOnline);
}

async function loadChatPanelPartial() {
  const res = await fetch("./partials/chat-panel.html");
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
  state.me = await getCurrentProfile();

  if (!state.me) {
    showAuthScreen();
    return;
  }

  $("#auth-screen")?.classList.add("hidden");
  $("#app-shell")?.classList.remove("hidden");

  $("#my-name").textContent = state.me.display_name;

  if (state.me.avatar_url) {
    $("#my-avatar").src = state.me.avatar_url;
  }

  applyThemeVars();

  await touchLastSeen(true);

  startHeartbeat();

  await loadContacts();

  subscribeGlobalPresence();
  subscribeInboxUpdates();
  subscribeGlobalMessageWatch();

  if (!state.foregroundMessagesUnsub) {
    try {
      state.foregroundMessagesUnsub = listenForForegroundMessages({
        onNotification: () => {

          loadContacts();
        },
      });
    } catch (err) {
      console.error("تعذّر تفعيل استماع رسائل FCM الأمامية:", err);
    }
  }

  if (state.isOnline) {
    flushOutbox();
  }
}

async function touchLastSeen(online) {
  if (!state.me) return;

  await supabase
    .from("profiles")
    .update({
      is_online: online,
      last_seen: new Date().toISOString(),
    })
    .eq("id", state.me.id);
}

function startHeartbeat() {
  clearInterval(state.heartbeatInterval);

  state.heartbeatInterval = setInterval(() => {
    if (document.visibilityState === "visible") {
      touchLastSeen(true);
    }
  }, 25000);
}

function wireAuthForms() {
  $("#tab-login")?.addEventListener("click", () => {
    switchAuthTab("login");
  });

  $("#tab-signup")?.addEventListener("click", () => {
    switchAuthTab("signup");
  });

  $("#login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;

    try {
      await signIn({
        email,
        password,
      });

      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    }
  });

  $("#signup-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = $("#signup-email").value.trim();
    const password = $("#signup-password").value;
    const displayName = $("#signup-name").value.trim();
    const phone = $("#signup-phone").value.trim();

    try {
      await signUp({
        email,
        password,
        displayName,
        phone,
      });

      await signIn({
        email,
        password,
      });

      await enterApp();
    } catch (err) {
      showAuthError(err.message);
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

      showAuthError(
        ok
          ? "تم تفعيل الإشعارات ✅"
          : "تعذّر التفعيل — تحقق من إذن المتصفح أو مفتاح VAPID"
      );
    }
  );

  wireChatPanel();
  wireEmojiPicker();
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

async function loadContacts() {
  if (!state.isOnline) {
    const cached = await getCachedContacts();

    renderContactsFromCache(cached);

    return;
  }

  try {
    await loadContactsFromNetwork();
  } catch (err) {
    const cached = await getCachedContacts();

    renderContactsFromCache(cached);
  }
}

function renderContactsFromCache(cached) {
  state.contactRowsByConversation = {};

  $("#contact-list").innerHTML = "";

  $("#admins-heading")?.classList.add("hidden");
  $("#admins-section")?.classList.add("hidden");

  $("#users-heading")?.classList.add("hidden");
  $("#users-section")?.classList.add("hidden");

  cached.forEach((c) => {
    $("#contact-list").appendChild(
      buildContactRow(c, {
        withUnread: !!c._unread,
      })
    );
  });
}

async function loadContactsFromNetwork() {
  state.contactRowsByConversation = {};

  if (!state.me.is_admin) {
    const {
      data: adminProfiles,
    } = await supabase
      .from("profiles")
      .select("*")
      .in(
        "email",
        ADMINS.map((a) => a.email)
      );

    state.contacts = adminProfiles || [];

    $("#contact-list").innerHTML = "";

    $("#admins-heading")?.classList.add("hidden");
    $("#admins-section")?.classList.add("hidden");

    $("#users-heading")?.classList.add("hidden");
    $("#users-section")?.classList.add("hidden");

    state.contacts.forEach((c) => {
      $("#contact-list").appendChild(
        buildContactRow(c, {
          withUnread: false,
        })
      );
    });

    await cacheContacts(state.contacts);
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
          ? "*, user:profiles!conversations_user_id_fkey(*), owner_admin:profiles!conversations_admin_id_fkey(*)"
          : "*, user:profiles!conversations_user_id_fkey(*)"
      )
      .order("last_message_at", {
        ascending: false,
      });

    if (!state.me.is_super_admin) {
      convsQuery = convsQuery.eq("admin_id", state.me.id);
    }

    const {
      data: convs,
      error: convsError,
    } = await convsQuery;

    if (convsError) {
      console.error("تعذّر جلب المحادثات:", convsError);
    }

    const userContacts = [];

    for (const c of convs || []) {
      const { count } = await supabase
        .from("messages")
        .select("id", {
          count: "exact",
          head: true,
        })
        .eq("conversation_id", c.id)
        .neq("sender_id", state.me.id)
        .neq("status", "read");

      userContacts.push({
        ...c.user,
        _conversationId: c.id,
        _unread: count || 0,
        _lastMessage: c.last_message,

        _ownerAdminName:
          state.me.is_super_admin && c.owner_admin?.id !== state.me.id
            ? c.owner_admin?.display_name
            : null,
      });
    }

    $("#admins-section").innerHTML = "";

    (otherAdmins || []).forEach((c) => {
      $("#admins-section").appendChild(
        buildContactRow(c, {
          withUnread: false,
        })
      );
    });

    $("#users-section").innerHTML = "";

    userContacts.forEach((c) => {
      $("#users-section").appendChild(
        buildContactRow(c, {
          withUnread: true,
        })
      );
    });

    await cacheContacts([
      ...(otherAdmins || []),
      ...userContacts,
    ]);
  }
}

function buildContactRow(c, opts) {
  const row =
    document.createElement("div");

  row.className = "contact-row";

  const initials =
    (c.display_name || "?")
      .trim()
      .charAt(0);

  const online =
    c.id &&
    state.onlineMap[c.id];

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

    ${
      opts.withUnread && c._unread
        ? `<div class="unread-badge">${c._unread}</div>`
        : ""
    }
  `;

  row.addEventListener("click", () => {
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
  }

  return row;
}

function bumpUnreadBadge(conversationId) {
  const row =
    state.contactRowsByConversation[
      conversationId
    ];

  if (!row) {
    loadContacts();
    return;
  }

  const current =
    parseInt(
      row.dataset.unread || "0",
      10
    ) + 1;

  row.dataset.unread =
    String(current);

  let badge =
    row.querySelector(
      ".unread-badge"
    );

  if (!badge) {
    badge =
      document.createElement("div");

    badge.className =
      "unread-badge";

    row.appendChild(badge);
  }

  badge.textContent =
    String(current);
}

function clearUnreadBadge(conversationId) {
  const row =
    state.contactRowsByConversation[
      conversationId
    ];

  if (!row) return;

  row.dataset.unread = "0";

  row.querySelector(
    ".unread-badge"
  )?.remove();
}

function escapeHtml(str) {
  const d =
    document.createElement("div");

  d.textContent =
    str || "";

  return d.innerHTML;
}

async function openConversation(otherProfile) {
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
    };

    openConversationUIState(
      conversationId
    );

    $("#chat-header-name").textContent =
      otherProfile.display_name;

    $("#chat-header-avatar").src =
      otherProfile.avatar_url || "";

    await refreshPresenceLabel(
      otherProfile.id
    );

    await loadMessages(
      conversationId
    );

    await loadReactionsForConversation();

    subscribeToConversation(
      conversationId
    );

    await markConversationRead(
      conversationId
    );

    clearUnreadBadge(
      conversationId
    );
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

async function loadMessages(conversationId) {
  const cached =
    await getCachedMessages(
      conversationId
    );

  if (cached.length) {
    state.messages =
      cached;

    renderMessages();
  }

  if (!state.isOnline) {
    return;
  }

  const {
    data,
    error,
  } = await supabase
    .from("messages")
    .select("*")
    .eq(
      "conversation_id",
      conversationId
    )
    .order("created_at", {
      ascending: true,
    });

  if (error) {
    return;
  }

  state.messages =
    data || [];

  renderMessages();

  await cacheMessages(
    conversationId,
    state.messages
  );
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

function renderMessages() {
  const box =
    $("#chat-messages");

  if (!box) return;

  box.innerHTML = "";

  if (!state.messages.length) {
    box.innerHTML =
      `<div class="empty-chat">${state.t.no_messages}</div>`;

    return;
  }

  state.messages.forEach((m) => {
    box.appendChild(
      buildMessageBubble(m)
    );
  });

  box.scrollTop =
    box.scrollHeight;
}

function findMessageById(id) {
  return state.messages.find(
    (m) => m.id === id
  );
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

function buildMessageBubble(m) {
  const mine =
    m.sender_id ===
    state.me.id;

  const div =
    document.createElement("div");

  div.className =
    `bubble-row ${
      mine ? "mine" : "theirs"
    }`;

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

  const ticks =
    mine
      ? m._pending
        ? '<span class="ticks">🕓</span>'
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

  div.innerHTML = `
    <div class="bubble">

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
      }
    );

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

          quickPanel.classList.add(
            "hidden"
          );
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

function renderTicks(status) {
  if (status === "read") {
    return `
      <span class="ticks ticks-read">
        ✓✓
      </span>
    `;
  }

  if (status === "delivered") {
    return `
      <span class="ticks">
        ✓✓
      </span>
    `;
  }

  return `
    <span class="ticks">
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

  const extension =
    getSafeFileExtension(
      file,
      options.extension
    );

  const uuid =
    createUploadUUID();

  const storagePath =
    `${folder}/${uuid}.${extension}`;

  const contentType =
    file.type ||
    options.contentType ||
    "application/octet-stream";

  const {
    error,
  } = await supabase
    .storage
    .from(bucket)
    .upload(
      storagePath,
      file,
      {
        cacheControl:
          "3600",
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

    await queueOutboxMessage({
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
    });

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

  const {
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
    });

  if (error) {
    showAuthError(
      error.message
    );

    return;
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

  clearReply();

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
  const pending =
    await getOutbox();

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
      await removeFromOutbox(
        local_id
      );

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

function resubscribeRealtime() {
  if (!state.me) return;

  if (
    state.presenceChannel
  ) {
    supabase.removeChannel(
      state.presenceChannel
    );
  }

  subscribeGlobalPresence();

  if (
    state.inboxChannel
  ) {
    supabase.removeChannel(
      state.inboxChannel
    );
  }

  subscribeInboxUpdates();

  if (
    state.globalMsgChannel
  ) {
    supabase.removeChannel(
      state.globalMsgChannel
    );
  }

  subscribeGlobalMessageWatch();

  if (
    state.activeConversation
  ) {
    subscribeToConversation(
      state.activeConversation.id
    );

    loadMessages(
      state.activeConversation.id
    );
  }
}

function subscribeToConversation(
  conversationId
) {
  if (state.msgChannel) {
    supabase.removeChannel(
      state.msgChannel
    );
  }

  if (state.typingChannel) {
    supabase.removeChannel(
      state.typingChannel
    );
  }

  if (
    state.reactionsChannel
  ) {
    supabase.removeChannel(
      state.reactionsChannel
    );
  }

  state.msgChannel =
    supabase
      .channel(
        `messages:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event:
            "INSERT",
          schema:
            "public",
          table:
            "messages",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {

          const exists =
            state.messages.some(
              (m) =>
                m.id ===
                payload.new.id
            );

          if (!exists) {
            state.messages.push(
              payload.new
            );
          }

          renderMessages();

          cacheMessages(
            conversationId,
            [payload.new]
          );

          if (
            payload.new
              .sender_id !==
            state.me.id
          ) {
            playNotificationSound();

            await markConversationRead(
              conversationId
            );
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event:
            "UPDATE",
          schema:
            "public",
          table:
            "messages",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const idx =
            state.messages.findIndex(
              (m) =>
                m.id ===
                payload.new.id
            );

          if (idx > -1) {
            state.messages[
              idx
            ] =
              payload.new;
          }

          renderMessages();
        }
      )
      .subscribe();

  state.typingChannel =
    supabase
      .channel(
        `typing:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema:
            "public",
          table:
            "typing_status",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row =
            payload.new;

          if (
            row &&
            row.user_id !==
              state.me.id
          ) {
            $("#typing-indicator")?.classList.toggle(
              "hidden",
              !row.is_typing
            );
          }
        }
      )
      .subscribe();

  state.reactionsChannel =
    supabase
      .channel(
        `reactions:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema:
            "public",
          table:
            "message_reactions",
        },
        (payload) => {
          const row =
            payload.new ||
            payload.old;

          if (
            row &&
            state.messages.some(
              (m) =>
                m.id ===
                row.message_id
            )
          ) {
            loadReactionsForConversation();
          }
        }
      )
      .subscribe();
}

async function markConversationRead(
  conversationId
) {

  try {
    const { error } = await supabase
      .from("messages")
      .update({
        status: "read",
      })
      .eq(
        "conversation_id",
        conversationId
      )
      .neq(
        "sender_id",
        state.me.id
      )
      .neq(
        "status",
        "read"
      );

    if (error) {
      console.error("markConversationRead failed:", error);
    }
  } catch (err) {
    console.error("markConversationRead network error:", err);
  }
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

  if (!conv) return;

  await supabase
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
    );
}

function subscribeGlobalPresence() {
  state.presenceChannel =
    supabase.channel(
      "presence:global",
      {
        config: {
          presence: {
            key:
              state.me.id,
          },
        },
      }
    );

  state.presenceChannel
    .on(
      "presence",
      {
        event:
          "sync",
      },
      () => {
        const presState =
          state.presenceChannel.presenceState();

        state.onlineMap = {};

        Object.keys(
          presState
        ).forEach(
          (id) =>
            (state.onlineMap[
              id
            ] = true)
        );

        loadContacts();

        if (
          state.activeConversation
        ) {
          refreshPresenceLabel(
            state.activeConversation
              .otherProfile.id
          );
        }
      }
    )
    .on(
      "presence",
      {
        event:
          "leave",
      },
      async ({
        leftPresences,
      }) => {
        if (
          state.activeConversation
        ) {
          const leftIds =
            leftPresences
              .map(
                (p) =>
                  p.presence_ref &&
                  p.key
              )
              .filter(Boolean);

          if (
            leftIds.includes(
              state.activeConversation
                .otherProfile.id
            )
          ) {
            await refreshPresenceLabel(
              state.activeConversation
                .otherProfile.id
            );
          }
        }
      }
    )
    .subscribe(
      async (status) => {
        if (
          status ===
          "SUBSCRIBED"
        ) {
          await state.presenceChannel.track(
            {
              online_at:
                new Date().toISOString(),
            }
          );
        }
      }
    );
}

async function refreshPresenceLabel(
  otherId
) {
  const label =
    $("#chat-header-status");

  if (!label) return;

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
  state.inboxChannel =
    supabase
      .channel(
        "inbox-updates"
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema:
            "public",
          table:
            "conversations",
        },
        (payload) => {
          const row =
            payload.new;

          if (
            row &&
            (
              row.user_id ===
                state.me.id ||
              row.admin_id ===
                state.me.id
            )
          ) {
            loadContacts();
          }
        }
      )
      .subscribe();
}

function subscribeGlobalMessageWatch() {
  if (
    !state.me?.is_admin
  ) {
    return;
  }

  state.globalMsgChannel =
    supabase
      .channel(
        "global-messages-watch"
      )
      .on(
        "postgres_changes",
        {
          event:
            "INSERT",
          schema:
            "public",
          table:
            "messages",
        },
        (payload) => {
          const msg =
            payload.new;

          if (
            msg.sender_id ===
            state.me.id
          ) {
            return;
          }

          if (
            state.activeConversation &&
            msg.conversation_id ===
              state.activeConversation.id
          ) {
            return;
          }

          bumpUnreadBadge(
            msg.conversation_id
          );
        }
      )
      .subscribe();
}

function playNotificationSound() {
  const audio =
    $("#notification-sound");

  audio
    ?.play()
    .catch(() => {});
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

if (
  "serviceWorker" in
  navigator
) {
  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker
        .register(
          "./sw.js"
        )
        .catch(() => {});
    }
  );
}

document.addEventListener(
  "DOMContentLoaded",
  boot
);
