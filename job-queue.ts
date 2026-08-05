import { adminClaimCode, telegramBotToken } from "./config";
import { queueStub } from "./queue";
import { extractInstagramUrls } from "./instagram-url";
import { ConfigStore } from "./store";
import {
  chatDisplayName,
  displayName,
  escapeHtml,
  TelegramClient,
  TelegramError,
} from "./telegram";
import type {
  CallbackQuery,
  Env,
  TargetRecord,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types";

const CALLBACK = {
  HOME: "settings:home",
  USERS: "settings:users",
  TARGET: "settings:target",
  INVITE: "users:invite",
  CLEAR_TARGET: "target:clear",
  DEVICE: "settings:device",
  QUEUE: "settings:queue",
} as const;

export class UpdateHandler {
  private readonly telegram: TelegramClient;
  private readonly store: ConfigStore;

  constructor(private readonly env: Env) {
    this.telegram = new TelegramClient(telegramBotToken(env));
    this.store = new ConfigStore(env.CONFIG, env.ROOT_ADMIN_ID);
  }

  async handle(update: TelegramUpdate): Promise<void> {
    if (!(await this.store.claimUpdate(update.update_id))) return;

    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    if (update.message) {
      await this.handleMessage(update.message);
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const user = message.from;
    const text = (message.text ?? message.caption ?? "").trim();

    if (!user) return;

    const command = parseCommand(text);
    if (command) {
      await this.handleCommand(message, user, command.name, command.args);
      return;
    }

    if ((await this.store.isRootAdmin(user.id)) && message.chat.type === "private") {
      const forwardedChat = getForwardedChat(message);
      if (forwardedChat && ["channel", "group", "supergroup"].includes(forwardedChat.type)) {
        await this.telegram.sendMessage(
          message.chat.id,
          `Назначить <b>${escapeHtml(chatDisplayName(forwardedChat))}</b> местом публикации?`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ Назначить",
                    callback_data: `target:set:${forwardedChat.id}`,
                  },
                ],
              ],
            },
          },
        );
        return;
      }
    }

    const urls = extractInstagramUrls(text);
    if (urls.length === 0) return;

    if (!(await this.store.isAuthorized(user.id))) {
      await this.telegram.sendMessage(
        message.chat.id,
        "У тебя нет доступа к отправке контента.",
      );
      return;
    }

    if (message.chat.type !== "private") {
      await this.telegram.sendMessage(
        message.chat.id,
        "Ссылки на Instagram отправляй мне в личку — так служебные ответы не будут засорять группу.",
      );
      return;
    }

    if (urls.length !== 1) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Отправляй по одной Instagram-ссылке в сообщении.",
      );
      return;
    }

    const target = await this.store.getTarget();
    if (!target) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Канал или группа для публикации ещё не назначены. Владельцу нужно открыть /settings.",
      );
      return;
    }

    await this.enqueueDownload(message, user, urls[0]!, target);
  }

  private async handleCommand(
    message: TelegramMessage,
    user: TelegramUser,
    name: string,
    args: string,
  ): Promise<void> {
    if (name === "start") {
      if (args.startsWith("join_")) {
        await this.joinByInvite(message, user, args.slice(5));
        return;
      }
      await this.showStart(message, user);
      return;
    }

    if (name === "claim") {
      await this.claimRootAdmin(message, user, args);
      return;
    }

    if (name === "join") {
      await this.joinByInvite(message, user, args);
      return;
    }

    if (name === "settings") {
      if (!(await this.store.isRootAdmin(user.id))) {
        await this.telegram.sendMessage(message.chat.id, "Настройки доступны только владельцу бота.");
        return;
      }
      await this.sendSettings(message.chat.id);
      return;
    }

    if (name === "settarget") {
      if (!(await this.store.isRootAdmin(user.id))) {
        await this.telegram.sendMessage(message.chat.id, "Эта команда доступна только владельцу бота.");
        return;
      }
      try {
        await this.handleSetTargetCommand(message, args);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Не удалось назначить чат";
        await this.telegram.sendMessage(
          message.chat.id,
          `❌ ${escapeHtml(reason)}`,
        );
      }
      return;
    }

    if (name === "device") {
      if (!(await this.store.isRootAdmin(user.id))) {
        await this.telegram.sendMessage(message.chat.id, "Эта команда доступна только владельцу бота.");
        return;
      }
      await this.sendDeviceCode(message.chat.id, user.id);
      return;
    }

    if (name === "queue") {
      if (!(await this.store.isRootAdmin(user.id))) return;
      await this.sendQueueStatus(message.chat.id);
      return;
    }

    if (name === "users") {
      if (!(await this.store.isRootAdmin(user.id))) return;
      await this.sendUsers(message.chat.id);
      return;
    }

    if (name === "invite") {
      if (!(await this.store.isRootAdmin(user.id))) return;
      await this.sendInvite(message.chat.id, user.id);
      return;
    }

    if (name === "revoke") {
      if (!(await this.store.isRootAdmin(user.id))) return;
      const id = args.trim();
      if (!/^\d+$/u.test(id)) {
        await this.telegram.sendMessage(message.chat.id, "Формат: <code>/revoke TELEGRAM_ID</code>");
        return;
      }
      try {
        await this.store.revokeUser(id);
        await this.telegram.sendMessage(message.chat.id, `Доступ пользователя <code>${id}</code> удалён.`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Не удалось удалить доступ";
        await this.telegram.sendMessage(message.chat.id, `❌ ${escapeHtml(reason)}`);
      }
    }
  }

  private async showStart(message: TelegramMessage, user: TelegramUser): Promise<void> {
    if (await this.store.isRootAdmin(user.id)) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Бот готов. Открой /settings, назначь людей и канал или группу для публикации.",
      );
      return;
    }

    if (await this.store.isAuthorized(user.id)) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Просто отправь одну ссылку на Instagram Reel или пост. Я скачаю контент и опубликую его в назначенный канал со статистикой.",
      );
      return;
    }

    const rootAdminId = await this.store.getRootAdminId();
    await this.telegram.sendMessage(
      message.chat.id,
      rootAdminId
        ? "Для доступа нужно одноразовое приглашение от владельца бота."
        : "Бот ещё не привязан к владельцу. Используй команду <code>/claim КОД</code> из файла запуска.",
    );
  }

  private async claimRootAdmin(
    message: TelegramMessage,
    user: TelegramUser,
    rawCode: string,
  ): Promise<void> {
    if (message.chat.type !== "private") {
      await this.telegram.sendMessage(message.chat.id, "Первичную настройку нужно выполнить в личке с ботом.");
      return;
    }

    const result = await this.store.claimRootAdmin(
      user,
      rawCode,
      adminClaimCode(this.env),
    );

    if (result === "invalid-code") {
      await this.telegram.sendMessage(message.chat.id, "Неверный код владельца.");
      return;
    }
    if (result === "already-claimed") {
      await this.telegram.sendMessage(message.chat.id, "Владелец бота уже назначен.");
      return;
    }

    await this.telegram.sendMessage(
      message.chat.id,
      "✅ Ты назначен владельцем бота. Открывай /settings и выбирай людей и канал или группу.",
    );
  }

  private async joinByInvite(
    message: TelegramMessage,
    user: TelegramUser,
    rawToken: string,
  ): Promise<void> {
    if (message.chat.type !== "private") {
      await this.telegram.sendMessage(message.chat.id, "Активировать приглашение нужно в личке с ботом.");
      return;
    }

    const token = rawToken.trim().toUpperCase();
    if (!token) {
      await this.telegram.sendMessage(message.chat.id, "Пришли код так: <code>/join КОД</code>");
      return;
    }

    const invite = await this.store.consumeInvite(token);
    if (!invite) {
      await this.telegram.sendMessage(message.chat.id, "Код недействителен, уже использован или истёк.");
      return;
    }

    await this.store.addAuthorizedUser(user, invite.createdBy);
    await this.telegram.sendMessage(
      message.chat.id,
      "Доступ выдан. Теперь отправляй по одной Instagram-ссылке.",
    );
  }

  private async handleSetTargetCommand(
    message: TelegramMessage,
    args: string,
  ): Promise<void> {
    if (["group", "supergroup"].includes(message.chat.type)) {
      await this.saveTarget(message.chat, String(message.from?.id ?? "unknown"));
      await this.telegram.sendMessage(
        message.chat.id,
        `Готово. Теперь контент будет публиковаться в <b>${escapeHtml(chatDisplayName(message.chat))}</b>.`,
      );
      return;
    }

    const targetId = args.trim();
    if (/^-?\d+$/u.test(targetId)) {
      const chat = await this.telegram.getChat(targetId);
      await this.saveTarget(chat, String(message.from?.id ?? "unknown"));
      await this.telegram.sendMessage(
        message.chat.id,
        `Готово. Место публикации: <b>${escapeHtml(chatDisplayName(chat))}</b>.`,
      );
      return;
    }

    await this.telegram.sendMessage(
      message.chat.id,
      "Для группы: добавь бота и отправь там <code>/settarget</code>. Для канала: назначь бота администратором, затем перешли сюда любой пост из канала.",
    );
  }

  private async enqueueDownload(
    message: TelegramMessage,
    user: TelegramUser,
    url: string,
    target: TargetRecord,
  ): Promise<void> {
    const status = await this.telegram.sendMessage(
      message.chat.id,
      "🕓 Добавляю в очередь…",
    );

    try {
      const result = await queueStub(this.env).enqueue({
        requestKey: `${message.chat.id}:${message.message_id}`,
        url,
        requesterId: String(user.id),
        requesterName: displayName(user),
        sourceChatId: String(message.chat.id),
        sourceMessageId: String(message.message_id),
        statusMessageId: String(status.message_id),
        targetChatId: target.chatId,
      });
      const stats = await queueStub(this.env).stats();
      const computer = stats.onlineAgents > 0
        ? "🟢 Компьютер онлайн — заберёт задачу автоматически."
        : "🟡 Компьютер сейчас офлайн. Ссылка сохранена и не потеряется.";
      const duplicate = result.duplicate ? "\nЭта ссылка из сообщения уже была добавлена." : "";
      await this.telegram.editMessageText(
        message.chat.id,
        status.message_id,
        `✅ Добавлено в очередь. Позиция: <b>${result.position}</b>.\n${computer}${duplicate}`,
      );
    } catch (error) {
      console.error("queue enqueue failed", safeError(error));
      await this.telegram.editMessageText(
        message.chat.id,
        status.message_id,
        "❌ Не удалось сохранить задачу в очередь. Владельцу нужно проверить Cloudflare Worker.",
      );
    }
  }

  private async handleCallback(query: CallbackQuery): Promise<void> {
    const data = query.data ?? "";
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;

    if (!chatId || !messageId) {
      await this.telegram.answerCallbackQuery(query.id);
      return;
    }

    if (!(await this.store.isRootAdmin(query.from.id))) {
      await this.telegram.answerCallbackQuery(query.id, "Только для владельца", true);
      return;
    }

    try {
      if (data === CALLBACK.HOME) {
        await this.editSettings(chatId, messageId);
      } else if (data === CALLBACK.USERS) {
        await this.editUsers(chatId, messageId);
      } else if (data === CALLBACK.TARGET) {
        await this.telegram.editMessageText(
          chatId,
          messageId,
          "<b>Куда публиковать</b>\n\nДля группы: добавь бота и отправь в ней <code>/settarget</code>.\n\nДля канала: назначь бота администратором с правом публикации и перешли сюда любой пост из канала.",
          { reply_markup: backKeyboard() },
        );
      } else if (data === CALLBACK.DEVICE) {
        const pairing = await queueStub(this.env).createPairCode(String(query.from.id));
        await this.telegram.editMessageText(
          chatId,
          messageId,
          devicePairingText(pairing.code, pairing.expiresAt),
          { reply_markup: backKeyboard() },
        );
      } else if (data === CALLBACK.QUEUE) {
        const stats = await queueStub(this.env).stats();
        await this.telegram.editMessageText(
          chatId,
          messageId,
          queueStatusText(stats),
          { reply_markup: backKeyboard() },
        );
      } else if (data === CALLBACK.INVITE) {
        await this.telegram.answerCallbackQuery(query.id);
        await this.sendInvite(chatId, query.from.id);
        return;
      } else if (data === CALLBACK.CLEAR_TARGET) {
        await this.store.clearTarget();
        await this.editSettings(chatId, messageId);
      } else if (data.startsWith("users:remove:")) {
        const userId = data.slice("users:remove:".length);
        await this.store.revokeUser(userId);
        await this.editUsers(chatId, messageId);
      } else if (data.startsWith("target:set:")) {
        const targetId = data.slice("target:set:".length);
        const chat = await this.telegram.getChat(targetId);
        await this.saveTarget(chat, String(query.from.id));
        await this.telegram.editMessageText(
          chatId,
          messageId,
          `Готово. Место публикации: <b>${escapeHtml(chatDisplayName(chat))}</b>.`,
          { reply_markup: backKeyboard() },
        );
      }

      await this.telegram.answerCallbackQuery(query.id);
    } catch (error) {
      console.error("callback failed", safeError(error));
      const text =
        error instanceof TelegramError
          ? `Telegram: ${error.message}`
          : error instanceof Error
            ? error.message
            : "Не удалось выполнить действие";
      await this.telegram.answerCallbackQuery(query.id, text.slice(0, 180), true);
    }
  }

  private async sendSettings(chatId: string | number): Promise<void> {
    const target = await this.store.getTarget();
    const users = await this.store.listAuthorizedUsers();
    await this.telegram.sendMessage(chatId, settingsText(target, users.length), {
      reply_markup: settingsKeyboard(Boolean(target)),
    });
  }

  private async editSettings(chatId: string | number, messageId: number): Promise<void> {
    const target = await this.store.getTarget();
    const users = await this.store.listAuthorizedUsers();
    await this.telegram.editMessageText(chatId, messageId, settingsText(target, users.length), {
      reply_markup: settingsKeyboard(Boolean(target)),
    });
  }

  private async sendUsers(chatId: string | number): Promise<void> {
    const users = await this.store.listAuthorizedUsers();
    await this.telegram.sendMessage(chatId, usersText(users), {
      reply_markup: usersKeyboard(users),
    });
  }

  private async editUsers(chatId: string | number, messageId: number): Promise<void> {
    const users = await this.store.listAuthorizedUsers();
    await this.telegram.editMessageText(chatId, messageId, usersText(users), {
      reply_markup: usersKeyboard(users),
    });
  }

  private async sendInvite(chatId: string | number, adminId: string | number): Promise<void> {
    const invite = await this.store.createInvite(adminId);
    const bot = await this.getBotIdentity();
    const deepLink = bot.username
      ? `https://t.me/${bot.username}?start=join_${invite.token}`
      : undefined;

    await this.telegram.sendMessage(
      chatId,
      [
        "<b>Одноразовое приглашение</b>",
        "",
        `<code>/join ${invite.token}</code>`,
        ...(deepLink ? [`<a href=\"${deepLink}\">Открыть приглашение</a>`] : []),
        "",
        "Действует 7 дней и сгорает после первого использования.",
      ].join("\n"),
    );
  }

  private async sendDeviceCode(chatId: string | number, adminId: string | number): Promise<void> {
    const pairing = await queueStub(this.env).createPairCode(String(adminId));
    await this.telegram.sendMessage(chatId, devicePairingText(pairing.code, pairing.expiresAt));
  }

  private async sendQueueStatus(chatId: string | number): Promise<void> {
    const stats = await queueStub(this.env).stats();
    await this.telegram.sendMessage(chatId, queueStatusText(stats));
  }

  private async saveTarget(chat: TelegramChat, configuredBy: string): Promise<void> {
    if (!["group", "supergroup", "channel"].includes(chat.type)) {
      throw new Error("Target must be a group, supergroup or channel");
    }

    const bot = await this.getBotIdentity();
    const membership = await this.telegram.getChatMember(chat.id, bot.id);
    const status = String(membership.status ?? "");

    if (chat.type === "channel") {
      if (status !== "administrator" && status !== "creator") {
        throw new Error("Бот должен быть администратором канала");
      }
      if (membership.can_post_messages === false) {
        throw new Error("У бота нет права публиковать в канале");
      }
    } else if (status === "restricted") {
      if (membership.can_send_messages !== true) {
        throw new Error("У бота нет права отправлять сообщения в этой группе");
      }
    } else if (!["member", "administrator", "creator"].includes(status)) {
      throw new Error("Бот не состоит в этой группе");
    }

    await this.store.setTarget({
      chatId: String(chat.id),
      type: chat.type,
      title: chatDisplayName(chat),
      configuredAt: new Date().toISOString(),
      configuredBy,
      ...(chat.username ? { username: chat.username } : {}),
    });
  }

  private async getBotIdentity(): Promise<{ id: string; username?: string }> {
    const cached = await this.store.getBotIdentity();
    if (cached) return cached;
    const bot = await this.telegram.getMe();
    const identity: { id: string; username?: string } = {
      id: String(bot.id),
      ...(bot.username ? { username: bot.username } : {}),
    };
    await this.store.setBotIdentity(identity);
    return identity;
  }
}

