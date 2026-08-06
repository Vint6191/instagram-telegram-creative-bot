import { adminClaimCode, telegramBotToken } from "../config";
import { extractInstagramUrls } from "../instagram-url";
import { queueStub } from "../queue";
import { ConfigStore } from "../store";
import {
  chatDisplayName,
  displayName,
  escapeHtml,
  TelegramClient,
  TelegramError,
} from "../telegram";
import type {
  CallbackQuery,
  Env,
  TargetRecord,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "../types";
import { AccessMenu } from "./access-menu";
import { validateWritableChat, targetRecord } from "./chat-binding";
import { CreativeMenu } from "./creative-menu";
import { MainMenu } from "./main-menu";
import { ReferenceMenu } from "./reference-menu";
import { keyboard, safeError } from "./ui";

export class UpdateHandler {
  private readonly telegram: TelegramClient;
  private readonly store: ConfigStore;
  private readonly mainMenu: MainMenu;
  private readonly creativeMenu: CreativeMenu;
  private readonly referenceMenu: ReferenceMenu;
  private readonly accessMenu: AccessMenu;

  constructor(private readonly env: Env) {
    this.telegram = new TelegramClient(telegramBotToken(env));
    this.store = new ConfigStore(env.CONFIG, env.ROOT_ADMIN_ID);
    this.mainMenu = new MainMenu(env, this.telegram, this.store);
    this.creativeMenu = new CreativeMenu(env, this.telegram, this.store);
    this.referenceMenu = new ReferenceMenu(env, this.telegram, this.store);
    this.accessMenu = new AccessMenu(this.telegram, this.store);
  }

  async handle(update: TelegramUpdate): Promise<void> {
    const queue = queueStub(this.env);
    const leaseToken = await queue.leaseTelegramUpdate(update.update_id);
    if (!leaseToken) return;
    try {
      if (update.callback_query) {
        await this.handleCallback(update.callback_query);
      } else if (update.message) {
        await this.handleMessage(update.message);
      }
      if (!(await queue.completeTelegramUpdate(update.update_id, leaseToken))) {
        throw new Error("Telegram update lease was lost before completion");
      }
    } catch (error) {
      await queue.failTelegramUpdate(update.update_id, leaseToken);
      throw error;
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const user = message.from;
    if (!user) return;
    const text = (message.text ?? message.caption ?? "").trim();
    const command = parseCommand(text);
    if (command) {
      await this.handleCommand(message, user, command.name, command.args);
      return;
    }

    if (message.chat.type === "private" && await this.store.isRootAdmin(user.id)) {
      const forwarded = getForwardedChat(message);
      if (forwarded) {
        await this.showBindPrompt(message.chat.id, forwarded);
        return;
      }
    }

    const urls = extractInstagramUrls(text);
    if (urls.length === 0) return;
    await this.enqueueCreative(message, user, urls);
  }

  private async handleCommand(
    message: TelegramMessage,
    user: TelegramUser,
    name: string,
    args: string,
  ): Promise<void> {
    if (["start", "menu", "settings"].includes(name)) {
      if (name === "start" && args.startsWith("join_")) {
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

    if (["creative", "settarget"].includes(name)) {
      if (!(await this.ensureRoot(message, user))) return;
      await this.bindCreativeFromCommand(message, user, args);
      return;
    }

    if (["reference", "model"].includes(name)) {
      if (!(await this.ensureRoot(message, user))) return;
      await this.bindReferenceFromCommand(message, user, args);
      return;
    }

    if (["warehouse", "setwarehouse"].includes(name)) {
      if (!(await this.ensureRoot(message, user))) return;
      await this.bindWarehouseFromCommand(message, user, args);
      return;
    }

    if (["refs", "references"].includes(name)) {
      if (!(await this.ensureRoot(message, user))) return;
      await this.referenceMenu.sendHome(message.chat.id);
      return;
    }

    if (["queue", "creatives"].includes(name)) {
      if (!(await this.ensureRoot(message, user))) return;
      await this.creativeMenu.sendHome(message.chat.id);
      return;
    }

    if (name === "users") {
      if (!(await this.ensureRoot(message, user))) return;
      await this.accessMenu.sendHome(message.chat.id);
      return;
    }

    if (name === "invite") {
      if (!(await this.ensureRoot(message, user))) return;
      const invite = await this.store.createInvite(user.id);
      await this.telegram.sendMessage(
        message.chat.id,
        `<b>Одноразовое приглашение</b>\n\n<code>/join ${invite.token}</code>\n\nДействует 7 дней.`,
      );
      return;
    }

    if (name === "revoke") {
      if (!(await this.ensureRoot(message, user))) return;
      const userId = args.trim();
      if (!/^\d+$/u.test(userId)) {
        await this.telegram.sendMessage(message.chat.id, "Формат: <code>/revoke TELEGRAM_ID</code>");
        return;
      }
      await this.store.revokeUser(userId);
      await this.telegram.sendMessage(message.chat.id, `Доступ <code>${userId}</code> удалён.`);
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
      let handled = false;
      if (data === "m:home") {
        await this.mainMenu.edit(chatId, messageId);
        handled = true;
      } else if (data.startsWith("bind:")) {
        await this.handleBindCallback(data, chatId, messageId, query.from.id);
        handled = true;
      } else if (data.startsWith("c:")) {
        handled = await this.creativeMenu.handle(data, chatId, messageId);
      } else if (data.startsWith("r:")) {
        handled = await this.referenceMenu.handle(data, chatId, messageId);
      } else if (data.startsWith("a:")) {
        handled = await this.accessMenu.handle(data, chatId, messageId, query.from.id);
      }
      await this.telegram.answerCallbackQuery(query.id, handled ? undefined : "Кнопка устарела");
    } catch (error) {
      console.error("callback failed", safeError(error));
      const text = error instanceof TelegramError
        ? `Telegram: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Не удалось выполнить действие";
      await this.telegram.answerCallbackQuery(query.id, text.slice(0, 180), true);
    }
  }

  private async showStart(message: TelegramMessage, user: TelegramUser): Promise<void> {
    if (await this.store.isRootAdmin(user.id)) {
      await this.mainMenu.send(message.chat.id);
      return;
    }
    if (await this.store.isAuthorized(user.id)) {
      const target = await this.store.getDefaultCreativeTarget();
      await this.telegram.sendMessage(
        message.chat.id,
        target
          ? `Отправляй по одной Instagram-ссылке. Сейчас публикация идёт в <b>${escapeHtml(target.title)}</b>.`
          : "Отправлять ссылки можно, но владелец ещё не назначил место публикации.",
      );
      return;
    }
    const root = await this.store.getRootAdminId();
    await this.telegram.sendMessage(
      message.chat.id,
      root
        ? "Для доступа нужно одноразовое приглашение владельца."
        : "Бот ещё не привязан. Используй <code>/claim КОД</code>.",
    );
  }

  private async claimRootAdmin(message: TelegramMessage, user: TelegramUser, rawCode: string): Promise<void> {
    if (message.chat.type !== "private") {
      await this.telegram.sendMessage(message.chat.id, "Первичную настройку делай в личке с ботом.");
      return;
    }
    const result = await this.store.claimRootAdmin(user, rawCode, adminClaimCode(this.env));
    if (result === "invalid-code") {
      await this.telegram.sendMessage(message.chat.id, "Неверный код владельца.");
      return;
    }
    if (result === "already-claimed") {
      await this.telegram.sendMessage(message.chat.id, "Владелец уже назначен.");
      return;
    }
    await this.mainMenu.send(message.chat.id);
  }

  private async joinByInvite(message: TelegramMessage, user: TelegramUser, rawToken: string): Promise<void> {
    if (message.chat.type !== "private") {
      await this.telegram.sendMessage(message.chat.id, "Приглашение активируется в личке с ботом.");
      return;
    }
    const token = rawToken.trim().toUpperCase();
    if (!token) {
      await this.telegram.sendMessage(message.chat.id, "Формат: <code>/join КОД</code>");
      return;
    }
    const invite = await this.store.consumeInvite(token);
    if (!invite) {
      await this.telegram.sendMessage(message.chat.id, "Код недействителен, использован или истёк.");
      return;
    }
    await this.store.addAuthorizedUser(user, invite.createdBy);
    await this.telegram.sendMessage(message.chat.id, "Доступ выдан. Отправляй по одной Instagram-ссылке.");
  }

  private async bindCreativeFromCommand(
    message: TelegramMessage,
    user: TelegramUser,
    args: string,
  ): Promise<void> {
    const chat = await this.resolveCommandChat(message, args);
    await this.saveCreativeTarget(chat, String(user.id));
    await this.telegram.sendMessage(
      message.chat.id,
      `✅ Добавлено в креативы: <b>${escapeHtml(chatDisplayName(chat))}</b>.`,
    );
  }

  private async bindReferenceFromCommand(
    message: TelegramMessage,
    user: TelegramUser,
    args: string,
  ): Promise<void> {
    if (!["group", "supergroup"].includes(message.chat.type)) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Добавь бота в рабочую группу модели и отправь там <code>/reference Имя модели</code>.",
      );
      return;
    }
    const warehouse = await this.store.getWarehouse();
    if (warehouse?.chatId === String(message.chat.id)) {
      throw new Error("Склад нельзя одновременно использовать как группу модели");
    }
    const creativeTargets = await this.store.listCreativeTargets();
    if (creativeTargets.some((target) => target.chatId === String(message.chat.id))) {
      throw new Error("Чат креативов нельзя одновременно использовать как группу референсов");
    }
    const bot = await this.getBotIdentity();
    await validateWritableChat(this.telegram, bot.id, message.chat);
    const name = args.trim() || chatDisplayName(message.chat);
    const group = await queueStub(this.env).registerReferenceGroup(String(message.chat.id), name);
    await this.telegram.sendMessage(
      message.chat.id,
      `✅ Группа референсов добавлена: <b>${escapeHtml(group.name)}</b>. Ниши настраиваются в личке: /refs.`,
    );
  }

  private async bindWarehouseFromCommand(
    message: TelegramMessage,
    user: TelegramUser,
    args: string,
  ): Promise<void> {
    const chat = await this.resolveCommandChat(message, args);
    await this.saveWarehouse(chat, String(user.id));
    await queueStub(this.env).setReferencesEnabled(true);
    await this.telegram.sendMessage(
      message.chat.id,
      `✅ Склад референсов: <b>${escapeHtml(chatDisplayName(chat))}</b>. Сбор запущен автоматически.`,
    );
  }

  private async resolveCommandChat(message: TelegramMessage, args: string): Promise<TelegramChat> {
    if (["group", "supergroup", "channel"].includes(message.chat.type)) return message.chat;
    const chatId = args.trim();
    if (/^-?\d+$/u.test(chatId)) return this.telegram.getChat(chatId);
    throw new Error("Добавь бота в чат и вызови команду там либо передай CHAT_ID");
  }

  private async showBindPrompt(chatId: string | number, forwarded: TelegramChat): Promise<void> {
    const rows = [
      [
        { text: "🎨 Креативы", callback_data: `bind:c:${forwarded.id}` },
        { text: "📦 Склад", callback_data: `bind:w:${forwarded.id}` },
      ],
    ];
    if (["group", "supergroup"].includes(forwarded.type)) {
      rows.push([{ text: "🎞 Группа референсов", callback_data: `bind:r:${forwarded.id}` }]);
    }
    await this.telegram.sendMessage(
      chatId,
      `<b>${escapeHtml(chatDisplayName(forwarded))}</b>\n\nКуда добавить этот чат?`,
      { reply_markup: keyboard(rows) },
    );
  }

  private async handleBindCallback(
    data: string,
    chatId: string | number,
    messageId: number,
    adminId: string | number,
  ): Promise<void> {
    const [, kind, targetId] = data.split(":");
    const chat = await this.telegram.getChat(targetId ?? "");
    if (kind === "c") {
      await this.saveCreativeTarget(chat, String(adminId));
      await this.telegram.editMessageText(
        chatId,
        messageId,
        `✅ Добавлено в креативы: <b>${escapeHtml(chatDisplayName(chat))}</b>.`,
        { reply_markup: keyboard([[{ text: "Открыть креативы", callback_data: "c:home" }]]) },
      );
      return;
    }
    if (kind === "w") {
      await this.saveWarehouse(chat, String(adminId));
      await queueStub(this.env).setReferencesEnabled(true);
      await this.telegram.editMessageText(
        chatId,
        messageId,
        `✅ Склад назначен: <b>${escapeHtml(chatDisplayName(chat))}</b>. Сбор запущен автоматически.`,
        { reply_markup: keyboard([[{ text: "Открыть референсы", callback_data: "r:home" }]]) },
      );
      return;
    }
    if (kind === "r") {
      if (!["group", "supergroup"].includes(chat.type)) throw new Error("Для модели нужна группа");
      const warehouse = await this.store.getWarehouse();
      if (warehouse?.chatId === String(chat.id)) {
        throw new Error("Склад нельзя одновременно использовать как группу модели");
      }
      const creativeTargets = await this.store.listCreativeTargets();
      if (creativeTargets.some((target) => target.chatId === String(chat.id))) {
        throw new Error("Чат креативов нельзя одновременно использовать как группу референсов");
      }
      const bot = await this.getBotIdentity();
      await validateWritableChat(this.telegram, bot.id, chat);
      const group = await queueStub(this.env).registerReferenceGroup(String(chat.id), chatDisplayName(chat));
      await this.telegram.editMessageText(
        chatId,
        messageId,
        `✅ Группа модели добавлена: <b>${escapeHtml(group.name)}</b>.`,
        { reply_markup: keyboard([[{ text: "Настроить группу", callback_data: `r:group:${group.chatId}` }]]) },
      );
      return;
    }
    throw new Error("Неизвестный тип привязки");
  }

  private async saveCreativeTarget(chat: TelegramChat, configuredBy: string): Promise<TargetRecord> {
    const warehouse = await this.store.getWarehouse();
    if (warehouse?.chatId === String(chat.id)) {
      throw new Error("Склад референсов нельзя одновременно использовать для креативов");
    }
    const referenceGroups = await queueStub(this.env).listReferenceGroups();
    if (referenceGroups.some((group) => group.chatId === String(chat.id))) {
      throw new Error("Группу референсов нельзя одновременно использовать для креативов");
    }
    const bot = await this.getBotIdentity();
    await validateWritableChat(this.telegram, bot.id, chat);
    const record = targetRecord(chat, configuredBy);
    await this.store.upsertCreativeTarget(record);
    return record;
  }

  private async saveWarehouse(chat: TelegramChat, configuredBy: string): Promise<TargetRecord> {
    const referenceGroups = await queueStub(this.env).listReferenceGroups();
    if (referenceGroups.some((group) => group.chatId === String(chat.id))) {
      throw new Error("Группа модели не может одновременно быть складом");
    }
    const creativeTargets = await this.store.listCreativeTargets();
    if (creativeTargets.some((target) => target.chatId === String(chat.id))) {
      throw new Error("Чат креативов не может одновременно быть складом референсов");
    }
    const bot = await this.getBotIdentity();
    await validateWritableChat(this.telegram, bot.id, chat);
    const record = targetRecord(chat, configuredBy);
    await this.store.setWarehouse(record);
    return record;
  }

  private async enqueueCreative(message: TelegramMessage, user: TelegramUser, urls: string[]): Promise<void> {
    if (!(await this.store.isAuthorized(user.id))) {
      await this.telegram.sendMessage(message.chat.id, "У тебя нет доступа к отправке контента.");
      return;
    }
    if (message.chat.type !== "private") {
      await this.telegram.sendMessage(message.chat.id, "Instagram-ссылки отправляй боту в личку.");
      return;
    }
    if (urls.length !== 1) {
      await this.telegram.sendMessage(message.chat.id, "Отправляй по одной Instagram-ссылке.");
      return;
    }
    const target = await this.store.getDefaultCreativeTarget();
    if (!target) {
      await this.telegram.sendMessage(message.chat.id, "Владелец ещё не назначил место публикации креативов.");
      return;
    }

    const status = await this.telegram.sendMessage(message.chat.id, "🕓 Добавляю в очередь…");
    try {
      const result = await queueStub(this.env).enqueue({
        requestKey: `${message.chat.id}:${message.message_id}`,
        url: urls[0]!,
        requesterId: String(user.id),
        requesterName: displayName(user),
        sourceChatId: String(message.chat.id),
        sourceMessageId: String(message.message_id),
        statusMessageId: String(status.message_id),
        targetChatId: target.chatId,
      });
      const stats = await queueStub(this.env).stats();
      const computer = stats.onlineAgents > 0
        ? "🟢 Компьютер онлайн."
        : "🟡 Компьютер офлайн, задача сохранена.";
      const duplicate = result.duplicate ? "\nЭта ссылка уже была в очереди." : "";
      await this.telegram.editMessageText(
        message.chat.id,
        status.message_id,
        `✅ Добавлено для <b>${escapeHtml(target.title)}</b>. Позиция: <b>${result.position}</b>.\n${computer}${duplicate}`,
      );
    } catch (error) {
      console.error("creative enqueue failed", safeError(error));
      await this.telegram.editMessageText(
        message.chat.id,
        status.message_id,
        "❌ Не удалось сохранить задачу. Проверь Cloudflare Worker.",
      );
    }
  }

  private async ensureRoot(message: TelegramMessage, user: TelegramUser): Promise<boolean> {
    if (await this.store.isRootAdmin(user.id)) return true;
    await this.telegram.sendMessage(message.chat.id, "Команда доступна только владельцу бота.");
    return false;
  }

  private async getBotIdentity(): Promise<{ id: string; username?: string }> {
    const cached = await this.store.getBotIdentity();
    if (cached) return cached;
    const bot = await this.telegram.getMe();
    const identity = { id: String(bot.id), ...(bot.username ? { username: bot.username } : {}) };
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
