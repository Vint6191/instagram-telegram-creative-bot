import { chatDisplayName, TelegramClient } from "../telegram";
import type { TargetRecord, TelegramChat } from "../types";

export async function validateWritableChat(
  telegram: TelegramClient,
  botId: string,
  chat: TelegramChat,
): Promise<void> {
  if (!["group", "supergroup", "channel"].includes(chat.type)) {
    throw new Error("Нужна группа, супергруппа или канал");
  }
  const membership = await telegram.getChatMember(chat.id, botId);
  const status = String(membership.status ?? "");
  if (chat.type === "channel") {
    if (!["administrator", "creator"].includes(status)) {
      throw new Error("Бот должен быть администратором канала");
    }
    if (membership.can_post_messages === false) {
      throw new Error("У бота нет права публиковать в канале");
    }
    return;
  }
  if (status === "restricted" && membership.can_send_messages !== true) {
    throw new Error("У бота нет права писать в группе");
  }
  if (!["member", "administrator", "creator", "restricted"].includes(status)) {
    throw new Error("Бот не добавлен в эту группу");
  }
}

export function targetRecord(chat: TelegramChat, configuredBy: string): TargetRecord {
  return {
    chatId: String(chat.id),
    type: chat.type,
    title: chatDisplayName(chat),
    configuredAt: new Date().toISOString(),
    configuredBy,
    ...(chat.username ? { username: chat.username } : {}),
  };
}