function parseCommand(text: string): { name: string; args: string } | null {
  const match = text.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/iu);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: match[2] ?? "" };
}

function getForwardedChat(message: TelegramMessage): TelegramChat | null {
  const origin = message.forward_origin ?? message.reply_to_message?.forward_origin;
  if (!origin) return null;
  if (origin.type === "channel") return origin.chat;
  if (origin.type === "chat") return origin.sender_chat;
  return null;
}

function settingsText(target: TargetRecord | null, userCount: number): string {
  const targetText = target ? escapeHtml(target.title) : "не назначено";
  return [
    "<b>Настройки</b>",
    "",
    `👥 Могут отправлять: <b>${userCount + 1}</b>`,
    `📣 Публикация: <b>${targetText}</b>`,
  ].join("\n");
}

function settingsKeyboard(hasTarget: boolean): Record<string, unknown> {
  const rows: Array<Array<Record<string, string>>> = [
    [
      { text: "👥 Пользователи", callback_data: CALLBACK.USERS },
      { text: "📣 Куда публиковать", callback_data: CALLBACK.TARGET },
    ],
    [
      { text: "🖥 Подключить компьютер", callback_data: CALLBACK.DEVICE },
      { text: "📋 Очередь", callback_data: CALLBACK.QUEUE },
    ],
  ];
  if (hasTarget) {
    rows.push([{ text: "Сбросить место публикации", callback_data: CALLBACK.CLEAR_TARGET }]);
  }
  return { inline_keyboard: rows };
}

