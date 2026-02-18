/**
 * HTTP client wrapper for REEN backend API.
 * Retry on 429/5xx, exponential backoff, token redaction in logs.
 */
export interface ClientOptions {
    baseUrl?: string;
    token: string;
}
export declare class ReenClient {
    private baseUrl;
    private token;
    constructor(opts: ClientOptions);
    /** Execute a request to the REEN API with retry */
    request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
    get<T = unknown>(path: string): Promise<T>;
    post<T = unknown>(path: string, body?: unknown): Promise<T>;
    put<T = unknown>(path: string, body?: unknown): Promise<T>;
    patch<T = unknown>(path: string, body?: unknown): Promise<T>;
    delete<T = unknown>(path: string, body?: unknown): Promise<T>;
}
/** Log to stderr (stdout is reserved for JSON-RPC) */
export declare function log(msg: string): void;
//# sourceMappingURL=client.d.ts.map