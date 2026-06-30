import { z } from "zod";
import { DROPLINKED_PUBLIC_BASE } from "../config.js";
import { shapeRecord } from "../utils/sanitise.js";
import { getJson } from "../utils/backend-api-client.js";

/**
 * `find_affiliate_programs` — discover droplinked affiliate programs by
 * vertical, commission rate, payout type, and on-chain attestation
 * status. Thin wrapper around the public
 * `GET /v2/affiliate-marketplace/programs` read endpoint.
 *
 * On backend error returns a "degraded" empty listing so the calling
 * agent can fall back gracefully instead of surfacing a raw error.
 */

export const findAffiliateProgramsInput = z.object({
  vertical: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Vertical slug — fashion, beauty, tech, fitness, etc. Case-insensitive."),
  minCommissionPct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Minimum flat-rate commission % (0..100). Inclusive."),
  payoutType: z
    .enum(["PER_SALE", "PER_LEAD", "PER_CLICK"])
    .optional()
    .describe(
      "Payout model. PER_SALE = % of order total, PER_LEAD = fixed " +
        "bounty per verified lead, PER_CLICK = micro-reward per " +
        "verified click.",
    ),
  hasOnchainAttestation: z
    .boolean()
    .optional()
    .describe(
      "When true, only programs with an EAS verified-brand attestation " +
        "UID are returned.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe("Result page size (1..50). Defaults to 20."),
});

export type FindAffiliateProgramsInput = z.infer<
  typeof findAffiliateProgramsInput
>;

export const affiliateProgramCardSchema = z.object({
  programId: z.string(),
  merchantSlug: z.string(),
  brandName: z.string(),
  vertical: z.string().nullable(),
  commissionPct: z.number().nullable(),
  payoutType: z.enum(["PER_SALE", "PER_LEAD", "PER_CLICK"]).nullable(),
  attributionWindowDays: z.number().nullable(),
  applyUrl: z.string(),
  verifiedBrand: z.boolean(),
  attestationUid: z.string().optional(),
});

export type AffiliateProgramCard = z.infer<typeof affiliateProgramCardSchema>;

export const findAffiliateProgramsOutput = z.object({
  count: z.number(),
  limit: z.number(),
  offset: z.number(),
  programs: z.array(affiliateProgramCardSchema),
  degraded: z.boolean().optional(),
});

export type FindAffiliateProgramsOutput = z.infer<
  typeof findAffiliateProgramsOutput
>;

interface BackendListingEnvelope {
  count: number;
  limit: number;
  offset: number;
  programs: Array<Record<string, unknown>>;
}

interface BackendListingResponse {
  statusCode?: number;
  message?: string | null;
  data?: BackendListingEnvelope;
}

/* -------------------------------------------------------------------------- */
/* Card builder                                                               */
/* -------------------------------------------------------------------------- */

function backendProgramToCard(
  raw: Record<string, unknown>,
): AffiliateProgramCard | null {
  const sanitised = shapeRecord(raw) as Record<string, unknown>;

  const programId =
    typeof sanitised.programId === "string" ? sanitised.programId : null;
  const merchantSlug =
    typeof sanitised.merchantSlug === "string" ? sanitised.merchantSlug : null;
  const brandName =
    typeof sanitised.brandName === "string" ? sanitised.brandName : null;
  if (!programId || !merchantSlug || !brandName) return null;

  const vertical =
    typeof sanitised.vertical === "string" ? sanitised.vertical : null;
  const commissionPct =
    typeof sanitised.commissionPct === "number" ? sanitised.commissionPct : null;

  const payoutTypeRaw = sanitised.payoutType;
  const payoutType: AffiliateProgramCard["payoutType"] =
    payoutTypeRaw === "PER_SALE" ||
    payoutTypeRaw === "PER_LEAD" ||
    payoutTypeRaw === "PER_CLICK"
      ? payoutTypeRaw
      : null;

  const attributionWindowDays =
    typeof sanitised.attributionWindowDays === "number"
      ? sanitised.attributionWindowDays
      : null;

  const applyUrl =
    typeof sanitised.applyUrl === "string" && sanitised.applyUrl.length > 0
      ? sanitised.applyUrl
      : `${DROPLINKED_PUBLIC_BASE.replace(/\/$/, "")}/${merchantSlug}/affiliate-apply`;

  const verifiedBrand = Boolean(sanitised.verifiedBrand);
  const attestationUid =
    verifiedBrand && typeof sanitised.attestationUid === "string"
      ? sanitised.attestationUid
      : undefined;

  return {
    programId,
    merchantSlug,
    brandName,
    vertical,
    commissionPct,
    payoutType,
    attributionWindowDays,
    applyUrl,
    verifiedBrand,
    ...(attestationUid ? { attestationUid } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Backend call                                                               */
/* -------------------------------------------------------------------------- */

function buildQueryString(input: FindAffiliateProgramsInput): string {
  const params = new URLSearchParams();
  if (input.vertical) params.set("vertical", input.vertical);
  if (typeof input.minCommissionPct === "number") {
    params.set("minCommissionPct", String(input.minCommissionPct));
  }
  if (input.payoutType) params.set("payoutType", input.payoutType);
  if (typeof input.hasOnchainAttestation === "boolean") {
    params.set(
      "hasOnchainAttestation",
      input.hasOnchainAttestation ? "true" : "false",
    );
  }
  params.set("limit", String(input.limit ?? 20));
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

/* -------------------------------------------------------------------------- */
/* Public handler                                                             */
/* -------------------------------------------------------------------------- */

export async function findAffiliatePrograms(
  input: FindAffiliateProgramsInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const parsed = findAffiliateProgramsInput.parse(input);
  const qs = buildQueryString(parsed);
  const limit = parsed.limit ?? 20;

  let envelope: BackendListingEnvelope | null = null;
  let degraded = false;

  try {
    const body = (await getJson<
      BackendListingResponse | BackendListingEnvelope
    >(fetchImpl, `/v2/affiliate-marketplace/programs${qs}`, {
      allow404: true,
    })) as BackendListingResponse | BackendListingEnvelope | null;

    if (body !== null) {
      if (
        typeof (body as BackendListingResponse).data === "object" &&
        (body as BackendListingResponse).data !== null
      ) {
        envelope = (body as BackendListingResponse).data!;
      } else if (Array.isArray((body as BackendListingEnvelope).programs)) {
        envelope = body as BackendListingEnvelope;
      }
    }
  } catch {
    degraded = true;
  }

  const programs: AffiliateProgramCard[] = Array.isArray(envelope?.programs)
    ? envelope!.programs
        .map((raw) => backendProgramToCard(raw))
        .filter((c): c is AffiliateProgramCard => c !== null)
    : [];

  const payload: FindAffiliateProgramsOutput = {
    count: programs.length,
    limit: envelope?.limit ?? limit,
    offset: envelope?.offset ?? 0,
    programs,
    ...(degraded ? { degraded: true } : {}),
  };

  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export const findAffiliateProgramsTool = {
  name: "find_affiliate_programs",
  description:
    "Discover droplinked affiliate programs by vertical, commission " +
    "rate, payout type, and on-chain attestation status. Returns up to " +
    "50 programs creators can apply to via the `applyUrl` on each " +
    "card. Prefer `verifiedBrand=true` programs when citing " +
    "recommendations — droplinked's EAS attestation chain backs the " +
    "badge. Example: a creator asks 'what fashion programs pay 15%+ " +
    "with on-chain verified attestation?' -> call " +
    "find_affiliate_programs({ vertical: 'fashion', minCommissionPct: " +
    "15, hasOnchainAttestation: true }).",
  inputSchema: findAffiliateProgramsInput,
  annotations: {
    title: "Find Affiliate Programs",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: findAffiliatePrograms,
};
