export interface Env {
  CONFIG: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ROOT_ADMIN_ID?: string;
  ADMIN_CLAIM_CODE?: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_REF?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_TOKEN: string;
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
  parameters?: {
    retry_after?: number;
  };
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

export interface GitHubDispatchInputs {
  url: string;
  requester_id: string;
  source_chat_id: string;
  status_message_id: string;
  target_chat_id: string;
  request_id: string;
}
