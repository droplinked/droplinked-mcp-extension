import { z } from "zod";
import { getJson } from "../utils/backend-api-client.js";

/**
 * `verify_brand_attestation` — resolve the standalone EAS brand
 * attestation for a single shop slug via the public
 * `GET /v2/attestations/brand/<slug>` endpoint.
 *
 * `find_inventory` returns an `attestationUid` on every verified item;
 * the consumer agent round-trips that slug through this tool to get back
 * the canonical attestation row before rendering trust to the buyer.
 *
 * Gracefully degrades to `verified: false` (with null fields) on a
 * missing brand, 404, or transport error so the response shape stays
 * stable and the agent can always cite trust state.
 */

export const verifyBrandAttestationInput = z.object({
  brandSlug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$/, {
      message: "brandSlug must be a valid shop URL slug",
    }),
});

export type VerifyBrandAttestationInput = z.infer<
  typeof verifyBrandAttestationInput
>;

export const brandAttestationSchema = z.object({
  brandSlug: z.string(),
  verified: z.boolean(),
  since: z.string().nullable(),
  signer: z.string().nullable(),
  chain: z.enum(["base", "optimism", "arbitrum"]).nullable(),
  attestationUid: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export type BrandAttestation = z.infer<typeof brandAttestationSchema>;

interface BackendAttestationPayload {
  found?: boolean;
  attestationUid?: string | null;
  brandSlug?: string;
  chain?: string | null;
  schemaUid?: string | null;
  issuedAt?: string | null;
  expiresAt?: string | null;
  status?: string | null;
  issuer?: string | null;
  revokedAt?: string | null;
  attestationData?: {
    brandName?: string | null;
    verifiedSince?: string | null;
    kybCohort?: string | null;
    offchainProjectionId?: string | null;
    [k: string]: unknown;
  } | null;
  explorerUrl?: string | null;
  [k: string]: unknown;
}

/**
 * Collapse the backend's `chain` value onto the consumer enum. Testnet
 * variants (e.g. `base-sepolia`) collapse to their mainnet name so the
 * agent-facing enum stays clean; the EAS UID still pins the exact chain.
 */
function mapChain(
  backendChain: string | null | undefined,
): BrandAttestation["chain"] {
  if (!backendChain) return null;
  const lc = backendChain.toLowerCase();
  if (lc === "base" || lc === "base-sepolia" || lc === "base-goerli") {
    return "base";
  }
  if (lc === "optimism" || lc === "optimism-sepolia" || lc === "op-sepolia") {
    return "optimism";
  }
  if (lc === "arbitrum" || lc === "arbitrum-sepolia") {
    return "arbitrum";
  }
  return null;
}

function project(
  raw: unknown,
  input: VerifyBrandAttestationInput,
): BrandAttestation {
  const brandSlug = input.brandSlug;
  const body: BackendAttestationPayload | null =
    raw && typeof raw === "object" ? (raw as BackendAttestationPayload) : null;

  if (!body || body.found !== true) {
    return {
      brandSlug,
      verified: false,
      since: null,
      signer: null,
      chain: null,
      attestationUid: null,
      revokedAt: body?.revokedAt ?? null,
    };
  }

  const status = typeof body.status === "string" ? body.status : null;
  const verified = status === "ACTIVE";
  const chain = mapChain(body.chain);
  const since: string | null =
    body.attestationData?.verifiedSince ?? body.issuedAt ?? null;
  const signer: string | null = verified
    ? body.issuer && typeof body.issuer === "string"
      ? body.issuer
      : "droplinked-eas-issuer@v1"
    : null;
  const attestationUid =
    typeof body.attestationUid === "string" ? body.attestationUid : null;
  const revokedAt =
    typeof body.revokedAt === "string" ? body.revokedAt : null;

  return { brandSlug, verified, since, signer, chain, attestationUid, revokedAt };
}

export async function verifyBrandAttestation(
  input: VerifyBrandAttestationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  let raw: unknown = null;
  try {
    raw = await getJson(
      fetchImpl,
      `/v2/attestations/brand/${encodeURIComponent(input.brandSlug)}`,
      { allow404: true },
    );
  } catch {
    raw = null;
  }
  const projected = project(raw, input);
  return {
    content: [{ type: "text", text: JSON.stringify(projected, null, 2) }],
  };
}

export const verifyBrandAttestationTool = {
  name: "verify_brand_attestation",
  description:
    "Resolve the standalone droplinked brand attestation for a single " +
    "shop slug. Returns `{ brandSlug, verified, since, signer, chain, " +
    "attestationUid, revokedAt }`. Use this AFTER `find_inventory` to " +
    "round-trip a brand slug and render the canonical trust row to the " +
    "buyer before proceeding. Gracefully degrades to `verified=false` " +
    "on error / missing brand — the response shape is stable so the " +
    "agent can always cite trust state.",
  inputSchema: verifyBrandAttestationInput,
  annotations: {
    title: "Verify Brand Attestation",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: verifyBrandAttestation,
};
