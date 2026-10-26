export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | (string & {});

export interface KeyValueParam {
  key: string;
  value: string;
  enabled?: boolean;
  description?: string;
  secret?: boolean;
  fileId?: string;
  fileName?: string;
}

export type AuthType =
  | "none"
  | "inherit"
  | "bearer"
  | "basic"
  | "apikey"
  | "oauth2"
  | "unsupported";

export interface AuthConfig {
  type: AuthType;
  oauthConnectionId?: string;
  originalType?: string;
  postman?: Record<string, any>;
  bearerToken?: string;
  basicUsername?: string;
  basicPassword?: string;
  apiKeyName?: string;
  apiKeyValue?: string;
  apiKeyIn?: "header" | "query";
}

export type BodyMode =
  | "binary"
  | "none"
  | "raw-json"
  | "raw-text"
  | "form-data"
  | "x-www-form-urlencoded"
  | "unsupported";

export interface RequestBody {
  mode: BodyMode;
  raw?: string;
  fileId?: string;
  schema?: Record<string, unknown>;
  formData?: KeyValueParam[];
  postman?: Record<string, any>;
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
  preRequestScripts?: string[];
  testScripts?: string[];
  timeoutMs?: number;
  followRedirects?: boolean;
  streamResponse?: boolean;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  tls?: { ca?: string; cert?: string; keyRef?: string; passphraseRef?: string };
  postman?: Record<string, any>;
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
  /** Indicates transport was attempted, not a guarantee about remote side effects. */
  transportAttempted?: boolean;
  persistence?: {
    environment: {
      status: "saved" | "conflict" | "failed";
      revision?: string;
      code?: string;
      message?: string;
    };
  };
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
  headerEntries?: Array<[string, string]>;
  artifactId?: string;
  previewTruncated?: boolean;
  bodyBase64?: string;
  bodyEncoding?: "utf8" | "base64";
  updatedEnvironment?: Record<string, string>;
  updatedLocalVariables?: Record<string, string>;
  updatedCollectionVariables?: Record<string, string>;
  updatedGlobals?: Record<string, string>;
  nextRequest?: string | null;
  skipRequest?: boolean;
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
  auth?: AuthConfig;
  variables?: KeyValueParam[];
  preRequestScript?: string;
  testScript?: string;
  postman?: Record<string, any>;
}

export interface ApiCollection {
  /** Workspace content revision; excluded from canonical JSON files. */
  revision?: string;
  id: string;
  name: string;
  description?: string;
  schemaVersion: string;
  variables: KeyValueParam[];
  auth?: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
  postman?: Record<string, any>;
  importWarnings?: string[];
  items: CollectionItem[];
}

export interface Environment {
  revision?: string;
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
  queryParamEntries?: Array<[string, string]>;
  redaction?: { version: number; applied: boolean; bodyOmitted?: boolean };
  requestHeaders: Record<string, string>;
  requestBody?: any;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: any;
  durationMs: number;
}
