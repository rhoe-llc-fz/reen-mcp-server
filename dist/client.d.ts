/**
 * HTTP client wrapper для REEN backend API.
 * Retry на 429/5xx, exponential backoff, redact токенов в логах.
 */
export interface ClientOptions {
    baseUrl?: string;
    token: string;
}
export declare class ReenClient {
    private baseUrl;
    private token;
    constructor(opts: ClientOptions);
    /** Выполнить запрос к REEN API с retry */
    request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
    get<T = unknown>(path: string): Promise<T>;
    post<T = unknown>(path: string, body?: unknown): Promise<T>;
    put<T = unknown>(path: string, body?: unknown): Promise<T>;
    patch<T = unknown>(path: string, body?: unknown): Promise<T>;
    delete<T = unknown>(path: string, body?: unknown): Promise<T>;
}
/** Логирование в stderr (stdout занят JSON-RPC) */
export declare function log(msg: string): void;
//# sourceMappingURL=client.d.ts.map