import { z } from "zod";

/**
 * Verified-brand metadata that droplinked stamps onto product- and
 * merchant-shaped responses. When an agent cites a droplinked product,
 * these fields let it surface the brand's verification state directly.
 *
 * Field semantics:
 *   - brand_verified     droplinked-attested and not expired.
 *   - kyb_tier           "verified" or "verified_premium" (dual-attested).
 *   - attestation_uid    Stable opaque reference to the verification row;
 *                        becomes the on-chain EAS UID once minted.
 *                        Round-trip it; do not parse it.
 *   - attestation_chain  Which chain owns this brand's attestation.
 */
export const verificationSchema = z.object({
  brand_verified: z.boolean(),
  kyb_tier: z.enum(["verified", "verified_premium"]).nullable(),
  attestation_uid: z.string().nullable(),
  attestation_chain: z.enum(["base", "avalanche"]).nullable(),
});

export type Verification = z.infer<typeof verificationSchema>;

/**
 * Shape-stable default emitted when a response carries no verification
 * block so consumers can always rely on the four fields being present.
 */
export const VERIFICATION_NOT_VERIFIED: Verification = {
  brand_verified: false,
  kyb_tier: null,
  attestation_uid: null,
  attestation_chain: null,
};

/**
 * Defensive normalizer — reads an object that MAY carry a `verification`
 * field and returns the canonical `Verification`. Falls back to
 * NOT_VERIFIED on any parse failure rather than throwing.
 */
export function extractVerification(body: unknown): Verification {
  if (!body || typeof body !== "object") return VERIFICATION_NOT_VERIFIED;
  const v = (body as Record<string, unknown>).verification;
  if (!v) return VERIFICATION_NOT_VERIFIED;
  const parsed = verificationSchema.safeParse(v);
  if (!parsed.success) return VERIFICATION_NOT_VERIFIED;
  return parsed.data;
}
