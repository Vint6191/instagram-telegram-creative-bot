import { queueStub } from "../queue";
import { ConfigStore } from "../store";
import { escapeHtml, TelegramClient } from "../telegram";
import type { CreativeTargetRecord, Env, QueueStats } from "../types";
import { clampPage, formatAge, keyboard, pagerRow, parsePage, type InlineButton } from "./ui";

export class CreativeMenu {
  constructor(
    private readonly env: Env,
    private readonly telegram: TelegramClient,
    private readonly store: ConfigStore,
  ) {}

  async sendHome(chatId: string | number): Promise<void> {
    const [targets, stats] = await Promise.all([
      this.store.listCreativeTargets(),
      queueStub(this.env).stats(),
    ]);
    await this.telegram.sendMessage(chatId, creativeHomeText(targets, stats), {
      reply_markup: creativeHomeKeyboard(),
    });
  }

  async editHome(chatId: string | number, messageId: number): Promise<void> {
    const [targets, stats] = await Promise.all([
      this.store.listCreativeTargets(),
      queueStub(this.env).stats(),
    ]);
    await this.telegram.editMessageText(chatId, messageId, creativeHomeText(targets, stats), {
      reply_markup: creativeHomeKeyboard(),
    });
  }

  async handle(data: string, chatId: string | number, messageId: number): Promise<boolean> {
    if (data === "c:home") {
      await this.editHome(chatId, messageId);
      return true;
    }
    if (data === "c:add") {
      await this.telegram.editMessageText(chatId, messageId, creativeAddText(), {
        reply_markup: keyboard([[{ text: "← Креативы", callback_data: "c:home" }]]),
      });
      return true;
    }
    if (data === "c:queue") {
      const stats = await queueStub(this.env).stats();
      await this.telegram.editMessageText(chatId, messageId, creativeQueueText(stats), {
        reply_markup: keyboard([[{ text: "← Креативы", callback_data: "c:home" }]]),
      });
      return true;
    }
    if (data.startsWith("c:targets:")) {
      await this.editTargets(chatId, messageId, parsePage(data.split(":")[2]));
      return true;
    }
    if (data.startsWith("c:use:")) {
      const [, , targetId, pageRaw] = data.split(":");
      await this.store.setDefaultCreativeTarget(targetId ?? "");
      await this.editTargets(chatId, messageId, parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("c:sync:")) {
      const [, , targetId, pageRaw] = data.split(":");
      const current = (await this.store.listCreativeTargets()).find((item) => item.chatId === targetId);
      if (!current) throw new Error("Место публикации не найдено");
      const chat = await this.telegram.getChat(targetId ?? "");
      await this.store.upsertCreativeTarget({
        chatId: String(chat.id),
        type: chat.type,
        title: chat.title || chat.username || current.title,
        configuredAt: current.configuredAt,
        configuredBy: current.configuredBy,
        ...(chat.username ? { username: chat.username } : {}),
      });
      await this.editTargets(chatId, messageId, parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("c:delask:")) {
      const [, , targetId, pageRaw] = data.split(":");
      const target = (await this.store.listCreativeTargets()).find((item) => item.chatId === targetId);
      if (!target) throw new Error("Место публикации не найдено");
      await this.telegram.editMessageText(
        chatId,
        messageId,
        `<b>Удалить место публикации?</b>\n\n${escapeHtml(target.title)}\n\nНовые ссылки сюда больше не пойдут. Уже созданные задачи сохраняют своё исходное назначение.`,
        {
          reply_markup: keyboard([
            [{ text: "Да, удалить", callback_data: `c:delyes:${target.chatId}:${parsePage(pageRaw)}` }],
            [{ text: "Отмена", callback_data: `c:targets:${parsePage(pageRaw)}` }],
          ]),
        },
      );
      return true;
    }
    if (data.startsWith("c:delyes:")) {
      const [, , targetId, pageRaw] = data.split(":");
      await this.store.removeCreativeTarget(targetId ?? "");
      await this.editTargets(chatId, messageId, parsePage(pageRaw));
      return true;
    }
    return false;
  }

  private async editTargets(chatId: string | number, messageId: number, page: number): Promise<void> {
    const targets = await this.store.listCreativeTargets();
    const safePage = clampPage(page, targets.length, 7);
    await this.telegram.editMessageText(chatId, messageId, creativeTargetsText(targets, safePage), {
      reply_markup: creativeTargetsKeyboard(targets, safePage),
    });
  }
}

function creativeHomeText(targets: CreativeTargetRecord[], stats: QueueStats): string {
  const current = targets.find((item) => item.isDefault);
  const computer = stats.onlineAgents > 0 ? "🟢 онлайн" : "🟡 офлайн";
  return [
    "<b>🎨 Креативы</b>",
    "",
    `Публикация по умолчанию: <b>${current ? escapeHtml(current.title) : "не назначена"}</b>`,
    `Добавлено мест: <b>${targets.length}</b>`,
    `Компьютер: <b>${computer}</b>`,
    `Очередь: <b>${stats.queued}</b> · в работе: <b>${stats.working}</b>`,
    "",
    "Ссылки Instagram отправляются в личку боту. Каждая задача идёт только в выбранное место публикации.",
  ].join("\n");
}

function creativeHomeKeyboard(): Record<string, unknown> {
  return keyboard([
    [{ text: "📣 Места публикации", callback_data: "c:targets:0" }],
    [
      { text: "➕ Добавить", callback_data: "c:add" },
      { text: "📋 Очередь", callback_data: "c:queue" },
    ],
    [{ text: "← Главное меню", callback_data: "m:home" }],
  ]);
}

function creativeTargetsText(targets: CreativeTargetRecord[], page: number): string {
  if (targets.length === 0) {
    return [
      "<b>Места публикации креативов</b>",
      "",
      "Пока ничего не добавлено.",
      "",
      "Нажми «Добавить» и привяжи канал или группу.",
    ].join("\n");
  }
  const pageSize = 7;
  const visible = targets.slice(page * pageSize, page * pageSize + pageSize);
  return [
    "<b>Места публикации креативов</b>",
    "",
    `Всего: <b>${targets.length}</b>`,
    "",
    ...visible.map((item) => `${item.isDefault ? "✅" : "▫️"} ${escapeHtml(item.title)}`),
    "",
    "Галочка — куда сейчас уходят новые Instagram-креативы.",
  ].join("\n");
}

function creativeTargetsKeyboard(targets: CreativeTargetRecord[], page: number): Record<string, unknown> {
  const pageSize = 7;
  const rows: InlineButton[][] = [];
  for (const target of targets.slice(page * pageSize, page * pageSize + pageSize)) {
    rows.push([
      {
        text: `${target.isDefault ? "✅" : "▫️"} ${target.title}`.slice(0, 38),
        callback_data: `c:use:${target.chatId}:${page}`,
      },
      { text: "↻", callback_data: `c:sync:${target.chatId}:${page}` },
      { text: "🗑", callback_data: `c:delask:${target.chatId}:${page}` },
    ]);
  }
  rows.push(pagerRow("c:targets", page, targets.length, pageSize));
  rows.push([{ text: "➕ Добавить", callback_data: "c:add" }]);
  rows.push([{ text: "← Креативы", callback_data: "c:home" }]);
  return keyboard(rows);
}

function creativeAddText(): string {
  return [
    "<b>Добавить место публикации</b>",
    "",
    "Группа:",
    "1. Добавь бота в группу.",
    "2. Отправь в ней <code>/creative Название</code>.",
    "",
    "Канал:",
    "1. Добавь бота администратором с правом публикации.",
    "2. Перешли боту в личку любой пост из канала.",
    "3. Нажми «Креативы».",
    "",
    "После добавления место появится в списке, где его можно назначить основным.",
  ].join("\n");
}

function creativeQueueText(stats: QueueStats): string {
  const oldest = stats.oldestQueuedAt
    ? `\nСтарейшая задача ждёт: <b>${formatAge(Date.now() - stats.oldestQueuedAt)}</b>`
    : "";
  return [
    "<b>Очередь креативов</b>",
    "",
    `Компьютер: <b>${stats.onlineAgents > 0 ? "онлайн" : "офлайн"}</b>`,
    `Ожидают: <b>${stats.queued}</b>`,
    `В работе: <b>${stats.working}</b>`,
    `Готово сегодня: <b>${stats.completedToday}</b>`,
    `Ошибок сегодня: <b>${stats.failedToday}</b>${oldest}`,
  ].join("\n");
}
