import type {
  TelegramApiResponse,
  TelegramChat,
  TelegramMessage,
  TelegramUser,
} from "./types";

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(private readonly token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    let body: TelegramApiResponse<T>;
    try {
      body = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramError(`Telegram API returned invalid JSON for ${method}`);
    }

    if (!response.ok || !body.ok || body.result === undefined) {
      throw new TelegramError(
        body.description ?? `Telegram API request failed: ${method}`,
        body.error_code ?? response.status,
      );
    }

    return body.result;
  }

  sendMessage(
    chatId: string | number,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert = false,
  ): Promise<true> {
    return this.call<true>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      show_alert: showAlert,
    });
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {});
  }

  getChat(chatId: string | number): Promise<TelegramChat> {
    return this.call<TelegramChat>("getChat", { chat_id: chatId });
  }

  getChatMember(
    chatId: string | number,
    userId: string | number,
  ): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
  }

  setWebhook(url: string, secretToken: string): Promise<true> {
    return this.call<true>("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
      max_connections: 10,
    });
  }

  setMyCommands(): Promise<true> {
    return this.call<true>("setMyCommands", {
      commands: [
        { command: "start", description: "Открыть бота" },
        { command: "claim", description: "Назначить владельца при первом запуске" },
        { command: "settings", description: "Настройки (только владелец)" },
        { command: "join", description: "Войти по приглашению" },
        { command: "settarget", description: "Назначить текущую группу" },
        { command: "queue", description: "Состояние очереди" },
        { command: "refs", description: "Референсы моделей" },
        { command: "model", description: "Назначить текущий чат моделью" },
      ],
    });
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function displayName(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

export function chatDisplayName(chat: TelegramChat): string {
  if (chat.username) return `@${chat.username}`;
  if (chat.title) return chat.title;
  return [chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id);
}
