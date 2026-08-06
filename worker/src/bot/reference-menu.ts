import {
  REFERENCE_CATALOG_COUNT,
  REFERENCE_CATEGORIES,
  referenceCatalogById,
  referenceCategoryItems,
} from "../reference-catalog";
import { queueStub } from "../queue";
import { ConfigStore } from "../store";
import { escapeHtml, TelegramClient } from "../telegram";
import type { Env, TargetRecord } from "../types";
import type {
  ReferenceCatalogCategoryRecord,
  ReferenceGroupRecord,
  ReferenceStats,
} from "../reference-types";
import { clampPage, formatAge, keyboard, pagerRow, parsePage, type InlineButton } from "./ui";

export class ReferenceMenu {
  constructor(
    private readonly env: Env,
    private readonly telegram: TelegramClient,
    private readonly store: ConfigStore,
  ) {}

  async sendHome(chatId: string | number): Promise<void> {
    const [stats, warehouse] = await Promise.all([
      queueStub(this.env).referenceStats(),
      this.store.getWarehouse(),
    ]);
    await this.telegram.sendMessage(chatId, referenceHomeText(stats, warehouse), {
      reply_markup: referenceHomeKeyboard(stats),
    });
  }

  async editHome(chatId: string | number, messageId: number): Promise<void> {
    const [stats, warehouse] = await Promise.all([
      queueStub(this.env).referenceStats(),
      this.store.getWarehouse(),
    ]);
    await this.telegram.editMessageText(chatId, messageId, referenceHomeText(stats, warehouse), {
      reply_markup: referenceHomeKeyboard(stats),
    });
  }

