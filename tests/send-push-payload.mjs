/*
 * Tests for the FCM data-payload size guard used by send-push.
 * Run: node tests/send-push-payload.mjs
 */
import assert from "node:assert/strict";
import { fitFcmData, MAX_FCM_DATA_BYTES } from "../supabase/functions/send-push/payload.ts";

const utf8Bytes = (value) => new TextEncoder().encode(value).length;
const payloadBytes = (data) => Object.entries(data)
  .reduce((sum, [key, value]) => sum + utf8Bytes(key) + utf8Bytes(value), 0);

const shortInput = {
  type: "new_message",
  messageId: "message-1",
  conversationId: "conversation-1",
  title: "أحمد",
  body: "رسالة قصيرة",
};
const shortResult = fitFcmData(shortInput);
assert.deepEqual(shortResult, shortInput, "small payloads should be preserved exactly");
assert.notEqual(shortResult, shortInput, "helper must return a fresh object");

const longBody = "مرحبا 👋🙂 — رسالة طويلة. ".repeat(1200);
const longResult = fitFcmData({
  ...shortInput,
  body: longBody,
});
assert.ok(payloadBytes(longResult) <= MAX_FCM_DATA_BYTES, "large data payload must fit below FCM's limit");
assert.equal(longResult.type, shortInput.type, "event type must survive clipping");
assert.equal(longResult.messageId, shortInput.messageId, "message route id must survive clipping");
assert.equal(longResult.conversationId, shortInput.conversationId, "conversation route id must survive clipping");
assert.ok(longResult.body.endsWith("…"), "clipped body should indicate that it was shortened");
assert.ok(!longResult.body.includes("\uFFFD"), "UTF-8 clipping must not split an emoji/code point");

const tooMuchOptionalData = fitFcmData({
  type: "test",
  title: "اختبار",
  body: "x".repeat(5000),
  messageId: "message-2",
  conversationId: "conversation-2",
  customMetadata: "m".repeat(5000),
});
assert.ok(payloadBytes(tooMuchOptionalData) <= MAX_FCM_DATA_BYTES);
assert.equal(tooMuchOptionalData.messageId, "message-2");
assert.equal(tooMuchOptionalData.conversationId, "conversation-2");
assert.ok(!("customMetadata" in tooMuchOptionalData), "optional metadata can be dropped as a last resort");

console.log("FCM payload tests passed");
