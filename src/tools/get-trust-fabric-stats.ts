import { z } from "zod";
import { getJson } from "../utils/backend-api-client.js";

/**
 * `get_trust_fabric_stats` — public platform-scale snapshot.
 *
 * Wraps the public `GET /v2/trust-fabric/stats` read and projects an
 * aggregate-only, brand-neutral view of droplinked's trust fabric:
 * registered service providers, the count of verified partners, and the
 * on-chain attestation totals by schema. No auth, no PII, no per-row
 * data — only aggregate counts cross the wire.
 *
 * Use this to gauge platform scale before issuing per-merchant
 * verification queries, or to render a partner-facing stat strip.
 *
 * Gracefully degrades to an all-zero envelope (with `asOf` set to the
 * current time) on 404 / transport error / malformed payload, so the
 * agent can always cite "no platform scale on file yet".
 */

export const getTrustFabricStatsInput = z.object({});

export type GetTrustFabricStatsInput = z.infer<typeof getTrustFabricStatsInput>;

interface RegistryCounts {
  total: number;
  active: number;
  pendingKyb: number;
  suspended: number;
  archived: number;
}

interface AttestationCounts {
  schemaA: number;
  schemaB: number;
  schemaC: number;
  schemaD: number;
}

interface TrustFabricStats {
  asOf: string;
  serviceProviders: RegistryCounts;
  verifiedPartners: number;
  attestations: AttestationCounts;
}

interface BackendPayload {
  asOf?: string;
  serviceProviders?: Partial<RegistryCounts> & Record<string, unknown>;
  attestations?: Partial<AttestationCounts> & Record<string, unknown>;
  [k: string]: unknown;
}

function toNonNegativeInt(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function mapRegistryCounts(
  raw: (Partial<RegistryCounts> & Record<string, unknown>) | undefined,
): RegistryCounts {
  const source = raw ?? {};
  return {
    total: toNonNegativeInt(source.total),
    active: toNonNegativeInt(source.active),
    pendingKyb: toNonNegativeInt(source.pendingKyb),
    suspended: toNonNegativeInt(source.suspended),
    archived: toNonNegativeInt(source.archived),
  };
}

function mapAttestationCounts(
  raw: (Partial<AttestationCounts> & Record<string, unknown>) | undefined,
): AttestationCounts {
  const source = raw ?? {};
  return {
    schemaA: toNonNegativeInt(source.schemaA),
    schemaB: toNonNegativeInt(source.schemaB),
    schemaC: toNonNegativeInt(source.schemaC),
    schemaD: toNonNegativeInt(source.schemaD),
  };
}

const CLEAN_SLATE = (): TrustFabricStats => ({
  asOf: new Date().toISOString(),
  serviceProviders: {
    total: 0,
    active: 0,
    pendingKyb: 0,
    suspended: 0,
    archived: 0,
  },
  verifiedPartners: 0,
  attestations: { schemaA: 0, schemaB: 0, schemaC: 0, schemaD: 0 },
});

function project(raw: unknown): TrustFabricStats {
  // Tolerate the optional `{ statusCode, message, data }` envelope.
  let body: BackendPayload | null =
    raw && typeof raw === "object" ? (raw as BackendPayload) : null;
  if (
    body &&
    body.attestations === undefined &&
    body.serviceProviders === undefined &&
    typeof (body as { data?: unknown }).data === "object" &&
    (body as { data?: unknown }).data !== null
  ) {
    body = (body as { data: BackendPayload }).data;
  }

  if (!body) return CLEAN_SLATE();

  const serviceProviders = mapRegistryCounts(body.serviceProviders);
  const attestations = mapAttestationCounts(body.attestations);
  const verifiedPartners =
    attestations.schemaA +
    attestations.schemaB +
    attestations.schemaC +
    attestations.schemaD;

  return {
    asOf: typeof body.asOf === "string" ? body.asOf : new Date().toISOString(),
    serviceProviders,
    verifiedPartners,
    attestations,
  };
}

export async function getTrustFabricStats(
  _input: GetTrustFabricStatsInput = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  let raw: unknown = null;
  try {
    raw = await getJson(fetchImpl, `/v2/trust-fabric/stats`, {
      allow404: true,
    });
  } catch {
    raw = null;
  }
  const projected = project(raw);
  return {
    content: [{ type: "text", text: JSON.stringify(projected, null, 2) }],
  };
}

export const getTrustFabricStatsTool = {
  name: "get_trust_fabric_stats",
  description:
    "Return aggregate-only counts for the droplinked trust fabric: " +
    "registered service providers, the number of verified partners, " +
    "and on-chain attestation totals by schema. Public read, no auth, " +
    "no PII, no per-row data. Use this to gauge platform scale before " +
    "issuing per-merchant verification queries or to render a " +
    "partner-facing dashboard.",
  inputSchema: getTrustFabricStatsInput,
  annotations: {
    title: "Get Trust Fabric Stats",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: getTrustFabricStats,
};
