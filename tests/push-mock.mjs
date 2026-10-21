// نسخة وهمية من js/push.js تُستخدم في اختبارات jsdom (بدون Firebase/شبكة)
export async function enablePushNotifications() { return true; }
export function listenForForegroundMessages() { return () => {}; }
export async function sendTestNotification() { return { sent: 1 }; }
export async function syncPushToken() { return true; }
export function watchTokenRefresh() { return () => {}; }
export function isPushReady() { return true; }
export function getLastTokenSyncAt() { return Date.now(); }
export function getCurrentFcmToken() { return "mock-token"; }
export async function disablePushNotifications() { return true; }
export async function getPushDiagnostics() {
  return {
    service: "send-push",
    version: "3.0.0",
    architecture: "supabase-database-webhooks",
    database_notifications: { pg_net: false, vault: false, db_triggers: false },
    firebase: { configured: true },
    webhook: { secret_configured: true, endpoint: "https://example.supabase.co/functions/v1/send-push" },
    me: { devices: 1 },
    checks: { webhook_secret: true, firebase_configured: true, devices_registered: true },
  };
}
