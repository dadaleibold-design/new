export async function enablePushNotifications(){ return true; }
export function listenForForegroundMessages(){ return ()=>{}; }
export async function sendTestNotification(){ return { sent: 1 }; }
