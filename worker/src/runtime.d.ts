interface KVNamespaceListKey<Metadata = unknown> {
  name: string;
  expiration?: number;
  metadata?: Metadata;
}

interface KVNamespaceListResult<Metadata = unknown> {
  keys: KVNamespaceListKey<Metadata>[];
  list_complete: boolean;
  cursor?: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list<Metadata = unknown>(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KVNamespaceListResult<Metadata>>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
