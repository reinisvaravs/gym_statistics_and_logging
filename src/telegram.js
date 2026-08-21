import { handleMessage } from './ai.js';
import * as db from './db.js';
import { today } from './time.js';
import { downloadTelegramFile, extractFromImage, transcribeAudio } from './media.js';
import { config } from './config.js';
import { log, errorFields } from './logger.js';

const TOKEN   = config.telegram.botToken;
const ALLOWED = config.telegram.allowedUserId;
const API = `https://api.telegram.org/bot${TOKEN}`;

// How many earlier turns of this chat go back into the prompt. Enough for a follow-up
// to make sense, short enough that a long thread cannot crowd out the tool results.
const HISTORY_TURNS = config.telegram.historyTurns;

export async function tg(method, body) {
  // Without a timeout a stalled connection to Telegram holds the handler — and one of
  // the pool's sockets — open for as long as the peer keeps it alive.
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
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

// Pick the attachment we know how to read, if any.
function attachmentOf(msg) {
  if (msg.photo?.length) return { kind: 'image', fileId: msg.photo[msg.photo.length - 1].file_id, mime: 'image/jpeg' };
  if (msg.document?.mime_type?.startsWith('image/')) return { kind: 'image', fileId: msg.document.file_id, mime: msg.document.mime_type };
  if (msg.voice) return { kind: 'audio', fileId: msg.voice.file_id, mime: msg.voice.mime_type || 'audio/ogg' };
  if (msg.audio) return { kind: 'audio', fileId: msg.audio.file_id, mime: msg.audio.mime_type || 'audio/mpeg' };
  return null;
}

// Handle one Telegram update. `onChange` is called after any data mutation so the
// caller can e.g. log it. Returns nothing; replies are sent directly to the chat.
export async function handleUpdate(update, { onChange } = {}) {
  const msg = update?.message;
  if (!msg) return;
  const attachment = attachmentOf(msg);
  if (!msg.text && !attachment) return;
  const chatId = msg.chat.id;
  const fromId = String(msg.from?.id ?? '');

  // Bootstrap: if the allowlist is empty, help the owner find their id.
  if (!ALLOWED) {
    await sendMessage(chatId, `Your Telegram user id is ${fromId}.\nSet ALLOWED_TELEGRAM_USER_ID=${fromId} in the environment and redeploy to lock the bot to you.`);
    return;
  }
  if (fromId !== ALLOWED) return;   // silently ignore everyone else

  if (msg.text?.trim() === '/start') {
    await sendMessage(chatId, 'Ready. Send a workout ("bench 70x10 75x8 today") or ask a question ("what\'s my squat PR?"). You can also send a voice note, or a photo of your bike computer or a machine display.');
    return;
  }

  // Forget the thread without touching any training data.
  if (msg.text?.trim() === '/reset') {
    await db.clearChatHistory(chatId).catch(() => {});
    await sendMessage(chatId, 'Conversation history cleared. Your training log is untouched.');
    return;
  }

  // Media is turned into plain text first, then goes through the same path as typing it.
  let text = msg.text;
  let prefix = '';
  if (attachment) {
    try {
      await sendMessage(chatId, attachment.kind === 'image' ? 'Reading the photo...' : 'Listening...');
      const { buffer } = await downloadTelegramFile(attachment.fileId);
      if (attachment.kind === 'image') {
        const extracted = await extractFromImage(buffer, attachment.mime, msg.caption);
        if (!extracted) {
          await sendMessage(chatId, "I couldn't find any workout data in that photo. Try a closer shot, or just type it.");
          return;
        }
        text = msg.caption ? `${extracted}\n\nCaption: ${msg.caption}` : extracted;
        prefix = `Read: ${extracted}\n`;
      } else {
        const transcript = await transcribeAudio(buffer, attachment.mime);
        if (!transcript) {
          await sendMessage(chatId, "I couldn't make out anything in that recording — try again or type it.");
          return;
        }
        text = transcript;
        prefix = `Heard: ${transcript}\n`;
      }
    } catch (e) {
      await sendMessage(chatId, `Sorry, I couldn't read that: ${e.message}`);
      return;
    }
  }

  try {
    // History is best-effort: a chat_messages failure must never cost the owner a reply.
    const history = await db.getChatHistory(chatId, HISTORY_TURNS).catch(() => []);
    const { reply, changed } = await handleMessage(text, today(), { history });
    if (changed && onChange) onChange();
    await sendMessage(chatId, prefix + reply);
    await Promise.all([
      db.appendChatMessage(chatId, 'user', text),
      db.appendChatMessage(chatId, 'assistant', reply),
    ]).catch(err => log.warn('chat history write failed', errorFields(err)));
  } catch (err) {
    // The message goes to the owner's private chat, but an OpenAI or pg error can name
    // internals, so the detail stays in the journal.
    log.error('message handling failed', errorFields(err));
    await sendMessage(chatId, 'Something went wrong handling that. It has been logged.')
      .catch(() => {});
  }
}
