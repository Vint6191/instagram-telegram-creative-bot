import type { JobQueue } from "./job-queue";

export interface Env {
  CONFIG: KVNamespace;
  QUEUE: DurableObjectNamespace<JobQueue>;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ROOT_ADMIN_ID?: string;
  ADMIN_CLAIM_CODE?: string;
  SETUP_TOKEN?: string;
}

export type ChatType = "private" | "group" | "supergroup" | "channel";

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: ChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface MessageOriginChat {
  type: "chat";
  date: number;
  sender_chat: TelegramChat;
  author_signature?: string;
}

export interface MessageOriginChannel {
  type: "channel";
  date: number;
  chat: TelegramChat;
  message_id: number;
  author_signature?: string;
}

export interface MessageOriginUser {
  type: "user";
  date: number;
  sender_user: TelegramUser;
}

export interface MessageOriginHiddenUser {
  type: "hidden_user";
  date: number;
  sender_user_name: string;
}

export type MessageOrigin =
  | MessageOriginChat
  | MessageOriginChannel
  | MessageOriginUser
  | MessageOriginHiddenUser;

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  forward_origin?: MessageOrigin;
  reply_to_message?: TelegramMessage;
}

export interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface AuthorizedUserRecord {
  id: string;
  username?: string;
  firstName: string;
  lastName?: string;
  addedAt: string;
  addedBy: string;
}

export interface InviteRecord {
  token: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
}

export interface TargetRecord {
  chatId: string;
  type: ChatType;
  title: string;
  username?: string;
  configuredAt: string;
  configuredBy: string;
}

export interface QueueJobInput {
  requestKey: string;
  url: string;
  requesterId: string;
  requesterName: string;
  sourceChatId: string;
  sourceMessageId: string;
  statusMessageId: string;
  targetChatId: string;
}

export type QueueJobStatus = "queued" | "leased" | "completed" | "failed";
export type QueueStage =
  | "queued"
  | "starting"
  | "downloading"
  | "preparing"
  | "uploading"
  | "completed"
  | "failed";

export interface QueueJobRecord {
  id: string;
  requestKey: string;
  url: string;
  requesterId: string;
  requesterName: string;
  sourceChatId: string;
  sourceMessageId: string;
  statusMessageId: string;
  targetChatId: string;
  status: QueueJobStatus;
  stage: QueueStage;
  createdAt: number;
  updatedAt: number;
  availableAt: number;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  completedAt?: number;
}

export interface LeasedJob {
  job: QueueJobRecord;
  leaseToken: string;
}

export interface QueueStats {
  queued: number;
  working: number;
  completedToday: number;
  failedToday: number;
  onlineAgents: number;
  oldestQueuedAt?: number;
}
