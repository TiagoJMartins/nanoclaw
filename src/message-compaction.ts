import {
  MESSAGE_COMPACTION_ENABLED,
  MESSAGE_RETENTION_DAYS,
} from './config.js';
import {
  compactOldMessages,
  deleteOldProcessedEmails,
  deleteOldTaskRunLogs,
  getChatsWithOldMessages,
  getCompactionSummaries,
  getOldMessages,
} from './db.js';
import { logger } from './logger.js';

const COMPACTION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const COMPACTION_MODEL = 'claude-haiku-4-5-20251001';

let compactionTimer: ReturnType<typeof setInterval> | null = null;

export function startCompactionLoop(): void {
  if (!MESSAGE_COMPACTION_ENABLED) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('Message compaction enabled but ANTHROPIC_API_KEY not set');
    return;
  }

  logger.info(
    { retentionDays: MESSAGE_RETENTION_DAYS },
    'Message compaction enabled',
  );

  // Run first compaction after a short delay (don't block startup)
  setTimeout(() => runCompaction(apiKey), 60_000);
  compactionTimer = setInterval(() => runCompaction(apiKey), COMPACTION_INTERVAL);
}

export function stopCompactionLoop(): void {
  if (compactionTimer) {
    clearInterval(compactionTimer);
    compactionTimer = null;
  }
}

async function runCompaction(apiKey: string): Promise<void> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MESSAGE_RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString();

    // AI-powered message compaction
    const chats = getChatsWithOldMessages(cutoffStr);
    if (chats.length > 0) {
      logger.info(
        { chats: chats.length, cutoff: cutoffStr },
        'Starting message compaction',
      );
      for (const chatJid of chats) {
        await compactChat(chatJid, cutoffStr, apiKey);
      }
    }

    // TTL cleanup for non-message tables (no AI needed)
    const logsDeleted = deleteOldTaskRunLogs(cutoffStr);
    const emailsDeleted = deleteOldProcessedEmails(cutoffStr);
    if (logsDeleted > 0 || emailsDeleted > 0) {
      logger.info(
        { logsDeleted, emailsDeleted },
        'TTL cleanup of old records',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Message compaction cycle failed');
  }
}

async function compactChat(
  chatJid: string,
  cutoff: string,
  apiKey: string,
): Promise<void> {
  const messages = getOldMessages(chatJid, cutoff);
  if (messages.length === 0) return;

  const oldest = messages[0].timestamp;
  const newest = messages[messages.length - 1].timestamp;

  logger.info(
    { chatJid, count: messages.length, oldest, newest },
    'Compacting chat messages',
  );

  // Format messages for summarization
  const formatted = messages
    .map((m) => `[${m.timestamp}] ${m.sender_name}: ${m.content}`)
    .join('\n');

  let prompt =
    'Summarize the following conversation messages concisely. Preserve key information, decisions, action items, and important context. Group by topic where natural.\n\n' +
    `Messages from ${oldest} to ${newest}:\n\n${formatted}`;

  // Include previous compaction summaries for layered context
  const previousSummaries = getCompactionSummaries(chatJid);
  if (previousSummaries.length > 0) {
    const prevContext = previousSummaries
      .map((s) => s.content)
      .join('\n---\n');
    prompt +=
      '\n\nPrevious compaction summaries (older history) for context:\n' +
      prevContext +
      '\n\nAlso briefly note what changed or evolved compared to the older summaries.';
  }

  const summary = await callClaude(apiKey, prompt);

  const periodLabel = `${oldest.split('T')[0]} to ${newest.split('T')[0]}`;
  const content = `[Compacted: ${periodLabel}, ${messages.length} messages]\n\n${summary}`;

  compactOldMessages(chatJid, cutoff, content);

  logger.info(
    { chatJid, messagesCompacted: messages.length },
    'Chat compaction done',
  );
}

async function callClaude(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: COMPACTION_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    content: { type: string; text: string }[];
  };
  return data.content[0].text;
}
