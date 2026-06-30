/**
 * Runtime configuration for the droplinked discovery MCP server.
 *
 * All values are read from the environment at module load with public,
 * production-safe defaults so the extension works out of the box with
 * no configuration.
 */

/** Base URL for droplinked's public API (apiv3). */
export const DROPLINKED_API_BASE =
  process.env.DROPLINKED_API_BASE ?? "https://apiv3.droplinked.com";

/** Base URL for public droplinked storefronts. */
export const DROPLINKED_PUBLIC_BASE =
  process.env.DROPLINKED_PUBLIC_BASE ?? "https://droplinked.com";

/** Path of the public product feed, relative to the API base. */
export const ACP_FEED_PATH = process.env.ACP_FEED_PATH ?? "/feed/acp.json";
