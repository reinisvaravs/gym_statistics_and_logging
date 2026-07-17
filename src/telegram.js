import { handleMessage } from './ai.js';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED = (process.env.ALLOWED_TELEGRAM_USER_ID || '').trim();
const API = `https://api.telegram.org/bot${TOKEN}`;

export async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

export const sendMessage = (chatId, text) => tg('sendMessage', { chat_id: chatId, text });

// Register the webhook with Telegram (called on startup when PUBLIC_URL is set).
export async function registerWebhook(publicUrl, secret) {
  const url = `${publicUrl.replace(/\/$/, '')}/telegram/webhook`;
  await tg('setWebhook', { url, secret_token: secret, allowed_updates: ['message'] });
  return url;
}

// Handle one Telegram update. `onChange` is called after any data mutation so the
// caller can e.g. log it. Returns nothing; replies are sent directly to the chat.
export async function handleUpdate(update, { onChange } = {}) {
  const msg = update?.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const fromId = String(msg.from?.id ?? '');

  // Bootstrap: if the allowlist is empty, help the owner find their id.
  if (!ALLOWED) {
    await sendMessage(chatId, `Your Telegram user id is ${fromId}.\nSet ALLOWED_TELEGRAM_USER_ID=${fromId} in the environment and redeploy to lock the bot to you.`);
    return;
  }
  if (fromId !== ALLOWED) return;   // silently ignore everyone else

  if (msg.text.trim() === '/start') {
    await sendMessage(chatId, 'Ready. Send a workout ("bench 70x10 75x8 today") or ask a question ("what\'s my squat PR?").');
    return;
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const { reply, changed } = await handleMessage(msg.text, today);
    if (changed && onChange) onChange();
    await sendMessage(chatId, reply);
  } catch (e) {
    await sendMessage(chatId, `Something went wrong: ${e.message}`);
  }
}
