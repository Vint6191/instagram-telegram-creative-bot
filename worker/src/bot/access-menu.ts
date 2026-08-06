import { ConfigStore } from "../store";
import { escapeHtml, TelegramClient } from "../telegram";
import type { AuthorizedUserRecord } from "../types";
import { keyboard, type InlineButton } from "./ui";

export class AccessMenu {
  constructor(
    private readonly telegram: TelegramClient,
    private readonly store: ConfigStore,
  ) {}

  async sendHome(chatId: string | number): Promise<void> {
    const users = await this.store.listAuthorizedUsers();
    await this.telegram.sendMessage(chatId, accessText(users), {
      reply_markup: accessKeyboard(users),
    });
  }

  async editHome(chatId: string | number, messageId: number): Promise<void> {
    const users = await this.store.listAuthorizedUsers();
    await this.telegram.editMessageText(chatId, messageId, accessText(users), {
      reply_markup: accessKeyboard(users),
    });
  }

  async handle(
    data: string,
    chatId: string | number,
    messageId: number,
    adminId: string | number,
  ): Promise<boolean> {
    if (data === "a:home") {
      await this.editHome(chatId, messageId);
      return true;
    }
    if (data === "a:invite") {
      const invite = await this.store.createInvite(adminId);
      const bot = await this.store.getBotIdentity();
      const link = bot?.username
        ? `https://t.me/${bot.username}?start=join_${invite.token}`
        : undefined;
      await this.telegram.editMessageText(
        chatId,
        messageId,
        [
          "<b>Одноразовое приглашение</b>",
          "",
          `<code>/join ${invite.token}</code>`,
          ...(link ? [`<a href=\"${link}\">Открыть приглашение</a>`] : []),
          "",
          "Действует 7 дней и сгорает после первого использования.",
        ].join("\n"),
        { reply_markup: keyboard([[{ text: "← Доступ", callback_data: "a:home" }]]) },
      );
      return true;
    }
    if (data.startsWith("a:remove:")) {
      await this.store.revokeUser(data.slice("a:remove:".length));
      await this.editHome(chatId, messageId);
      return true;
    }
    return false;
  }
}

function accessText(users: AuthorizedUserRecord[]): string {
  const visible = users.slice(0, 25);
  return [
    "<b>👥 Доступ</b>",
    "",
    "Владелец имеет полный доступ к настройкам.",
    "Добавленные пользователи могут отправлять Instagram-ссылки.",
    `Пользователей: <b>${users.length}</b>`,
    "",
    ...(visible.length
      ? visible.map((user) => {
          const name = user.username
            ? `@${user.username}`
            : [user.firstName, user.lastName].filter(Boolean).join(" ");
          return `• ${escapeHtml(name)} — <code>${user.id}</code>`;
        })
      : ["Других пользователей пока нет."]),
    ...(users.length > visible.length ? ["", "Показаны первые 25 пользователей."] : []),
  ].join("\n");
}

function accessKeyboard(users: AuthorizedUserRecord[]): Record<string, unknown> {
  const rows: InlineButton[][] = [[{ text: "➕ Создать приглашение", callback_data: "a:invite" }]];
  for (const user of users.slice(0, 25)) {
    rows.push([{
      text: `🗑 ${user.username ? `@${user.username}` : user.firstName}`.slice(0, 55),
      callback_data: `a:remove:${user.id}`,
    }]);
  }
  rows.push([{ text: "← Главное меню", callback_data: "m:home" }]);
  return keyboard(rows);
}
