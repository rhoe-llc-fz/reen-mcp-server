/**
 * HTTP client wrapper для REEN backend API.
 * Retry на 429/5xx, exponential backoff, redact токенов в логах.
 */
const DEFAULT_BASE_URL = "https://backend.reen.tech";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
export class ReenClient {
    baseUrl;
    token;
    constructor(opts) {
        this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
        this.token = opts.token;
    }
    /** Выполнить запрос к REEN API с retry */
    async request(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
                await sleep(delay);
                log(`Retry ${attempt}/${MAX_RETRIES} for ${method} ${path}`);
            }
            try {
                const headers = {
                    "Authorization": `Bearer ${this.token}`,
                    "Content-Type": "application/json",
                    "User-Agent": "reen-mcp-server/0.1.0",
                };
                const res = await fetch(url, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                });
                // Retry на 429 и 5xx
                if (res.status === 429 || res.status >= 500) {
                    lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
                    if (attempt < MAX_RETRIES)
                        continue;
                }
                if (!res.ok) {
                    const text = await res.text().catch(() => "");
                    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
                }
                return (await res.json());
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                // Network errors — retry
                if (attempt < MAX_RETRIES && isRetryable(lastError))
                    continue;
                throw lastError;
            }
        }
        throw lastError || new Error("Request failed");
    }
    // Шорткаты
    get(path) {
        return this.request("GET", path);
    }
    post(path, body) {
        return this.request("POST", path, body);
    }
    put(path, body) {
        return this.request("PUT", path, body);
    }
    patch(path, body) {
        return this.request("PATCH", path, body);
    }
    delete(path, body) {
        return this.request("DELETE", path, body);
    }
}
function isRetryable(err) {
    const msg = err.message.toLowerCase();
    return (msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("etimedout") ||
        msg.includes("fetch failed") ||
        msg.includes("http 429") ||
        msg.includes("http 5"));
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** Логирование в stderr (stdout занят JSON-RPC) */
export function log(msg) {
    // Redact токенов в логах
    const safe = msg.replace(/reen_[a-f0-9]{64}/g, "reen_***REDACTED***");
    process.stderr.write(`[reen-mcp] ${safe}\n`);
}
//# sourceMappingURL=client.js.map