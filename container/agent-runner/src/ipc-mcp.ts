/**
 * IPC-based MCP Server for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const EMAIL_RESULTS_DIR = path.join(IPC_DIR, 'email_results');

async function waitForEmailResult(
  requestId: string,
  maxWait = 30000,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const resultFile = path.join(EMAIL_RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 500;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, error: `Failed to read result: ${err}` };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, error: 'Request timed out' };
}

type TriggerSource = 'user' | 'email' | 'scheduled_task';

export interface IpcMcpContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  triggerSource: TriggerSource;
  emailEnabled: boolean;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createIpcMcp(ctx: IpcMcpContext) {
  const { chatJid, groupFolder, isMain, emailEnabled } = ctx;

  const emailTools = emailEnabled
    ? [
        tool(
          'list_email_folders',
          'List all mailbox folders with message counts and special use flags. Use this to discover the folder structure before searching or moving emails.',
          {},
          async () => {
            const requestId = generateRequestId();
            writeIpcFile(MESSAGES_DIR, {
              type: 'list_email_folders',
              requestId,
              groupFolder,
              timestamp: new Date().toISOString(),
            });

            const result = await waitForEmailResult(requestId);
            if (!result.success) {
              return {
                content: [
                  { type: 'text', text: `Error: ${result.error}` },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result.data, null, 2),
                },
              ],
            };
          },
        ),

        tool(
          'search_emails',
          `Search emails in a mailbox folder. Returns summaries (not full bodies).
Use get_email to fetch the full body of a specific email.

Search criteria are ANDed together. Returns up to 50 results by default, sorted newest first.`,
          {
            folder: z
              .string()
              .default('INBOX')
              .describe('Mailbox folder to search (default: INBOX)'),
            from: z
              .string()
              .optional()
              .describe('Filter by sender address or name'),
            to: z
              .string()
              .optional()
              .describe('Filter by recipient address'),
            subject: z
              .string()
              .optional()
              .describe('Filter by subject (substring match)'),
            body: z
              .string()
              .optional()
              .describe('Filter by body text (substring match)'),
            since: z
              .string()
              .optional()
              .describe(
                'Emails after this date (ISO 8601, e.g. "2026-02-01")',
              ),
            before: z
              .string()
              .optional()
              .describe('Emails before this date (ISO 8601)'),
            flagged: z
              .boolean()
              .optional()
              .describe('Filter by flagged/starred status'),
            seen: z
              .boolean()
              .optional()
              .describe(
                'Filter by read/unread status (true=read, false=unread)',
              ),
            limit: z
              .number()
              .min(1)
              .max(100)
              .default(50)
              .describe('Maximum results to return (default: 50)'),
          },
          async (args) => {
            const requestId = generateRequestId();
            writeIpcFile(MESSAGES_DIR, {
              type: 'search_emails',
              requestId,
              groupFolder,
              folder: args.folder,
              criteria: {
                from: args.from,
                to: args.to,
                subject: args.subject,
                body: args.body,
                since: args.since,
                before: args.before,
                flagged: args.flagged,
                seen: args.seen,
              },
              limit: args.limit,
              timestamp: new Date().toISOString(),
            });

            const result = await waitForEmailResult(requestId, 60000);
            if (!result.success) {
              return {
                content: [
                  { type: 'text', text: `Error: ${result.error}` },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result.data, null, 2),
                },
              ],
            };
          },
        ),

        tool(
          'get_email',
          'Fetch the full details of a specific email by UID, including the text body. Use search_emails first to find the UID.',
          {
            folder: z
              .string()
              .describe('Mailbox folder containing the email'),
            uid: z
              .number()
              .describe('Email UID (from search_emails results)'),
          },
          async (args) => {
            const requestId = generateRequestId();
            writeIpcFile(MESSAGES_DIR, {
              type: 'get_email',
              requestId,
              groupFolder,
              folder: args.folder,
              uid: args.uid,
              timestamp: new Date().toISOString(),
            });

            const result = await waitForEmailResult(requestId, 15000);
            if (!result.success) {
              return {
                content: [
                  { type: 'text', text: `Error: ${result.error}` },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result.data, null, 2),
                },
              ],
            };
          },
        ),

        tool(
          'move_emails',
          `Move emails from one folder to another.
Common destinations: "Archive", "Trash", "INBOX", or any custom folder.
The destination folder will be created if it doesn't exist.`,
          {
            folder: z.string().describe('Source mailbox folder'),
            uids: z
              .array(z.number())
              .min(1)
              .describe('Array of email UIDs to move'),
            destination: z
              .string()
              .describe(
                'Destination folder (e.g., "Archive", "Trash")',
              ),
          },
          async (args) => {
            const requestId = generateRequestId();
            writeIpcFile(MESSAGES_DIR, {
              type: 'move_emails',
              requestId,
              groupFolder,
              folder: args.folder,
              uids: args.uids,
              destination: args.destination,
              timestamp: new Date().toISOString(),
            });

            const result = await waitForEmailResult(requestId);
            if (!result.success) {
              return {
                content: [
                  { type: 'text', text: `Error: ${result.error}` },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: `Moved ${args.uids.length} email(s) to "${args.destination}"`,
                },
              ],
            };
          },
        ),

        tool(
          'flag_emails',
          `Add or remove flags on emails. Common operations:
- Star/unstar: flag="\\Flagged", action="add"/"remove"
- Mark read: flag="\\Seen", action="add"
- Mark unread: flag="\\Seen", action="remove"`,
          {
            folder: z
              .string()
              .describe('Mailbox folder containing the emails'),
            uids: z
              .array(z.number())
              .min(1)
              .describe('Array of email UIDs to flag'),
            flag: z
              .string()
              .describe(
                'Flag to add/remove (e.g., "\\\\Flagged", "\\\\Seen")',
              ),
            action: z
              .enum(['add', 'remove'])
              .describe('Whether to add or remove the flag'),
          },
          async (args) => {
            const requestId = generateRequestId();
            writeIpcFile(MESSAGES_DIR, {
              type: 'flag_emails',
              requestId,
              groupFolder,
              folder: args.folder,
              uids: args.uids,
              flag: args.flag,
              action: args.action,
              timestamp: new Date().toISOString(),
            });

            const result = await waitForEmailResult(requestId);
            if (!result.success) {
              return {
                content: [
                  { type: 'text', text: `Error: ${result.error}` },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: `${args.action === 'add' ? 'Added' : 'Removed'} flag "${args.flag}" on ${args.uids.length} email(s)`,
                },
              ],
            };
          },
        ),

        tool(
          'delete_emails',
          `Permanently delete emails. This marks them as \\Deleted and expunges.
Consider using move_emails to Trash instead for recoverable deletion.`,
          {
            folder: z
              .string()
              .describe('Mailbox folder containing the emails'),
            uids: z
              .array(z.number())
              .min(1)
              .describe(
                'Array of email UIDs to permanently delete',
              ),
          },
          async (args) => {
            const requestId = generateRequestId();
            writeIpcFile(MESSAGES_DIR, {
              type: 'delete_emails',
              requestId,
              groupFolder,
              folder: args.folder,
              uids: args.uids,
              timestamp: new Date().toISOString(),
            });

            const result = await waitForEmailResult(requestId);
            if (!result.success) {
              return {
                content: [
                  { type: 'text', text: `Error: ${result.error}` },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: `Permanently deleted ${args.uids.length} email(s) from "${args.folder}"`,
                },
              ],
            };
          },
        ),
      ]
    : [];

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        `Send a message to the current chat. Use this to proactively share information or updates.

For Telegram chats, you can include inline keyboard buttons.
Each row is an array of buttons. Each button has "text" (label) and either:
- "callback": data string (max 64 bytes) routed back as a message when pressed
- "url": opens a link when pressed

Buttons are ignored for WhatsApp targets.`,
        {
          text: z.string().describe('The message text to send'),
          buttons: z
            .array(
              z.array(
                z.object({
                  text: z.string().describe('Button label'),
                  callback: z
                    .string()
                    .max(64)
                    .optional()
                    .describe(
                      'Callback data sent back when pressed (max 64 bytes)',
                    ),
                  url: z
                    .string()
                    .optional()
                    .describe('URL to open when pressed'),
                }),
              ),
            )
            .optional()
            .describe(
              'Optional inline keyboard buttons (Telegram only). Each inner array is a row of buttons.',
            ),
        },
        async (args) => {
          const data: Record<string, unknown> = {
            type: 'message',
            chatJid,
            text: args.text,
            groupFolder,
            timestamp: new Date().toISOString(),
          };

          if (args.buttons && args.buttons.length > 0) {
            data.buttons = args.buttons;
          }

          const filename = writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Message queued for delivery (${filename})${args.buttons ? ' with inline keyboard' : ''}`,
              },
            ],
          };
        },
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group" (recommended for most tasks): Task runs in the group's conversation context, with access to chat history and memory. Use for tasks that need context about ongoing discussions, user preferences, or previous interactions.
• "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, ask the user. Examples:
- "Remind me about our discussion" → group (needs conversation context)
- "Check the weather every morning" → isolated (self-contained task)
- "Follow up on my request" → group (needs to know what was requested)
- "Generate a daily report" → isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
        {
          prompt: z
            .string()
            .describe(
              'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
            ),
          schedule_type: z
            .enum(['cron', 'interval', 'once'])
            .describe(
              'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
            ),
          schedule_value: z
            .string()
            .describe(
              'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
            ),
          context_mode: z
            .enum(['group', 'isolated'])
            .default('group')
            .describe(
              'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
            ),
          target_group: z
            .string()
            .optional()
            .describe(
              'Target group folder (main only, defaults to current group)',
            ),
        },
        async (args) => {
          // Validate schedule_value before writing IPC
          if (args.schedule_type === 'cron') {
            try {
              CronExpressionParser.parse(args.schedule_value);
            } catch (err) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
                  },
                ],
                isError: true,
              };
            }
          } else if (args.schedule_type === 'interval') {
            const ms = parseInt(args.schedule_value, 10);
            if (isNaN(ms) || ms <= 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
                  },
                ],
                isError: true,
              };
            }
          } else if (args.schedule_type === 'once') {
            const date = new Date(args.schedule_value);
            if (isNaN(date.getTime())) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
                  },
                ],
                isError: true,
              };
            }
          }

          // Non-main groups can only schedule for themselves
          const targetGroup =
            isMain && args.target_group ? args.target_group : groupFolder;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            schedule_type: args.schedule_type,
            schedule_value: args.schedule_value,
            context_mode: args.context_mode || 'group',
            groupFolder: targetGroup,
            chatJid,
            createdBy: groupFolder,
            timestamp: new Date().toISOString(),
          };

          const filename = writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
              },
            ],
          };
        },
      ),

      // Reads from current_tasks.json which host keeps updated
      tool(
        'list_tasks',
        "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
        {},
        async () => {
          const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

          try {
            if (!fs.existsSync(tasksFile)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No scheduled tasks found.',
                  },
                ],
              };
            }

            const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

            const tasks = isMain
              ? allTasks
              : allTasks.filter(
                  (t: { groupFolder: string }) => t.groupFolder === groupFolder,
                );

            if (tasks.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No scheduled tasks found.',
                  },
                ],
              };
            }

            const formatted = tasks
              .map(
                (t: {
                  id: string;
                  prompt: string;
                  schedule_type: string;
                  schedule_value: string;
                  status: string;
                  next_run: string;
                }) =>
                  `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
              )
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Scheduled tasks:\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      ),

      tool(
        'pause_task',
        'Pause a scheduled task. It will not run until resumed.',
        {
          task_id: z.string().describe('The task ID to pause'),
        },
        async (args) => {
          const data = {
            type: 'pause_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} pause requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        {
          task_id: z.string().describe('The task ID to resume'),
        },
        async (args) => {
          const data = {
            type: 'resume_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} resume requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'cancel_task',
        'Cancel and delete a scheduled task.',
        {
          task_id: z.string().describe('The task ID to cancel'),
        },
        async (args) => {
          const data = {
            type: 'cancel_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} cancellation requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'create_email_draft',
        `Create a draft email reply that will be saved to the Drafts folder for manual review and sending.
Use this when an incoming email warrants a response. The draft will NOT be sent — the user reviews and sends it manually from their email client.

Include the original email's message_id and references for proper threading.`,
        {
          to: z.string().describe('Email address to send the reply to'),
          subject: z
            .string()
            .describe('Subject line (usually "Re: original subject")'),
          body: z.string().describe('The plain text body of the reply'),
          in_reply_to: z
            .string()
            .optional()
            .describe(
              'Message-ID of the email being replied to (for threading)',
            ),
          references: z
            .string()
            .optional()
            .describe('References header value (for threading)'),
        },
        async (args) => {
          const data = {
            type: 'create_email_draft',
            to: args.to,
            subject: args.subject,
            body: args.body,
            inReplyTo: args.in_reply_to || '',
            references: args.references || '',
            groupFolder,
            timestamp: new Date().toISOString(),
          };

          const filename = writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Email draft queued (${filename}). It will be saved to the Drafts folder for review.`,
              },
            ],
          };
        },
      ),

      tool(
        'register_group',
        `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        {
          jid: z
            .string()
            .describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
          name: z.string().describe('Display name for the group'),
          folder: z
            .string()
            .describe(
              'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
            ),
          trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Only the main group can register new groups.',
                },
              ],
              isError: true,
            };
          }

          const data = {
            type: 'register_group',
            jid: args.jid,
            name: args.name,
            folder: args.folder,
            trigger: args.trigger,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
              },
            ],
          };
        },
      ),

      ...emailTools,
    ],
  });
}
