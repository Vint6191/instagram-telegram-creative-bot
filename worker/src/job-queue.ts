import { DurableObject } from "cloudflare:workers";
import { CreativeQueueRepository } from "./creative-queue";
import { ReferenceQueueRepository } from "./reference-queue";
import type {
  Env,
  LeasedJob,
  QueueJobInput,
  QueueJobRecord,
  QueueStage,
  QueueStats,
} from "./types";
import type {
  ReferenceCatalogCategoryRecord,
  ReferenceCategoryRecord,
  ReferenceDeliveryLease,
  ReferenceDiscoveredItem,
  ReferenceGroupRecord,
  ReferenceScanLease,
  ReferenceStats,
  ReferenceUploadLease,
  ReferenceUploadTask,
} from "./reference-types";

export class JobQueue extends DurableObject<Env> {
  private readonly creatives: CreativeQueueRepository;
  private readonly references: ReferenceQueueRepository;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.creatives = new CreativeQueueRepository(this.ctx.storage.sql);
    this.references = new ReferenceQueueRepository(this.ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      this.creatives.init();
      this.references.init();
    });
  }

  async leaseTelegramUpdate(updateId: string | number): Promise<string | null> {
    return this.creatives.leaseTelegramUpdate(updateId);
  }

  async completeTelegramUpdate(updateId: string | number, leaseToken: string): Promise<boolean> {
    return this.creatives.completeTelegramUpdate(updateId, leaseToken);
  }

  async failTelegramUpdate(updateId: string | number, leaseToken: string): Promise<void> {
    this.creatives.failTelegramUpdate(updateId, leaseToken);
  }

  async touchAgent(agentId: string, hostname?: string, appVersion?: string): Promise<void> {
    this.creatives.touchAgent(agentId, hostname, appVersion);
  }

  async enqueue(input: QueueJobInput): Promise<{ job: QueueJobRecord; position: number; duplicate: boolean }> {
    return this.creatives.enqueue(input);
  }

  async leaseNext(agentId: string): Promise<LeasedJob | null> {
    return this.creatives.leaseNext(agentId);
  }

  async heartbeat(agentId: string, jobId: string, leaseToken: string): Promise<QueueJobRecord | null> {
    return this.creatives.heartbeat(agentId, jobId, leaseToken);
  }

  async updateProgress(
    agentId: string,
    jobId: string,
    leaseToken: string,
    stage: QueueStage,
  ): Promise<QueueJobRecord | null> {
    return this.creatives.updateProgress(agentId, jobId, leaseToken, stage);
  }

  async complete(agentId: string, jobId: string, leaseToken: string): Promise<QueueJobRecord | null> {
    return this.creatives.complete(agentId, jobId, leaseToken);
  }

  async fail(
    agentId: string,
    jobId: string,
    leaseToken: string,
    error: string,
    retryable: boolean,
    retryAfterSeconds: number,
  ): Promise<{ job: QueueJobRecord; willRetry: boolean } | null> {
    return this.creatives.fail(agentId, jobId, leaseToken, error, retryable, retryAfterSeconds);
  }

  async stats(): Promise<QueueStats> {
    return this.creatives.stats();
  }

  async setReferencesEnabled(enabled: boolean): Promise<void> {
    this.references.setEnabled(enabled);
  }

  async registerReferenceGroup(chatId: string, name: string): Promise<ReferenceGroupRecord> {
    return this.references.registerGroup(chatId, name);
  }

  async renameReferenceGroup(chatId: string, name: string): Promise<ReferenceGroupRecord> {
    return this.references.renameGroup(chatId, name);
  }

  async setReferenceGroupActive(chatId: string, active: boolean): Promise<ReferenceGroupRecord> {
    return this.references.setGroupActive(chatId, active);
  }

  async removeReferenceGroup(chatId: string): Promise<void> {
    this.references.removeGroup(chatId);
  }

  async listReferenceGroups(): Promise<ReferenceGroupRecord[]> {
    return this.references.listGroups();
  }

  async getReferenceGroup(chatId: string): Promise<ReferenceGroupRecord> {
    return this.references.getGroup(chatId);
  }

  async listReferenceCategories(chatId: string): Promise<ReferenceCategoryRecord[]> {
    return this.references.listCategories(chatId);
  }

  async listReferenceCatalogCategories(): Promise<ReferenceCatalogCategoryRecord[]> {
    return this.references.listCatalogCategories();
  }

  async listReferenceDisabledNiches(): Promise<string[]> {
    return this.references.listDisabledNiches();
  }

  async setReferenceCatalogNicheEnabled(slug: string, enabled: boolean): Promise<boolean> {
    return this.references.setCatalogNicheEnabled(slug, enabled);
  }

  async setReferenceCatalogCategoryEnabled(
    category: string,
    enabled: boolean,
  ): Promise<{ enabledCount: number; disabledCount: number }> {
    return this.references.setCatalogCategoryEnabled(category, enabled);
  }

  async setReferenceGroupNiche(
    chatId: string,
    slug: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean; queued: number }> {
    return this.references.setGroupNiche(chatId, slug, enabled);
  }

  async toggleReferenceGroupNiche(
    chatId: string,
    slug: string,
  ): Promise<{ enabled: boolean; queued: number }> {
    return this.references.toggleGroupNiche(chatId, slug);
  }

  async setReferenceGroupCategory(
    chatId: string,
    category: string,
    enabled: boolean,
  ): Promise<{ selected: number; queued: number }> {
    return this.references.setGroupCategory(chatId, category, enabled);
  }

  async referenceStats(): Promise<ReferenceStats> {
    return this.references.stats();
  }

  async retryReferenceFailures(): Promise<{ niches: number; uploads: number; deliveries: number }> {
    return this.references.retryFailures();
  }

  async leaseReferenceScan(agentId: string): Promise<ReferenceScanLease | null> {
    return this.references.leaseScan(agentId);
  }

  async completeReferenceScan(agentId: string, slug: string, leaseToken: string): Promise<boolean> {
    return this.references.completeScan(agentId, slug, leaseToken);
  }

  async failReferenceScan(agentId: string, slug: string, leaseToken: string, error: string): Promise<boolean> {
    return this.references.failScan(agentId, slug, leaseToken, error);
  }

  async discoverReferenceItems(
    agentId: string,
    nicheSlug: string,
    leaseToken: string,
    items: ReferenceDiscoveredItem[],
  ): Promise<ReferenceUploadTask[]> {
    return this.references.discover(agentId, nicheSlug, leaseToken, items);
  }

  async enrichReferenceItem(
    mediaId: string,
    item: ReferenceDiscoveredItem,
  ): Promise<ReferenceUploadTask | null> {
    return this.references.enrich(mediaId, item);
  }

  async leaseReferenceUpload(
    agentId: string,
    warehouseChatId: string,
  ): Promise<ReferenceUploadLease | null> {
    return this.references.leaseUpload(agentId, warehouseChatId);
  }

  async completeReferenceUpload(
    agentId: string,
    mediaId: string,
    leaseToken: string,
    fileId: string,
    fileUniqueId: string | undefined,
    warehouseChatId: string,
    warehouseMessageId: string,
  ): Promise<{ queuedDeliveries: number } | null> {
    return this.references.completeUpload(
      agentId,
      mediaId,
      leaseToken,
      fileId,
      fileUniqueId,
      warehouseChatId,
      warehouseMessageId,
    );
  }

  async failReferenceUpload(
    agentId: string,
    mediaId: string,
    leaseToken: string,
    error: string,
    retryAfterSeconds: number,
  ): Promise<boolean> {
    return this.references.failUpload(agentId, mediaId, leaseToken, error, retryAfterSeconds);
  }

  async reconcileReferenceUpload(
    mediaId: string,
    fileId: string,
    fileUniqueId: string | undefined,
    warehouseChatId: string,
    warehouseMessageId: string,
  ): Promise<{ queuedDeliveries: number; alreadyStored: boolean }> {
    return this.references.reconcileUpload(
      mediaId,
      fileId,
      fileUniqueId,
      warehouseChatId,
      warehouseMessageId,
    );
  }

  async reconcileReferenceDelivery(
    deliveryId: string,
    telegramMessageId: string,
  ): Promise<boolean> {
    return this.references.reconcileDelivery(deliveryId, telegramMessageId);
  }

  async leaseReferenceDelivery(agentId: string): Promise<ReferenceDeliveryLease | null> {
    return this.references.leaseDelivery(agentId);
  }

  async completeReferenceDelivery(
    agentId: string,
    deliveryId: string,
    leaseToken: string,
    telegramMessageId: string,
  ): Promise<boolean> {
    return this.references.completeDelivery(agentId, deliveryId, leaseToken, telegramMessageId);
  }

  async failReferenceDelivery(
    agentId: string,
    deliveryId: string,
    leaseToken: string,
    error: string,
    retryAfterSeconds: number,
  ): Promise<boolean> {
    return this.references.failDelivery(agentId, deliveryId, leaseToken, error, retryAfterSeconds);
  }
}
