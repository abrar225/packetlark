export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface KeyValueParam {
  key: string;
  value: string;
  enabled?: boolean;
  description?: string;
  secret?: boolean;
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';

export interface AuthConfig {
  type: AuthType;
  bearerToken?: string;
  basicUsername?: string;
  basicPassword?: string;
  apiKeyName?: string;
  apiKeyValue?: string;
  apiKeyIn?: 'header' | 'query';
}

export type BodyMode = 'none' | 'raw-json' | 'raw-text' | 'form-data' | 'x-www-form-urlencoded';

export interface RequestBody {
  mode: BodyMode;
  raw?: string;
  formData?: KeyValueParam[];
}

export interface HttpRequest {
  id?: string;
  name?: string;
  method: HttpMethod;
  url: string;
  headers: KeyValueParam[];
  queryParams: KeyValueParam[];
  body: RequestBody;
  auth: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
}

export interface TimingMetrics {
  dnsLookupMs?: number;
  tcpHandshakeMs?: number;
  tlsNegotiationMs?: number;
  firstByteMs: number;
  totalMs: number;
}

export interface ApiErrorDetail {
  category: string;
  message: string;
  guidance: string;
  code?: string;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  sizeBytes: number;
  timings: TimingMetrics;
  testResults?: TestAssertionResult[];
  logs?: string[];
  updatedVariables?: Record<string, string>;
  error?: ApiErrorDetail;
}

export interface TestAssertionResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface CollectionItem {
  id: string;
  name: string;
  description?: string;
  isFolder?: boolean;
  request?: HttpRequest;
  items?: CollectionItem[];
}

export interface ApiCollection {
  id: string;
  name: string;
  description?: string;
  schemaVersion: string;
  variables: KeyValueParam[];
  auth?: AuthConfig;
  items: CollectionItem[];
}

export interface Environment {
  id: string;
  name: string;
  values: KeyValueParam[];
}

export interface SniffedTrafficItem {
  id: string;
  timestamp: string;
  method: HttpMethod;
  url: string;
  pathname: string;
  queryParams: Record<string, string>;
  requestHeaders: Record<string, string>;
  requestBody?: any;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: any;
  durationMs: number;
}
