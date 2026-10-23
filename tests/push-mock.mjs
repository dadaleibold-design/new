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
    version: "3.1.0",
    architecture: "pg_net-database-triggers",
    database_notifications: { pg_net: true, vault: true, db_triggers: true },
    firebase: { configured: true },
    webhook: { secret_configured: true, endpoint: "https://example.supabase.co/functions/v1/send-push" },
    me: { devices: 1 },
    delivery_log: { recent: [], webhook_events_seen: 0 },
    checks: {
      firebase_ready: true,
      webhook_secret_ready: true,
      has_device: true,
      webhook_flow_observed: false,
    },
  };
}
