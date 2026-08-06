export interface ReferenceGroupRecord {
  chatId: string;
  name: string;
  active: boolean;
  nicheCount: number;
  sentCount: number;
  pendingCount: number;
  niches: string[];
}

export interface ReferenceCategoryRecord {
  key: string;
  title: string;
  count: number;
  selectedCount: number;
}

export interface ReferenceDiscoveredItem {
  id: string;
  sourceUrl: string;
  downloadUrl?: string;
  description?: string;
  hashtags?: string[];
  niches?: Array<{ slug: string; title?: string }>;
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
  niches: Array<{ slug: string; title: string }>;
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
  groupChatId: string;
  groupName: string;
  mediaId: string;
  warehouseChatId: string;
  warehouseMessageId: string;
}

export interface ReferenceStats {
  enabled: boolean;
  groups: number;
  activeGroups: number;
  catalogNiches: number;
  catalogVersion: string;
  catalogStoredNiches: number;
  catalogReady: boolean;
  storedMedia: number;
  pendingUploads: number;
  pendingDeliveries: number;
  sentDeliveries: number;
  failedNiches: number;
  failedUploads: number;
  failedDeliveries: number;
  lastScanAt?: number;
}