function usersText(users: Array<{ id: string; username?: string; firstName: string; lastName?: string }>): string {
  const lines = ["<b>Пользователи</b>", "", `Владелец: <code>root</code>`];
  for (const user of users) {
    const name = user.username
      ? `@${user.username}`
      : [user.firstName, user.lastName].filter(Boolean).join(" ");
    lines.push(`• ${escapeHtml(name)} — <code>${user.id}</code>`);
  }
  if (users.length === 0) lines.push("• других пользователей пока нет");
  return lines.join("\n");
}

function usersKeyboard(users: Array<{ id: string; username?: string; firstName: string }>): Record<string, unknown> {
  const rows: Array<Array<Record<string, string>>> = [
    [{ text: "➕ Создать приглашение", callback_data: CALLBACK.INVITE }],
  ];
  for (const user of users.slice(0, 30)) {
    rows.push([
      {
        text: `❌ ${user.username ? `@${user.username}` : user.firstName}`.slice(0, 50),
        callback_data: `users:remove:${user.id}`,
      },
    ]);
  }
  rows.push([{ text: "← Назад", callback_data: CALLBACK.HOME }]);
  return { inline_keyboard: rows };
}

function backKeyboard(): Record<string, unknown> {
  return { inline_keyboard: [[{ text: "← Назад", callback_data: CALLBACK.HOME }]] };
}

