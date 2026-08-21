// Photo and voice input: download from Telegram, then let OpenAI turn the file into
// plain text that can go through the normal tool-calling path in ai.js.
import OpenAI, { toFile } from 'openai';
import { config } from './config.js';

const client = new OpenAI({ apiKey: config.openai.apiKey, timeout: 60_000, maxRetries: 2 });
const VISION_MODEL     = config.openai.visionModel;
const TRANSCRIBE_MODEL = config.openai.transcribeModel;

const TOKEN = config.telegram.botToken;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;   // Telegram's own bot-API download limit

const EXTRACT_PROMPT = `This is a photo of a bike computer, gym machine display, smartwatch or
handwritten workout note. Transcribe every number you can read together with what it measures:
duration, distance, average/max speed, heart rate, watts, cadence, or sets of weight x reps.
Keep the units exactly as shown on the screen. Reply with a single short line of plain text and
nothing else. If the image shows no workout data, reply exactly: NO_DATA`;

// Resolve a Telegram file_id to its bytes. Throws with a readable message.
export async function downloadTelegramFile(fileId) {
  const metaRes = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }), signal: AbortSignal.timeout(20_000),
  });
  const meta = await metaRes.json();
  if (!meta.ok) throw new Error(`could not fetch the file (${meta.description})`);

  const { file_path: filePath, file_size: fileSize } = meta.result;
  if (fileSize && fileSize > MAX_FILE_BYTES) throw new Error('that file is too big (max 20MB)');

  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`,
    { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new Error('that file is too big (max 20MB)');
  return { buffer, filePath };
}

// Read workout numbers off a photo. Returns text, or null when there is nothing to read.
export async function extractFromImage(buffer, mime, caption) {
  const dataUri = `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const content = [
    { type: 'text', text: caption ? `${EXTRACT_PROMPT}\n\nThe owner captioned it: ${caption}` : EXTRACT_PROMPT },
    { type: 'image_url', image_url: { url: dataUri, detail: 'high' } },
  ];
  const res = await client.chat.completions.create({
    model: VISION_MODEL, temperature: 0, messages: [{ role: 'user', content }],
  });
  const text = res.choices[0]?.message?.content?.trim() || '';
  return !text || /^NO_DATA\b/i.test(text) ? null : text;
}

export async function transcribeAudio(buffer, mime) {
  // The API picks its decoder from the filename, so give the extension the mime implies.
  const ext = (mime || '').split('/')[1]?.split(';')[0] || 'ogg';
  const file = await toFile(buffer, `voice.${ext === 'mpeg' ? 'mp3' : ext}`, { type: mime });
  const res = await client.audio.transcriptions.create({ file, model: TRANSCRIBE_MODEL });
  return (res.text || '').trim();
}