  async handle(data: string, chatId: string | number, messageId: number): Promise<boolean> {
    const queue = queueStub(this.env);
    if (data === "r:home") {
      await this.editHome(chatId, messageId);
      return true;
    }
    if (data === "r:add") {
      await this.telegram.editMessageText(chatId, messageId, addGroupText(), {
        reply_markup: keyboard([[{ text: "← Референсы", callback_data: "r:home" }]]),
      });
      return true;
    }
    if (data === "r:warehouse") {
      await this.editWarehouse(chatId, messageId);
      return true;
    }
    if (data === "r:warehouse:clear") {
      await queue.setReferencesEnabled(false);
      await this.store.clearWarehouse();
      await this.editWarehouse(chatId, messageId);
      return true;
    }
    if (data.startsWith("r:enabled:")) {
      const enabled = data.endsWith(":1");
      if (enabled && !(await this.store.getWarehouse())) {
        throw new Error("Сначала назначь канал-склад");
      }
      await queue.setReferencesEnabled(enabled);
      await this.editHome(chatId, messageId);
      return true;
    }
    if (data === "r:retry") {
      await queue.retryReferenceFailures();
      await this.editHome(chatId, messageId);
      return true;
    }
    if (data.startsWith("r:gcats:")) {
      await this.editCatalogCategories(chatId, messageId, parsePage(data.split(":")[2]));
      return true;
    }
    if (data.startsWith("r:gniches:")) {
      const [, , categoryRaw, pageRaw] = data.split(":");
      await this.editCatalogNiches(chatId, messageId, Number(categoryRaw), parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("r:gnset:")) {
      const [, , catalogIdRaw, enabledRaw, categoryRaw, pageRaw] = data.split(":");
      const catalog = referenceCatalogById(Number(catalogIdRaw));
      if (!catalog) throw new Error("Ниша не найдена в каталоге");
      await queue.setReferenceCatalogNicheEnabled(catalog.slug, enabledRaw === "1");
      await this.editCatalogNiches(chatId, messageId, Number(categoryRaw), parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("r:gcatset:")) {
      const [, , categoryRaw, enabledRaw, pageRaw] = data.split(":");
      const category = REFERENCE_CATEGORIES[Number(categoryRaw)];
      if (!category) throw new Error("Категория не найдена");
      await queue.setReferenceCatalogCategoryEnabled(category.key, enabledRaw === "1");
      await this.editCatalogNiches(chatId, messageId, Number(categoryRaw), parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("r:groups:")) {
      await this.editGroups(chatId, messageId, parsePage(data.split(":")[2]));
      return true;
    }
    if (data.startsWith("r:group:")) {
      const [, , groupId] = data.split(":");
      await this.editGroup(chatId, messageId, groupId ?? "");
      return true;
    }
    if (data.startsWith("r:cats:")) {
      const [, , groupId, pageRaw] = data.split(":");
      await this.editCategories(chatId, messageId, groupId ?? "", parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("r:niches:")) {
      const [, , groupId, categoryRaw, pageRaw] = data.split(":");
      await this.editNiches(chatId, messageId, groupId ?? "", Number(categoryRaw), parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("r:nset:")) {
      const [, , groupId, catalogIdRaw, enabledRaw, categoryRaw, pageRaw] = data.split(":");
      const catalog = referenceCatalogById(Number(catalogIdRaw));
      if (!catalog) throw new Error("Ниша не найдена в каталоге");
      await queue.setReferenceGroupNiche(groupId ?? "", catalog.slug, enabledRaw === "1");
      await this.editNiches(chatId, messageId, groupId ?? "", Number(categoryRaw), parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("r:catset:")) {
      const [, , groupId, categoryRaw, enabledRaw, pageRaw] = data.split(":");
      const category = REFERENCE_CATEGORIES[Number(categoryRaw)];
      if (!category) throw new Error("Категория не найдена");
      await queue.setReferenceGroupCategory(groupId ?? "", category.key, enabledRaw === "1");
      await this.editNiches(chatId, messageId, groupId ?? "", Number(categoryRaw), parsePage(pageRaw));
      return true;
    }
    if (data.startsWith("r:active:")) {
      const [, , groupId, activeRaw] = data.split(":");
      await queue.setReferenceGroupActive(groupId ?? "", activeRaw === "1");
      await this.editGroup(chatId, messageId, groupId ?? "");
      return true;
    }
    if (data.startsWith("r:sync:")) {
      const groupId = data.slice("r:sync:".length);
      const chat = await this.telegram.getChat(groupId);
      await queue.renameReferenceGroup(groupId, chat.title || chat.username || `Группа ${groupId}`);
      await this.editGroup(chatId, messageId, groupId);
      return true;
    }
    if (data.startsWith("r:delask:")) {
      const groupId = data.slice("r:delask:".length);
      const group = await queue.getReferenceGroup(groupId);
      await this.telegram.editMessageText(
        chatId,
        messageId,
        `<b>Удалить группу референсов?</b>\n\n${escapeHtml(group.name)}\n\nОчередь этой группы будет удалена. Сам склад не пострадает.`,
        {
          reply_markup: keyboard([
            [{ text: "Да, удалить", callback_data: `r:delyes:${group.chatId}` }],
            [{ text: "Отмена", callback_data: `r:group:${group.chatId}` }],
          ]),
        },
      );
      return true;
    }
    if (data.startsWith("r:delyes:")) {
      await queue.removeReferenceGroup(data.slice("r:delyes:".length));
      await this.editGroups(chatId, messageId, 0);
      return true;
    }
    return false;
  }

  private async editWarehouse(chatId: string | number, messageId: number): Promise<void> {
    const warehouse = await this.store.getWarehouse();
    const rows: InlineButton[][] = [];
    if (warehouse) rows.push([{ text: "Сбросить склад", callback_data: "r:warehouse:clear" }]);
    rows.push([{ text: "← Референсы", callback_data: "r:home" }]);
    await this.telegram.editMessageText(chatId, messageId, warehouseText(warehouse), {
      reply_markup: keyboard(rows),
    });
  }

  private async editGroups(chatId: string | number, messageId: number, page: number): Promise<void> {
    const groups = await queueStub(this.env).listReferenceGroups();
    const safePage = clampPage(page, groups.length, 7);
    await this.telegram.editMessageText(chatId, messageId, groupsText(groups, safePage), {
      reply_markup: groupsKeyboard(groups, safePage),
    });
  }

  private async editCatalogCategories(
    chatId: string | number,
    messageId: number,
    page: number,
  ): Promise<void> {
    const categories = await queueStub(this.env).listReferenceCatalogCategories();
    const safePage = clampPage(page, categories.length, 8);
    await this.telegram.editMessageText(
      chatId,
      messageId,
      catalogCategoriesText(categories),
      { reply_markup: catalogCategoriesKeyboard(categories, safePage) },
    );
  }

  private async editCatalogNiches(
    chatId: string | number,
    messageId: number,
    categoryIndex: number,
    page: number,
  ): Promise<void> {
    const category = REFERENCE_CATEGORIES[categoryIndex];
    if (!category) throw new Error("Категория не найдена");
    const [disabledNiches] = await Promise.all([
      queueStub(this.env).listReferenceDisabledNiches(),
    ]);
    const disabled = new Set(disabledNiches);
    const items = referenceCategoryItems(category.key);
    const safePage = clampPage(page, items.length, 8);
    await this.telegram.editMessageText(
      chatId,
      messageId,
      catalogNichesText(category.title, items.length, items.filter((item) => !disabled.has(item.slug)).length),
      { reply_markup: catalogNichesKeyboard(items, disabled, categoryIndex, safePage) },
    );
  }

  private async editGroup(chatId: string | number, messageId: number, groupId: string): Promise<void> {
    const group = await queueStub(this.env).getReferenceGroup(groupId);
    await this.telegram.editMessageText(chatId, messageId, groupText(group), {
      reply_markup: groupKeyboard(group),
    });
  }

  private async editCategories(
    chatId: string | number,
    messageId: number,
    groupId: string,
    page: number,
  ): Promise<void> {
    const queue = queueStub(this.env);
    const [group, categories] = await Promise.all([
      queue.getReferenceGroup(groupId),
      queue.listReferenceCategories(groupId),
    ]);
    const safePage = clampPage(page, categories.length, 8);
    await this.telegram.editMessageText(chatId, messageId, categoriesText(group, categories), {
      reply_markup: categoriesKeyboard(groupId, categories, safePage),
    });
  }

  private async editNiches(
    chatId: string | number,
    messageId: number,
    groupId: string,
    categoryIndex: number,
    page: number,
  ): Promise<void> {
    const category = REFERENCE_CATEGORIES[categoryIndex];
    if (!category) throw new Error("Категория не найдена");
    const group = await queueStub(this.env).getReferenceGroup(groupId);
    const items = referenceCategoryItems(category.key);
    const safePage = clampPage(page, items.length, 8);
    await this.telegram.editMessageText(
      chatId,
      messageId,
      nichesText(group, category.title, items.length),
      { reply_markup: nichesKeyboard(group, items, categoryIndex, safePage) },
    );
  }
}

function referenceHomeText(stats: ReferenceStats, warehouse: TargetRecord | null): string {
  const state = stats.enabled ? "🟢 работает" : "⏸ на паузе";
  const lastScan = stats.lastScanAt
    ? `последняя успешная ниша ${formatAge(Date.now() - stats.lastScanAt)} назад`
    : "успешных сканов ещё не было";
  return [
    "<b>🎞 Референсы</b>",
    "",
    `Сбор: <b>${state}</b>`,
    `Склад: <b>${warehouse ? escapeHtml(warehouse.title) : "не назначен"}</b>`,
    `Групп моделей: <b>${stats.groups}</b> · активных <b>${stats.activeGroups}</b>`,
    `Ниши: <b>${stats.catalogNiches - stats.disabledNiches}</b> активных · <b>${stats.disabledNiches}</b> отключено`,
    `Скан: <b>только HOT · по 5 роликов с ниши</b>`,
    `На складе: <b>${stats.storedMedia}</b>`,
    `Ждут загрузки: <b>${stats.pendingUploads}</b>`,
    `Ждут отправки: <b>${stats.pendingDeliveries}</b>`,
    `Отправлено: <b>${stats.sentDeliveries}</b>`,
    `Ошибки: ниши <b>${stats.failedNiches}</b> · склад <b>${stats.failedUploads}</b> · доставка <b>${stats.failedDeliveries}</b>`,
    `Сканирование: ${lastScan}`,
    "",
    "Каталог ниш встроен в Worker и обновляется только вместе с кодом. Ручного обновления больше нет.",
  ].join("\n");
}

function referenceHomeKeyboard(stats: ReferenceStats): Record<string, unknown> {
  const rows: InlineButton[][] = [
    [{ text: "👥 Группы моделей", callback_data: "r:groups:0" }],
    [{ text: "🗂 Включить / отключить ниши", callback_data: "r:gcats:0" }],
    [
      { text: "➕ Добавить группу", callback_data: "r:add" },
      { text: "📦 Склад", callback_data: "r:warehouse" },
    ],
  ];
  if (stats.failedNiches + stats.failedUploads + stats.failedDeliveries > 0) {
    rows.push([{ text: "↻ Повторить ошибки", callback_data: "r:retry" }]);
  }
  rows.push([
    {
      text: stats.enabled ? "⏸ Поставить на паузу" : "▶️ Запустить",
      callback_data: `r:enabled:${stats.enabled ? 0 : 1}`,
    },
  ]);
  rows.push([{ text: "← Главное меню", callback_data: "m:home" }]);
  return keyboard(rows);
}

function catalogCategoriesText(categories: ReferenceCatalogCategoryRecord[]): string {
  const total = categories.reduce((sum, category) => sum + category.count, 0);
  const enabled = categories.reduce((sum, category) => sum + category.enabledCount, 0);
  return [
    "<b>🗂 Глобальный каталог ниш</b>",
    "",
    `Активно: <b>${enabled}/${total}</b>`,
    "",
    "Отключённые здесь ниши вообще не сканируются и не создают новые отправки. Настройки групп при этом сохраняются.",
    "",
    ...categories.map((category) =>
      `• ${escapeHtml(category.title)} — <b>${category.enabledCount}/${category.count}</b>`,
    ),
  ].join("\n");
}

function catalogCategoriesKeyboard(
  categories: ReferenceCatalogCategoryRecord[],
  page: number,
): Record<string, unknown> {
  const pageSize = 8;
  const rows: InlineButton[][] = categories
    .slice(page * pageSize, page * pageSize + pageSize)
    .map((category, offset) => {
      const index = page * pageSize + offset;
      return [{
        text: `${category.enabledCount === category.count ? "✅" : category.enabledCount === 0 ? "⛔" : "◐"} ${category.title} · ${category.enabledCount}/${category.count}`.slice(0, 58),
        callback_data: `r:gniches:${index}:0`,
      }];
    });
  rows.push(pagerRow("r:gcats", page, categories.length, pageSize));
  rows.push([{ text: "← Референсы", callback_data: "r:home" }]);
  return keyboard(rows);
}

function catalogNichesText(categoryTitle: string, total: number, enabled: number): string {
  return [
    `<b>${escapeHtml(categoryTitle)}</b>`,
    "Глобальный каталог",
    "",
    `Активно: <b>${enabled}/${total}</b>. Из активной ниши берём только HOT-5.`,
    "Отключение применяется сразу ко всем группам.",
  ].join("\n");
}

function catalogNichesKeyboard(
  items: Array<{ id: number; slug: string; title: string }>,
  disabled: Set<string>,
  categoryIndex: number,
  page: number,
): Record<string, unknown> {
  const pageSize = 8;
  const rows: InlineButton[][] = items
    .slice(page * pageSize, page * pageSize + pageSize)
    .map((item) => {
      const enabled = !disabled.has(item.slug);
      return [{
        text: `${enabled ? "✅" : "⛔"} ${item.title}`.slice(0, 58),
        callback_data: `r:gnset:${item.id}:${enabled ? 0 : 1}:${categoryIndex}:${page}`,
      }];
    });
  rows.push(pagerRow(`r:gniches:${categoryIndex}`, page, items.length, pageSize));
  rows.push([
    { text: "✅ Включить все", callback_data: `r:gcatset:${categoryIndex}:1:${page}` },
    { text: "⛔ Отключить все", callback_data: `r:gcatset:${categoryIndex}:0:${page}` },
  ]);
  rows.push([{ text: "← Категории", callback_data: "r:gcats:0" }]);
  return keyboard(rows);
}

function addGroupText(): string {
  return [
    "<b>Добавить группу модели</b>",
    "",
    "Надёжный способ:",
    "1. Добавь бота в рабочую группу модели.",
    "2. Отправь там <code>/reference Имя модели</code>.",
    "",
    "Либо перешли боту в личку сообщение из группы и нажми «Группа референсов».",
    "",
    "После добавления группа появится в меню. Там выбираются категории и отдельные ниши.",
  ].join("\n");
}

function warehouseText(warehouse: TargetRecord | null): string {
  return [
    "<b>📦 Склад референсов</b>",
    "",
    `Текущий склад: <b>${warehouse ? escapeHtml(warehouse.title) : "не назначен"}</b>`,
    "",
    "Для назначения:",
    "1. Создай закрытый канал.",
    "2. Добавь бота администратором с правом публикации.",
    "3. Перешли боту в личку любой пост из канала.",
    "4. Нажми «Склад референсов».",
    "",
    "Новые ролики сначала публикуются в этот канал и только потом копируются в группы моделей. Обхода склада нет.",
  ].join("\n");
}

function groupsText(groups: ReferenceGroupRecord[], page: number): string {
  if (groups.length === 0) {
    return "<b>Группы моделей</b>\n\nПока пусто. Нажми «Добавить группу» и привяжи рабочий чат модели.";
  }
  const pageSize = 7;
  const visible = groups.slice(page * pageSize, page * pageSize + pageSize);
  return [
    "<b>Группы моделей</b>",
    "",
    `Всего: <b>${groups.length}</b>`,
    "",
    ...visible.map((group) =>
      `${group.active ? "🟢" : "⏸"} ${escapeHtml(group.name)} — ниш <b>${group.nicheCount}</b>, очередь <b>${group.pendingCount}</b>`,
    ),
  ].join("\n");
}

function groupsKeyboard(groups: ReferenceGroupRecord[], page: number): Record<string, unknown> {
  const pageSize = 7;
  const rows: InlineButton[][] = groups
    .slice(page * pageSize, page * pageSize + pageSize)
    .map((group) => [{
      text: `${group.active ? "🟢" : "⏸"} ${group.name} · ${group.nicheCount}`.slice(0, 56),
      callback_data: `r:group:${group.chatId}`,
    }]);
  rows.push(pagerRow("r:groups", page, groups.length, pageSize));
  rows.push([{ text: "➕ Добавить группу", callback_data: "r:add" }]);
  rows.push([{ text: "← Референсы", callback_data: "r:home" }]);
  return keyboard(rows);
}

function groupText(group: ReferenceGroupRecord): string {
  return [
    `<b>${escapeHtml(group.name)}</b>`,
    "",
    `Статус: <b>${group.active ? "работает" : "на паузе"}</b>`,
    `Выбрано ниш: <b>${group.nicheCount}/${REFERENCE_CATALOG_COUNT}</b>`,
    `Ждут отправки: <b>${group.pendingCount}</b>`,
    `Отправлено: <b>${group.sentCount}</b>`,
    "",
    "Выбор ниш разбит по нормальным категориям. Можно включить категорию целиком или отметить отдельные ниши.",
  ].join("\n");
}

function groupKeyboard(group: ReferenceGroupRecord): Record<string, unknown> {
  return keyboard([
    [{ text: "🧩 Настроить ниши", callback_data: `r:cats:${group.chatId}:0` }],
    [
      { text: "↻ Обновить название", callback_data: `r:sync:${group.chatId}` },
      {
        text: group.active ? "⏸ Пауза" : "▶️ Запустить",
        callback_data: `r:active:${group.chatId}:${group.active ? 0 : 1}`,
      },
    ],
    [{ text: "🗑 Удалить группу", callback_data: `r:delask:${group.chatId}` }],
    [{ text: "← Группы", callback_data: "r:groups:0" }],
  ]);
}

function categoriesText(
  group: ReferenceGroupRecord,
  categories: Array<{ title: string; selectedCount: number; count: number }>,
): string {
  return [
    `<b>Ниши · ${escapeHtml(group.name)}</b>`,
    "",
    ...categories.map((category) =>
      `• ${escapeHtml(category.title)} — <b>${category.selectedCount}/${category.count}</b>`,
    ),
  ].join("\n");
}

function categoriesKeyboard(
  groupId: string,
  categories: Array<{ title: string; selectedCount: number; count: number }>,
  page: number,
): Record<string, unknown> {
  const pageSize = 8;
  const rows: InlineButton[][] = categories
    .slice(page * pageSize, page * pageSize + pageSize)
    .map((category, offset) => {
      const index = page * pageSize + offset;
      return [{
        text: `${category.selectedCount ? "✅" : "▫️"} ${category.title} · ${category.selectedCount}/${category.count}`.slice(0, 58),
        callback_data: `r:niches:${groupId}:${index}:0`,
      }];
    });
  rows.push(pagerRow(`r:cats:${groupId}`, page, categories.length, pageSize));
  rows.push([{ text: "← Группа", callback_data: `r:group:${groupId}` }]);
  return keyboard(rows);
}

function nichesText(group: ReferenceGroupRecord, categoryTitle: string, total: number): string {
  return [
    `<b>${escapeHtml(categoryTitle)}</b>`,
    `Группа: <b>${escapeHtml(group.name)}</b>`,
    "",
    `Ниш в категории: <b>${total}</b>. Галочка применяется сразу.`,
  ].join("\n");
}

function nichesKeyboard(
  group: ReferenceGroupRecord,
  items: Array<{ id: number; slug: string; title: string }>,
  categoryIndex: number,
  page: number,
): Record<string, unknown> {
  const selected = new Set(group.niches);
  const pageSize = 8;
  const rows: InlineButton[][] = items
    .slice(page * pageSize, page * pageSize + pageSize)
    .map((item) => [{
      text: `${selected.has(item.slug) ? "✅" : "▫️"} ${item.title}`.slice(0, 58),
      callback_data: `r:nset:${group.chatId}:${item.id}:${selected.has(item.slug) ? 0 : 1}:${categoryIndex}:${page}`,
    }]);
  rows.push(pagerRow(`r:niches:${group.chatId}:${categoryIndex}`, page, items.length, pageSize));
  rows.push([
    { text: "✅ Выбрать все", callback_data: `r:catset:${group.chatId}:${categoryIndex}:1:${page}` },
    { text: "🧹 Очистить", callback_data: `r:catset:${group.chatId}:${categoryIndex}:0:${page}` },
  ]);
  rows.push([{ text: "← Категории", callback_data: `r:cats:${group.chatId}:0` }]);
  return keyboard(rows);
}
