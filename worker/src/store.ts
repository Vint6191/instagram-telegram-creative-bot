import type {
  AuthorizedUserRecord,
  CreativeTargetRecord,
  InviteRecord,
  TargetRecord,
  TelegramUser,
} from "./types";

const USER_PREFIX = "user:";
const INVITE_PREFIX = "invite:";
const LEGACY_TARGET_KEY = "settings:target";
const CREATIVE_TARGETS_KEY = "creative:targets:v4";
const PREVIOUS_CREATIVE_TARGET_KEYS = ["creative:targets:v3", "creative:targets:v2"] as const;
const WAREHOUSE_KEY = "references:warehouse:v4";
const LEGACY_WAREHOUSE_KEYS = ["settings:warehouse", "references:warehouse:v3"] as const;
const ROOT_ADMIN_KEY = "settings:root-admin";
const BOT_KEY = "meta:bot";

interface RootAdminRecord {
  id: string;
  username?: string;
  firstName: string;
  lastName?: string;
  claimedAt: string;
}

export type RootAdminClaimResult = "claimed" | "already-claimed" | "invalid-code";

export class ConfigStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly fallbackRootAdminId = "",
  ) {}

  async getRootAdminId(): Promise<string | null> {
    const record = await this.kv.get<RootAdminRecord>(ROOT_ADMIN_KEY, "json");
    if (record?.id) return record.id;
    const fallback = this.fallbackRootAdminId.trim();
    return fallback || null;
  }

  async isRootAdmin(userId: string | number): Promise<boolean> {
    const rootAdminId = await this.getRootAdminId();
    return rootAdminId !== null && String(userId) === rootAdminId;
  }

  async claimRootAdmin(
    user: TelegramUser,
    suppliedCode: string,
    expectedCode: string,
  ): Promise<RootAdminClaimResult> {
    if (normalizeCode(suppliedCode) !== normalizeCode(expectedCode)) return "invalid-code";
    const current = await this.getRootAdminId();
    if (current) return current === String(user.id) ? "claimed" : "already-claimed";

    const record: RootAdminRecord = {
      id: String(user.id),
      firstName: user.first_name,
      claimedAt: new Date().toISOString(),
      ...(user.username ? { username: user.username } : {}),
      ...(user.last_name ? { lastName: user.last_name } : {}),
    };
    await this.kv.put(ROOT_ADMIN_KEY, JSON.stringify(record));
    return "claimed";
  }

  async isAuthorized(userId: string | number): Promise<boolean> {
    if (await this.isRootAdmin(userId)) return true;
    return (await this.kv.get(`${USER_PREFIX}${String(userId)}`)) !== null;
  }

  async addAuthorizedUser(user: TelegramUser, addedBy: string | number): Promise<AuthorizedUserRecord> {
    const record: AuthorizedUserRecord = {
      id: String(user.id),
      firstName: user.first_name,
      addedAt: new Date().toISOString(),
      addedBy: String(addedBy),
      ...(user.username ? { username: user.username } : {}),
      ...(user.last_name ? { lastName: user.last_name } : {}),
    };
    await this.kv.put(`${USER_PREFIX}${record.id}`, JSON.stringify(record));
    return record;
  }

  async revokeUser(userId: string | number): Promise<void> {
    if (await this.isRootAdmin(userId)) throw new Error("Root admin cannot be revoked");
    await this.kv.delete(`${USER_PREFIX}${String(userId)}`);
  }

  async listAuthorizedUsers(): Promise<AuthorizedUserRecord[]> {
    const list = await this.kv.list({ prefix: USER_PREFIX });
    const records = await Promise.all(
      list.keys.map((key) => this.kv.get<AuthorizedUserRecord>(key.name, "json")),
    );
    return records
      .filter((item): item is AuthorizedUserRecord => item !== null)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  async createInvite(createdBy: string | number): Promise<InviteRecord> {
    const token = randomToken(10);
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const record: InviteRecord = {
      token,
      createdAt: now.toISOString(),
      createdBy: String(createdBy),
      expiresAt: expires.toISOString(),
    };
    await this.kv.put(`${INVITE_PREFIX}${token}`, JSON.stringify(record), {
      expirationTtl: 7 * 24 * 60 * 60,
    });
    return record;
  }

  async consumeInvite(token: string): Promise<InviteRecord | null> {
    const normalized = token.trim().toUpperCase();
    const key = `${INVITE_PREFIX}${normalized}`;
    const record = await this.kv.get<InviteRecord>(key, "json");
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.kv.delete(key);
      return null;
    }
    await this.kv.delete(key);
    return record;
  }

  async listCreativeTargets(): Promise<CreativeTargetRecord[]> {
    let records = await this.kv.get<CreativeTargetRecord[]>(CREATIVE_TARGETS_KEY, "json");
    if (!Array.isArray(records)) {
      let previous: CreativeTargetRecord[] | null = null;
      for (const key of PREVIOUS_CREATIVE_TARGET_KEYS) {
        const candidate = await this.kv.get<CreativeTargetRecord[]>(key, "json");
        if (Array.isArray(candidate)) {
          previous = candidate;
          break;
        }
      }
      const legacy = await this.kv.get<TargetRecord>(LEGACY_TARGET_KEY, "json");
      records = previous ?? (legacy ? [{ ...legacy, isDefault: true }] : []);
      await this.saveCreativeTargets(records);
    }
    const normalized = normalizeCreativeTargets(records);
    if (JSON.stringify(normalized) !== JSON.stringify(records)) {
      await this.saveCreativeTargets(normalized);
    }
    return normalized;
  }

  async getDefaultCreativeTarget(): Promise<CreativeTargetRecord | null> {
    const targets = await this.listCreativeTargets();
    return targets.find((item) => item.isDefault) ?? targets[0] ?? null;
  }

  async upsertCreativeTarget(target: TargetRecord): Promise<CreativeTargetRecord> {
    const targets = await this.listCreativeTargets();
    const index = targets.findIndex((item) => item.chatId === target.chatId);
    const record: CreativeTargetRecord = {
      ...target,
      isDefault: index >= 0 ? Boolean(targets[index]?.isDefault) : targets.length === 0,
    };
    if (index >= 0) targets[index] = record;
    else targets.push(record);
    const normalized = normalizeCreativeTargets(targets);
    await this.saveCreativeTargets(normalized);
    return normalized.find((item) => item.chatId === target.chatId)!;
  }

  async setDefaultCreativeTarget(chatId: string | number): Promise<CreativeTargetRecord> {
    const targetId = String(chatId);
    const targets = await this.listCreativeTargets();
    if (!targets.some((item) => item.chatId === targetId)) throw new Error("Место публикации не найдено");
    const updated = targets.map((item) => ({ ...item, isDefault: item.chatId === targetId }));
    await this.saveCreativeTargets(updated);
    return updated.find((item) => item.chatId === targetId)!;
  }

  async removeCreativeTarget(chatId: string | number): Promise<void> {
    const targetId = String(chatId);
    const targets = (await this.listCreativeTargets()).filter((item) => item.chatId !== targetId);
    await this.saveCreativeTargets(normalizeCreativeTargets(targets));
  }

  async getWarehouse(): Promise<TargetRecord | null> {
    const current = await this.kv.get<TargetRecord>(WAREHOUSE_KEY, "json");
    // The old key could point to the owner's private chat or another wrong
    // destination. It is deliberately destroyed instead of being migrated.
    await Promise.all(LEGACY_WAREHOUSE_KEYS.map((key) => this.kv.delete(key)));
    return current;
  }

  async setWarehouse(target: TargetRecord): Promise<void> {
    await this.kv.put(WAREHOUSE_KEY, JSON.stringify(target));
  }

  async clearWarehouse(): Promise<void> {
    await this.kv.delete(WAREHOUSE_KEY);
  }

  async getBotIdentity(): Promise<{ id: string; username?: string } | null> {
    return this.kv.get<{ id: string; username?: string }>(BOT_KEY, "json");
  }

  async setBotIdentity(identity: { id: string; username?: string }): Promise<void> {
    await this.kv.put(BOT_KEY, JSON.stringify(identity));
  }

  private async saveCreativeTargets(records: CreativeTargetRecord[]): Promise<void> {
    await this.kv.put(CREATIVE_TARGETS_KEY, JSON.stringify(records));
  }
}

function normalizeCreativeTargets(records: CreativeTargetRecord[]): CreativeTargetRecord[] {
  const unique = new Map<string, CreativeTargetRecord>();
  for (const raw of records) {
    if (!raw || !/^-?\d+$/u.test(String(raw.chatId))) continue;
    unique.set(String(raw.chatId), {
      ...raw,
      chatId: String(raw.chatId),
      title: String(raw.title || raw.chatId).slice(0, 120),
      isDefault: Boolean(raw.isDefault),
    });
  }
  const result = [...unique.values()];
  const defaultId = result.find((item) => item.isDefault)?.chatId ?? result[0]?.chatId;
  return result.map((item) => ({ ...item, isDefault: item.chatId === defaultId }));
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function randomToken(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}
