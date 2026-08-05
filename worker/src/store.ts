import type {
  AuthorizedUserRecord,
  InviteRecord,
  TargetRecord,
  TelegramUser,
} from "./types";

const USER_PREFIX = "user:";
const INVITE_PREFIX = "invite:";
const TARGET_KEY = "settings:target";
const ROOT_ADMIN_KEY = "settings:root-admin";
const BOT_KEY = "meta:bot";
const UPDATE_PREFIX = "update:";

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
    if (normalizeCode(suppliedCode) !== normalizeCode(expectedCode)) {
      return "invalid-code";
    }

    const current = await this.getRootAdminId();
    if (current) {
      return current === String(user.id) ? "claimed" : "already-claimed";
    }

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

  async addAuthorizedUser(
    user: TelegramUser,
    addedBy: string | number,
  ): Promise<AuthorizedUserRecord> {
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
    if (await this.isRootAdmin(userId)) {
      throw new Error("Root admin cannot be revoked");
    }
    await this.kv.delete(`${USER_PREFIX}${String(userId)}`);
  }

  async listAuthorizedUsers(): Promise<AuthorizedUserRecord[]> {
    const list = await this.kv.list({ prefix: USER_PREFIX });
    const records = await Promise.all(
      list.keys.map(async (key) => {
        return this.kv.get<AuthorizedUserRecord>(key.name, "json");
      }),
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

  async getTarget(): Promise<TargetRecord | null> {
    return this.kv.get<TargetRecord>(TARGET_KEY, "json");
  }

  async setTarget(target: TargetRecord): Promise<void> {
    await this.kv.put(TARGET_KEY, JSON.stringify(target));
  }

  async clearTarget(): Promise<void> {
    await this.kv.delete(TARGET_KEY);
  }

  async getBotIdentity(): Promise<{ id: string; username?: string } | null> {
    return this.kv.get<{ id: string; username?: string }>(BOT_KEY, "json");
  }

  async setBotIdentity(identity: { id: string; username?: string }): Promise<void> {
    await this.kv.put(BOT_KEY, JSON.stringify(identity));
  }

  async claimUpdate(updateId: number): Promise<boolean> {
    const key = `${UPDATE_PREFIX}${updateId}`;
    if ((await this.kv.get(key)) !== null) return false;
    await this.kv.put(key, "1", { expirationTtl: 25 * 60 * 60 });
    return true;
  }
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
