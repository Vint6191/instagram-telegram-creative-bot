import { queueStub } from "../queue";
import { ConfigStore } from "../store";
import { escapeHtml, TelegramClient } from "../telegram";
import type { Env } from "../types";
import { keyboard } from "./ui";

export class MainMenu {
  constructor(
    private readonly env: Env,
    private readonly telegram: TelegramClient,
    private readonly store: ConfigStore,
  ) {}

  async send(chatId: string | number): Promise<void> {
    const payload = await this.payload();
    await this.telegram.sendMessage(chatId, payload.text, { reply_markup: payload.keyboard });
  }

  async edit(chatId: string | number, messageId: number): Promise<void> {
    const payload = await this.payload();
    await this.telegram.editMessageText(chatId, messageId, payload.text, { reply_markup: payload.keyboard });
  }

  private async payload(): Promise<{ text: string; keyboard: Record<string, unknown> }> {
    const [targets, creativeStats, referenceStats, warehouse] = await Promise.all([
      this.store.listCreativeTargets(),
      queueStub(this.env).stats(),
      queueStub(this.env).referenceStats(),
      this.store.getWarehouse(),
    ]);
    const activeTarget = targets.find((item) => item.isDefault);
    return {
      text: [
        "<b>Главное меню</b>",
        "",
        `<b>🎨 Креативы</b> — ${activeTarget ? escapeHtml(activeTarget.title) : "место не назначено"}`,
        `Очередь: ${creativeStats.queued} · компьютер: ${creativeStats.onlineAgents > 0 ? "онлайн" : "офлайн"}`,
        "",
        `<b>🎞 Референсы</b> — ${referenceStats.enabled ? "работают" : "на паузе"}`,
        `Склад: ${warehouse ? escapeHtml(warehouse.title) : "не назначен"} · групп: ${referenceStats.groups}`,
        "",
        "Креативы и референсы теперь управляются отдельно.",
      ].join("\n"),
      keyboard: keyboard([
        [{ text: "🎨 Креативы", callback_data: "c:home" }],
        [{ text: "🎞 Референсы", callback_data: "r:home" }],
        [{ text: "👥 Доступ", callback_data: "a:home" }],
      ]),
    };
  }
}
