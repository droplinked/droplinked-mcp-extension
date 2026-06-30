import { z } from "zod";
import { ACP_FEED_PATH, DROPLINKED_API_BASE } from "../config.js";

/**
 * `get_feed` — returns a pointer to droplinked's public product feed so
 * an agent can fetch the canonical catalogue snapshot. As of feed v2,
 * every item carries a `verification` block (brand_verified, kyb_tier,
 * attestation_uid, attestation_chain).
 */

export const getFeedInput = z.object({}).strict();

export type GetFeedInput = z.infer<typeof getFeedInput>;

export async function getFeed(_input: GetFeedInput = {}) {
  const feedUrl = `${DROPLINKED_API_BASE}${ACP_FEED_PATH}`;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            description:
              "Pointer to the droplinked public product feed. As of " +
              "feed v2, every item carries a `verification` block: " +
              "{ brand_verified, kyb_tier, attestation_uid, " +
              "attestation_chain }. The feed payload includes a top-level " +
              "`version: 2` field so consumers can prefer verification-" +
              "aware feeds.",
            feedUrl,
            format: "application/json",
            feed_version: 2,
            advertises_verification: true,
          },
          null,
          2,
        ),
      },
    ],
  };
}

export const getFeedTool = {
  name: "get_feed",
  description:
    "Return the URL of the droplinked public product feed so an agent " +
    "can fetch the canonical catalogue snapshot. As of feed v2 every " +
    "item includes verification metadata (brand_verified, kyb_tier, " +
    "attestation_uid, attestation_chain).",
  inputSchema: getFeedInput,
  annotations: {
    title: "Get Product Feed",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: getFeed,
};