function devicePairingText(code: string, expiresAt: number): string {
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
  return [
    "<b>Подключение локального приложения</b>",
    "",
    `Код: <code>${escapeHtml(code)}</code>`,
    "",
    `Введи его в приложении на компьютере. Код одноразовый и действует ${minutes} мин.`,
    "После подключения GitHub Actions и self-hosted runner больше не нужны.",
  ].join("\n");
}

function queueStatusText(stats: { queued: number; working: number; completedToday: number; failedToday: number; onlineAgents: number; oldestQueuedAt?: number }): string {
  const computer = stats.onlineAgents > 0 ? "🟢 онлайн" : "🟡 офлайн";
  const oldest = stats.oldestQueuedAt
    ? `\nСтарейшая задача ждёт: <b>${formatAge(Date.now() - stats.oldestQueuedAt)}</b>`
    : "";
  return [
    "<b>Очередь</b>",
    "",
    `🖥 Компьютер: <b>${computer}</b>`,
    `🕓 Ожидают: <b>${stats.queued}</b>`,
    `⚙️ В работе: <b>${stats.working}</b>`,
    `✅ Готово сегодня: <b>${stats.completedToday}</b>`,
    `❌ Ошибок сегодня: <b>${stats.failedToday}</b>${oldest}`,
  ].join("\n");
}

function formatAge(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} мин.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч. ${rest} мин.` : `${hours} ч.`;
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
