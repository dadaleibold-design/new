#!/usr/bin/env bash
# فحص سريع لسلامة js/app.js بعد كل تعديل: عدد الأسطر + الصياغة + علامات أساسية
set -u
cd "$(dirname "$0")/.."
lines=$(wc -l < js/app.js)
if ! node --check js/app.js >/dev/null 2>&1; then
  echo "❌ SYNTAX ERROR in js/app.js ($lines lines)"
  node --check js/app.js 2>&1 | head -5
  exit 1
fi
markers=(
  "function boot()"
  "async function enterApp()"
  "function resubscribeRealtime"
  "function subscribeToConversation"
  "function subscribeGlobalPresence"
  "function subscribeInboxUpdates"
  "function subscribeGlobalMessageWatch"
  "function subscribeCallRoomsWatch"
  "async function markConversationRead"
  "async function openConversation("
  "function buildMessageBubble"
  "function wireChatPanel"
  "function startApp()"
  "function setupPWAInstallPrompt"
  "async function sendMessage("
  "function renderMessages"
)
missing=""
for m in "${markers[@]}"; do
  grep -qF "$m" js/app.js || missing="$missing; $m"
done
if [ -n "$missing" ]; then
  echo "❌ MISSING MARKERS ($lines lines):$missing"
  exit 1
fi
echo "✅ app.js ok — $lines lines"
