import { DROPLINKED_API_BASE } from "../config.js";

/**
 * Shared HTTP client for droplinked's public API. Wraps the two public
 * surfaces the discovery tools need:
 *
 *   1. Public REST reads (e.g. `/shops/v2/public/...`,
 *      `/v2/attestations/...`, `/v2/trust-fabric/stats`).
 *   2. The public MCP transport (`POST /mcp/v1/tools/call`) used by the
 *      catalogue search tools (`searchProducts`, `listMerchants`).
 *
 * Centralising the client keeps timeout / error-mapping behaviour in one
 * place. Error messages never include backend-side detail beyond the
 * status code.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

export interface BackendGetOptions {
  /** Tolerate a 404 by returning null instead of throwing. */
  allow404?: boolean;
  /** Override the default 8s timeout. */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/**
 * GET a JSON payload from the public API. Path is relative to
 * `DROPLINKED_API_BASE` unless it already starts with `http`.
 *
 * Throws on non-OK responses unless `allow404` is set and the response
 * is a 404 (in which case it returns `null`).
 */
export async function getJson<T = unknown>(
  fetchImpl: typeof fetch,
  path: string,
  options: BackendGetOptions = {},
): Promise<T | null> {
  const url = path.startsWith("http") ? path : `${DROPLINKED_API_BASE}${path}`;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (res.status === 404 && options.allow404) return null;
    if (!res.ok) {
      throw new Error(`droplinked GET ${path} -> ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Envelope returned by the public MCP transport
 * (`POST /mcp/v1/tools/call`). The tool payload is JSON-encoded inside
 * `content[0].text`.
 */
interface McpToolCallEnvelope {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Call a droplinked catalogue tool via the public MCP transport.
 *
 * Returns the parsed tool payload (not the MCP envelope), or `null` if
 * the envelope was empty or parsing failed. Throws on transport errors
 * or `isError: true` envelopes.
 */
export async function callBackendMcpTool<T = unknown>(
  fetchImpl: typeof fetch,
  name: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<T | null> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${DROPLINKED_API_BASE}/mcp/v1/tools/call`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, arguments: args }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`droplinked MCP tools/call(${name}) -> ${res.status}`);
    }
    const envelope = (await res.json()) as McpToolCallEnvelope;
    if (envelope.isError) {
      throw new Error(`droplinked MCP tools/call(${name}) returned an error`);
    }
    const text = envelope.content?.[0]?.text;
    if (typeof text !== "string") return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}
