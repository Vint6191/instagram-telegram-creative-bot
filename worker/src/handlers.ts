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
  QUEUE: "settings:queue",
  WAREHOUSE: "settings:warehouse",
  CLEAR_WAREHOUSE: "warehouse:clear",
  REFS: "refs:home",
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
          `Что сделать с <b>${escapeHtml(chatDisplayName(forwardedChat))}</b>?`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📣 Публикация", callback_data: `target:set:${forwardedChat.id}` },
                  { text: "🎞 Склад", callback_data: `warehouse:set:${forwardedChat.id}` },
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

    if (name === "setwarehouse") {
      if (!(await this.store.isRootAdmin(user.id))) {
        await this.telegram.sendMessage(message.chat.id, "Эта команда доступна только владельцу бота.");
        return;
      }
      try {
        await this.handleSetWarehouseCommand(message, args);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Не удалось назначить склад";
        await this.telegram.sendMessage(
          message.chat.id,
          `❌ ${escapeHtml(reason)}`,
        );
      }
      return;
    }

    if (name === "queue") {
      if (!(await this.store.isRootAdmin(user.id))) return;
      await this.sendQueueStatus(message.chat.id);
      return;
    }

    if (name === "refs") {
      if (!(await this.store.isAuthorized(user.id))) {
        await this.telegram.sendMessage(message.chat.id, "У тебя нет доступа к референсам.");
        return;
      }
      await this.sendReferencesHome(message.chat.id);
      return;
    }

    if (name === "model") {
      if (!(await this.store.isAuthorized(user.id))) {
        await this.telegram.sendMessage(message.chat.id, "У тебя нет доступа к референсам.");
        return;
      }
      if (!["private", "group", "supergroup"].includes(message.chat.type)) {
        await this.telegram.sendMessage(message.chat.id, "Моделью можно назначить личный чат или группу.");
        return;
      }
      const nameValue = args.trim() || chatDisplayName(message.chat);
      const model = await queueStub(this.env).registerReferenceModel(String(message.chat.id), nameValue);
      await this.telegram.sendMessage(
        message.chat.id,
        `✅ Чат назначен моделью: <b>${escapeHtml(model.name)}</b>. Ниши выбираются владельцем через /refs.`,
      );
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

  private async handleSetWarehouseCommand(
    message: TelegramMessage,
    args: string,
  ): Promise<void> {
    if (["group", "supergroup", "channel"].includes(message.chat.type)) {
      await this.saveWarehouse(message.chat, String(message.from?.id ?? "unknown"));
      await this.telegram.sendMessage(
        message.chat.id,
        `Готово. Склад референсов: <b>${escapeHtml(chatDisplayName(message.chat))}</b>.`,
      );
      return;
    }

    const targetId = args.trim();
    if (/^-?\d+$/u.test(targetId)) {
      const chat = await this.telegram.getChat(targetId);
      await this.saveWarehouse(chat, String(message.from?.id ?? "unknown"));
      await this.telegram.sendMessage(
        message.chat.id,
        `Готово. Склад референсов: <b>${escapeHtml(chatDisplayName(chat))}</b>.`,
      );
      return;
    }

    await this.telegram.sendMessage(
      message.chat.id,
      "Для склада: создай закрытый канал, добавь туда бота администратором с правом публикации и перешли сюда любой пост из этого канала. Либо используй <code>/setwarehouse CHAT_ID</code>.",
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
      let statusText: string;
      if (!result.duplicate) {
        statusText = `✅ В очереди · <b>${result.position}</b>`;
      } else if (result.job.status === "completed") {
        statusText = "✅ Этот пост уже опубликован.";
      } else if (result.job.status === "leased") {
        statusText = "⏳ Этот пост уже обрабатывается.";
      } else {
        statusText = `🕓 Этот пост уже в очереди${result.position ? ` · <b>${result.position}</b>` : ""}.`;
      }
      await this.telegram.editMessageText(
        message.chat.id,
        status.message_id,
        statusText,
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

    const referenceCallback = isReferenceCallback(data);
    if (referenceCallback) {
      if (!(await this.store.isAuthorized(query.from.id))) {
        await this.telegram.answerCallbackQuery(query.id, "Нет доступа к референсам", true);
        return;
      }
    } else if (!(await this.store.isRootAdmin(query.from.id))) {
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
      } else if (data === CALLBACK.QUEUE) {
        const stats = await queueStub(this.env).stats();
        await this.telegram.editMessageText(
          chatId,
          messageId,
          queueStatusText(stats),
          { reply_markup: backKeyboard() },
        );
      } else if (data === CALLBACK.WAREHOUSE) {
        const warehouse = await this.store.getWarehouse();
        await this.telegram.editMessageText(
          chatId,
          messageId,
          warehouseText(warehouse),
          { reply_markup: warehouseKeyboard(Boolean(warehouse)) },
        );
      } else if (data === CALLBACK.INVITE) {
        await this.telegram.answerCallbackQuery(query.id);
        await this.sendInvite(chatId, query.from.id);
        return;
      } else if (data === CALLBACK.CLEAR_TARGET) {
        await this.store.clearTarget();
        await this.editSettings(chatId, messageId);
      } else if (data === CALLBACK.CLEAR_WAREHOUSE) {
        await this.store.clearWarehouse();
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
      } else if (data === "rh") {
        await this.editReferencesHome(chatId, messageId);
      } else if (data.startsWith("rms:")) {
        await this.editReferenceModels(chatId, messageId, callbackPage(data));
      } else if (data.startsWith("rm:")) {
        const [, modelChatId, pageRaw] = data.split(":");
        await this.editReferenceModel(chatId, messageId, modelChatId ?? "", Number(pageRaw ?? 0));
      } else if (data.startsWith("rmt:")) {
        const [, modelChatId, slug, pageRaw] = data.split(":");
        const result = await queueStub(this.env).toggleReferenceModelNiche(modelChatId ?? "", slug ?? "");
        await this.telegram.answerCallbackQuery(
          query.id,
          result.enabled
            ? `Ниша включена. В очередь добавлено: ${result.queued}`
            : "Ниша выключена",
        );
        await this.editReferenceModel(chatId, messageId, modelChatId ?? "", Number(pageRaw ?? 0));
        return;
      } else if (data.startsWith("rrm:")) {
        const modelChatId = data.slice("rrm:".length);
        await queueStub(this.env).removeReferenceModel(modelChatId);
        await this.editReferenceModels(chatId, messageId, 0);
      } else if (data.startsWith("rns:")) {
        await this.editReferenceNiches(chatId, messageId, callbackPage(data));
      } else if (data === "rcs") {
        await queueStub(this.env).requestReferenceCatalogSync();
        await this.telegram.answerCallbackQuery(query.id, "Обновление каталога поставлено в очередь");
        await this.editReferencesHome(chatId, messageId);
        return;
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

  private async sendReferencesHome(chatId: string | number): Promise<void> {
    const stats = await queueStub(this.env).referenceStats();
    const warehouse = await this.store.getWarehouse();
    await this.telegram.sendMessage(chatId, referencesHomeText(stats, warehouse), {
      reply_markup: referencesHomeKeyboard(),
    });
  }

  private async editReferencesHome(chatId: string | number, messageId: number): Promise<void> {
    const stats = await queueStub(this.env).referenceStats();
    const warehouse = await this.store.getWarehouse();
    await this.telegram.editMessageText(chatId, messageId, referencesHomeText(stats, warehouse), {
      reply_markup: referencesHomeKeyboard(),
    });
  }

  private async editReferenceModels(
    chatId: string | number,
    messageId: number,
    page: number,
  ): Promise<void> {
    const models = await queueStub(this.env).listReferenceModels();
    const safePage = clampPage(page, models.length, 8);
    await this.telegram.editMessageText(
      chatId,
      messageId,
      referenceModelsText(models),
      { reply_markup: referenceModelsKeyboard(models, safePage) },
    );
  }

  private async editReferenceModel(
    chatId: string | number,
    messageId: number,
    modelChatId: string,
    page: number,
  ): Promise<void> {
    const models = await queueStub(this.env).listReferenceModels();
    const model = models.find((item) => item.chatId === modelChatId);
    if (!model) throw new Error("Модель не найдена");
    const niches = await queueStub(this.env).listReferenceNiches();
    const safePage = clampPage(page, niches.length, 10);
    await this.telegram.editMessageText(
      chatId,
      messageId,
      referenceModelText(model),
      { reply_markup: referenceModelKeyboard(model, niches, safePage) },
    );
  }

  private async editReferenceNiches(
    chatId: string | number,
    messageId: number,
    page: number,
  ): Promise<void> {
    const niches = await queueStub(this.env).listReferenceNiches();
    const safePage = clampPage(page, niches.length, 10);
    await this.telegram.editMessageText(
      chatId,
      messageId,
      referenceNichesText(niches, safePage),
      { reply_markup: referenceNichesKeyboard(niches, safePage) },
    );
  }

  private async sendSettings(chatId: string | number): Promise<void> {
    const target = await this.store.getTarget();
    const warehouse = await this.store.getWarehouse();
    const users = await this.store.listAuthorizedUsers();
    await this.telegram.sendMessage(chatId, settingsText(target, warehouse, users.length), {
      reply_markup: settingsKeyboard(Boolean(target), Boolean(warehouse)),
    });
  }

  private async editSettings(chatId: string | number, messageId: number): Promise<void> {
    const target = await this.store.getTarget();
    const warehouse = await this.store.getWarehouse();
    const users = await this.store.listAuthorizedUsers();
    await this.telegram.editMessageText(chatId, messageId, settingsText(target, warehouse, users.length), {
      reply_markup: settingsKeyboard(Boolean(target), Boolean(warehouse)),
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

  private async saveWarehouse(chat: TelegramChat, configuredBy: string): Promise<void> {
    if (!['group', 'supergroup', 'channel'].includes(chat.type)) {
      throw new Error('Warehouse must be a group, supergroup or channel');
    }

    const bot = await this.getBotIdentity();
    const membership = await this.telegram.getChatMember(chat.id, bot.id);
    const status = String(membership.status ?? '');

    if (chat.type === 'channel') {
      if (status !== 'administrator' && status !== 'creator') {
        throw new Error('Бот должен быть администратором канала');
      }
      if (membership.can_post_messages === false) {
        throw new Error('У бота нет права публиковать в канале');
      }
    } else if (status === 'restricted') {
      if (membership.can_send_messages !== true) {
        throw new Error('У бота нет права отправлять сообщения в этой группе');
      }
    } else if (!['member', 'administrator', 'creator'].includes(status)) {
      throw new Error('Бот не состоит в этой группе');
    }

    await this.store.setWarehouse({
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

type InlineButton = { text: string; callback_data: string };

function isReferenceCallback(data: string): boolean {
  return data === "rh" || data === "rcs" || ["rms:", "rm:", "rmt:", "rrm:", "rns:"].some(
    (prefix) => data.startsWith(prefix),
  );
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

function settingsText(
  target: TargetRecord | null,
  warehouse: TargetRecord | null,
  userCount: number,
): string {
  const targetText = target ? escapeHtml(target.title) : "не назначено";
  const warehouseTextValue = warehouse ? escapeHtml(warehouse.title) : "не назначен";
  return [
    "<b>Настройки</b>",
    "",
    `👥 Могут отправлять: <b>${userCount + 1}</b>`,
    `📣 Публикация: <b>${targetText}</b>`,
    `🎞 Склад референсов: <b>${warehouseTextValue}</b>`,
  ].join("\n");
}

function settingsKeyboard(hasTarget: boolean, hasWarehouse: boolean): Record<string, unknown> {
  const rows: Array<Array<Record<string, string>>> = [
    [
      { text: "👥 Пользователи", callback_data: CALLBACK.USERS },
      { text: "📋 Очередь", callback_data: CALLBACK.QUEUE },
    ],
    [
      { text: "📣 Публикация", callback_data: CALLBACK.TARGET },
      { text: "🎞 Склад", callback_data: CALLBACK.WAREHOUSE },
    ],
    [{ text: "🎬 Референсы", callback_data: "rh" }],
  ];
  if (hasTarget) {
    rows.push([{ text: "Сбросить место публикации", callback_data: CALLBACK.CLEAR_TARGET }]);
  }
  if (hasWarehouse) {
    rows.push([{ text: "Сбросить склад", callback_data: CALLBACK.CLEAR_WAREHOUSE }]);
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

function warehouseText(warehouse: TargetRecord | null): string {
  return [
    "<b>Склад референсов</b>",
    "",
    `Текущий склад: <b>${warehouse ? escapeHtml(warehouse.title) : "не назначен"}</b>`,
    "",
    "Как назначить:",
    "1. Создай закрытый канал или группу для склада.",
    "2. Добавь туда бота с правом публиковать сообщения.",
    "3. Перешли боту любой пост из этого канала и выбери «Склад».",
    "",
    "Можно и вручную: <code>/setwarehouse CHAT_ID</code>.",
  ].join("\n");
}

function warehouseKeyboard(hasWarehouse: boolean): Record<string, unknown> {
  const rows: Array<Array<Record<string, string>>> = [];
  if (hasWarehouse) {
    rows.push([{ text: "Сбросить склад", callback_data: CALLBACK.CLEAR_WAREHOUSE }]);
  }
  rows.push([{ text: "← Назад", callback_data: CALLBACK.HOME }]);
  return { inline_keyboard: rows };
}

function referencesHomeText(stats: {
  models: number;
  activeNiches: number;
  catalogNiches: number;
  catalogPending: boolean;
  catalogSyncedAt?: number;
  catalogError?: string;
  storedMedia: number;
  pendingUploads: number;
  pendingDeliveries: number;
  sentDeliveries: number;
}, warehouse: TargetRecord | null): string {
  const catalogState = stats.catalogPending
    ? "⏳ обновляется"
    : stats.catalogSyncedAt
      ? `обновлён ${formatAge(Date.now() - stats.catalogSyncedAt)} назад`
      : "ещё не получен";
  return [
    "<b>Референсы</b>",
    "",
    `👤 Моделей: <b>${stats.models}</b>`,
    `🔥 Ниш RedGIFs: <b>${stats.catalogNiches}</b> · ${catalogState}`,
    `🎞 Склад: <b>${warehouse ? escapeHtml(warehouse.title) : "не назначен"}</b>`,
    `🎞 На складе: <b>${stats.storedMedia}</b>`,
    `⬇️ Ждут загрузки: <b>${stats.pendingUploads}</b>`,
    `📤 В очереди моделям: <b>${stats.pendingDeliveries}</b>`,
    `✅ Отправлено: <b>${stats.sentDeliveries}</b>`,
    ...(stats.catalogError ? ["", `⚠️ ${escapeHtml(stats.catalogError)}`] : []),
    "",
    "Склад задаётся владельцем: создай закрытый канал, добавь туда бота администратором, перешли боту любой пост из этого канала и нажми «Склад».",
    "",
    "Добавь бота в рабочий чат модели и отправь там <code>/model Имя</code>. Затем открой модель здесь и отметь нужные ниши галочками.",
  ].join("\n");
}

function referencesHomeKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "👤 Модели", callback_data: "rms:0" },
        { text: "🔥 Все ниши", callback_data: "rns:0" },
      ],
      [{ text: "↻ Обновить каталог ниш", callback_data: "rcs" }],
      [{ text: "← Настройки", callback_data: CALLBACK.HOME }],
    ],
  };
}

function referenceModelsText(models: Array<{ name: string; nicheCount: number; deliveryCount: number }>): string {
  if (models.length === 0) {
    return "<b>Модели</b>\n\nПока пусто. Добавь бота в рабочий чат модели и отправь там <code>/model Имя</code>.";
  }
  return [
    "<b>Модели</b>",
    "",
    ...models.slice(0, 30).map(
      (model) => `• ${escapeHtml(model.name)} — ниш: <b>${model.nicheCount}</b>, отправлено: <b>${model.deliveryCount}</b>`,
    ),
  ].join("\n");
}

function referenceModelsKeyboard(
  models: Array<{ chatId: string; name: string }>,
  page: number,
): Record<string, unknown> {
  const pageSize = 8;
  const rows: InlineButton[][] = models.slice(page * pageSize, page * pageSize + pageSize).map((model) => [
    { text: `👤 ${model.name}`.slice(0, 55), callback_data: `rm:${model.chatId}:0` },
  ]);
  rows.push(pagerRow("rms", page, models.length, pageSize));
  rows.push([{ text: "← Референсы", callback_data: "rh" }]);
  return { inline_keyboard: rows.filter((row) => row.length > 0) };
}

function referenceModelText(model: {
  chatId: string;
  name: string;
  nicheCount: number;
  deliveryCount: number;
}): string {
  return [
    `<b>${escapeHtml(model.name)}</b>`,
    "",
    `Ниш выбрано: <b>${model.nicheCount}</b>`,
    `Референсов отправлено: <b>${model.deliveryCount}</b>`,
    "",
    "Отмечай ниши галочками. Новая модель получит весь уже накопленный склад выбранных ниш, а дальше — каждый новый HOT-референс.",
  ].join("\n");
}

function referenceModelKeyboard(
  model: { chatId: string; niches: string[] },
  niches: Array<{ slug: string; title: string; mediaCount: number }>,
  page: number,
): Record<string, unknown> {
  const pageSize = 10;
  const selected = new Set(model.niches);
  const rows: InlineButton[][] = niches.slice(page * pageSize, page * pageSize + pageSize).map((niche) => [
    {
      text: `${selected.has(niche.slug) ? "✅" : "▫️"} ${niche.title} · ${niche.mediaCount}`.slice(0, 56),
      callback_data: `rmt:${model.chatId}:${niche.slug}:${page}`,
    },
  ]);
  rows.push(pagerRow(`rm:${model.chatId}`, page, niches.length, pageSize));
  rows.push([{ text: "🗑 Удалить модель", callback_data: `rrm:${model.chatId}` }]);
  rows.push([{ text: "← Модели", callback_data: "rms:0" }]);
  return { inline_keyboard: rows.filter((row) => row.length > 0) };
}

function referenceNichesText(
  niches: Array<{ title: string; modelCount: number; mediaCount: number }>,
  page: number,
): string {
  const pageSize = 10;
  const visible = niches.slice(page * pageSize, page * pageSize + pageSize);
  return [
    "<b>Все ниши RedGIFs</b>",
    "",
    `Кураторский список: <b>${niches.length}</b>. В список попадают только одобренные ниши; из каждой раз в час берётся HOT-10.`,
    "",
    ...visible.map(
      (niche) => `• ${escapeHtml(niche.title)} — роликов: <b>${niche.mediaCount}</b>, моделей: <b>${niche.modelCount}</b>`,
    ),
  ].join("\n");
}

function referenceNichesKeyboard(
  niches: Array<{ slug: string; title: string; mediaCount: number }>,
  page: number,
): Record<string, unknown> {
  const pageSize = 10;
  const rows: InlineButton[][] = [];
  rows.push(pagerRow("rns", page, niches.length, pageSize));
  rows.push([{ text: "↻ Обновить каталог", callback_data: "rcs" }]);
  rows.push([{ text: "← Референсы", callback_data: "rh" }]);
  return { inline_keyboard: rows.filter((row) => row.length > 0) };
}

function pagerRow(
  prefix: string,
  page: number,
  total: number,
  pageSize: number,
): InlineButton[] {
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const row: InlineButton[] = [];
  if (page > 0) row.push({ text: "←", callback_data: `${prefix}:${page - 1}` });
  if (maxPage > 0) row.push({ text: `${page + 1}/${maxPage + 1}`, callback_data: `${prefix}:${page}` });
  if (page < maxPage) row.push({ text: "→", callback_data: `${prefix}:${page + 1}` });
  return row;
}

function clampPage(page: number, total: number, pageSize: number): number {
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  return Number.isFinite(page) ? Math.max(0, Math.min(maxPage, Math.floor(page))) : 0;
}

function callbackPage(data: string): number {
  const raw = data.split(":").at(-1);
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function backKeyboard(): Record<string, unknown> {
  return { inline_keyboard: [[{ text: "← Назад", callback_data: CALLBACK.HOME }]] };
}

function queueStatusText(stats: { queued: number; working: number; completedToday: number; failedToday: number; onlineAgents: number; oldestQueuedAt?: number }): string {
  const oldest = stats.oldestQueuedAt
    ? `\n⌛ <b>${formatAge(Date.now() - stats.oldestQueuedAt)}</b>`
    : "";
  return [
    `↓ <b>${stats.queued}</b>`,
    `↻ <b>${stats.working}</b>`,
    `✓ <b>${stats.completedToday}</b>`,
    `! <b>${stats.failedToday}</b>${oldest}`,
  ].join("   ");
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
