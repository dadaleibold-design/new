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
