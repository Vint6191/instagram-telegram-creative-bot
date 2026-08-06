export interface ReferenceNicheRecord {
  slug: string;
  title: string;
  active: boolean;
  catalogPresent: boolean;
  thumbnailUrl?: string;
  modelCount: number;
  mediaCount: number;
  lastScannedAt?: number;
  nextScanAt: number;
}

export interface ReferenceModelRecord {
  chatId: string;
  name: string;
  active: boolean;
  nicheCount: number;
  deliveryCount: number;
  niches: string[];
}

export interface ReferenceCatalogLease {
  leaseToken: string;
}

export interface ReferenceCatalogItem {
  slug: string;
  title: string;
  thumbnailUrl?: string;
}

export interface ReferenceDiscoveredItem {
  id: string;
  sourceUrl: string;
  downloadUrl?: string;
  description?: string;
  hashtags?: string[];
  niches?: Array<{ slug: string; title: string; thumbnailUrl?: string }>;
  author?: string;
  views?: number;
  likes?: number;
  duration?: number;
  hotRank?: number;
}

export interface ReferenceUploadTask {
  id: string;
  sourceUrl: string;
  downloadUrl?: string;
  description?: string;
  hashtags: string[];
  niches: Array<{ slug: string; title: string; thumbnailUrl?: string }>;
  author?: string;
  views?: number;
  likes?: number;
  duration?: number;
}

export interface ReferenceUploadLease extends ReferenceUploadTask {
  leaseToken: string;
}

export interface ReferenceScanLease {
  slug: string;
  title: string;
  leaseToken: string;
}

export interface ReferenceDeliveryLease {
  id: string;
  leaseToken: string;
  modelChatId: string;
  modelName: string;
  mediaId: string;
  fileId: string;
  warehouseChatId?: string;
  warehouseMessageId?: string;
  sourceUrl: string;
  description?: string;
  hashtags: string[];
  niches: Array<{ slug: string; title: string; thumbnailUrl?: string }>;
  views?: number;
  likes?: number;
  duration?: number;
}

export interface ReferenceStats {
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
}
