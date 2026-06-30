import { z } from "zod";
import { getJson } from "../utils/backend-api-client.js";

/**
 * `get_brand_attestation_status` — poll the brand attestation request
 * lifecycle for a shop via
 * `GET /v2/attestations/brand/:shopSlug/request-status`.
 *
 *   NOT_REQUESTED -> PENDING -> APPROVED -> MINTED
 *                                       \-> REJECTED
 *
 * Gracefully degrades to NOT_REQUESTED on 404 / transport error /
 * malformed payload so the agent can always cite request state.
 */

export const getBrandAttestationStatusInput = z.object({
  shopSlug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9_-]{3,64}$/, {
      message:
        "shopSlug must be 3-64 chars of lowercase alphanumerics, dashes, or underscores",
    }),
});

export type GetBrandAttestationStatusInput = z.infer<
  typeof getBrandAttestationStatusInput
>;

export const brandAttestationStatusSchema = z.object({
  shopSlug: z.string(),
  status: z.enum([
    "NOT_REQUESTED",
    "PENDING",
    "APPROVED",
    "MINTED",
    "REJECTED",
  ]),
  attestationUid: z.string().nullable(),
  mintedAt: z.string().nullable(),
});

export type BrandAttestationStatus = z.infer<
  typeof brandAttestationStatusSchema
>;

type RequestStatus = BrandAttestationStatus["status"];

interface BackendStatusPayload {
  status?: string | null;
  attestationUid?: string | null;
  mintedAt?: string | null;
  [k: string]: unknown;
}

function mapStatus(raw: unknown): RequestStatus | null {
  if (
    raw === "PENDING" ||
    raw === "APPROVED" ||
    raw === "MINTED" ||
    raw === "REJECTED" ||
    raw === "NOT_REQUESTED"
  ) {
    return raw;
  }
  return null;
}

function project(
  raw: unknown,
  input: GetBrandAttestationStatusInput,
): BrandAttestationStatus {
  const { shopSlug } = input;

  // Tolerate the optional `{ statusCode, message, data }` envelope.
  let body: BackendStatusPayload | null =
    raw && typeof raw === "object" ? (raw as BackendStatusPayload) : null;
  if (
    body &&
    body.status === undefined &&
    typeof (body as { data?: unknown }).data === "object" &&
    (body as { data?: unknown }).data !== null
  ) {
    body = (body as { data: BackendStatusPayload }).data;
  }

  if (!body) {
    return {
      shopSlug,
      status: "NOT_REQUESTED",
      attestationUid: null,
      mintedAt: null,
    };
  }

  const status = mapStatus(body.status) ?? "NOT_REQUESTED";
  const attestationUid =
    typeof body.attestationUid === "string" ? body.attestationUid : null;
  const mintedAt =
    typeof body.mintedAt === "string" ? body.mintedAt : null;

  return {
    shopSlug,
    status,
    attestationUid: status === "MINTED" ? attestationUid : null,
    mintedAt: status === "MINTED" ? mintedAt : null,
  };
}

export async function getBrandAttestationStatus(
  input: GetBrandAttestationStatusInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  let raw: unknown = null;
  try {
    raw = await getJson(
      fetchImpl,
      `/v2/attestations/brand/${encodeURIComponent(input.shopSlug)}/request-status`,
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

export const getBrandAttestationStatusTool = {
  name: "get_brand_attestation_status",
  description:
    "Poll the brand attestation request status for a droplinked shop. " +
    "Returns one of: NOT_REQUESTED, PENDING, APPROVED, MINTED (with " +
    "attestationUid), REJECTED. Use this to surface progress to " +
    "merchants after they submit a request.",
  inputSchema: getBrandAttestationStatusInput,
  annotations: {
    title: "Get Brand Attestation Status",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: getBrandAttestationStatus,
};
