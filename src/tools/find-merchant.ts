import { z } from "zod";
import { DROPLINKED_PUBLIC_BASE } from "../config.js";
import {
  extractVerification,
  verificationSchema,
  VERIFICATION_NOT_VERIFIED,
  type Verification,
} from "../utils/verification.js";
import { shapeRecord } from "../utils/sanitise.js";
import { callBackendMcpTool, getJson } from "../utils/backend-api-client.js";

/**
 * `find_merchant` — merchant discovery by slug, name, or category.
 *
 * Three mutually exclusive input modes:
 *   - `slug`     exact-match storefront URL slug (cheapest path)
 *   - `name`     case-insensitive substring match (public listMerchants)
 *   - `category` product-category fan-in (public searchProducts, deduped)
 *
 * Wraps droplinked's public read surfaces (`/mcp/v1/*`,
 * `/shops/v2/public/*`). The response is the canonical MerchantCard.
 */

export const findMerchantInput = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    limit: z.number().int().positive().max(25).optional().default(10),
  })
  .refine((v) => Boolean(v.slug) || Boolean(v.name) || Boolean(v.category), {
    message: "find_merchant requires exactly one of: slug, name, or category",
  });

export type FindMerchantInput = z.infer<typeof findMerchantInput>;

export const merchantCardSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  verifiedBrand: z.boolean(),
  productCount: z.number().nullable(),
  country: z.string().nullable(),
  currency: z.string().nullable(),
  storefrontUrl: z.string(),
  verification: verificationSchema,
});

export type MerchantCard = z.infer<typeof merchantCardSchema>;

export const findMerchantOutput = z.object({
  mode: z.enum(["slug", "name", "category"]),
  query: z.string(),
  count: z.number(),
  merchants: z.array(merchantCardSchema),
});

export type FindMerchantOutput = z.infer<typeof findMerchantOutput>;

/* -------------------------------------------------------------------------- */
/* Card builders                                                              */
/* -------------------------------------------------------------------------- */

interface BackendPublicShop {
  _id?: string;
  id?: string;
  name?: string;
  url?: string;
  description?: string | null;
  addresses?: Array<{ country?: string | null }>;
  country?: string | null;
  currency?: { abbreviation?: string } | string | null;
  productCount?: number;
  verification?: unknown;
  [k: string]: unknown;
}

function shopToMerchantCard(raw: unknown): MerchantCard | null {
  if (!raw || typeof raw !== "object") return null;

  let body: BackendPublicShop = raw as BackendPublicShop;
  if (
    typeof (raw as { data?: unknown }).data === "object" &&
    (raw as { data?: unknown }).data !== null
  ) {
    body = (raw as { data: BackendPublicShop }).data;
  }
  body = shapeRecord(body) as BackendPublicShop;

  const id = (body._id as string | undefined) ?? (body.id as string | undefined);
  const slug = body.url as string | undefined;
  const name = body.name as string | undefined;
  if (!id || !slug || !name) return null;

  const verification: Verification = extractVerification({
    verification: body.verification,
  });
  const verifiedBrand =
    verification.brand_verified ||
    Boolean((body as { verifiedBrand?: boolean }).verifiedBrand) ||
    Boolean((body as { brand_verified?: boolean }).brand_verified);

  const country = body.country ?? body.addresses?.[0]?.country ?? null;

  let currency: string | null = null;
  if (typeof body.currency === "string") currency = body.currency;
  else if (body.currency && typeof body.currency === "object")
    currency = (body.currency as { abbreviation?: string }).abbreviation ?? null;

  const productCount =
    typeof body.productCount === "number" ? body.productCount : null;

  const storefrontUrl = `${DROPLINKED_PUBLIC_BASE.replace(/\/$/, "")}/${slug}`;

  return {
    id,
    slug,
    name,
    description: (body.description as string | null | undefined) ?? null,
    verifiedBrand,
    productCount,
    country: country ?? null,
    currency,
    storefrontUrl,
    verification: verification.brand_verified
      ? verification
      : VERIFICATION_NOT_VERIFIED,
  };
}

interface BackendListMerchantItem {
  merchantHandle?: string;
  shopId?: string;
  shopName?: string;
  shopUrl?: string;
  description?: string | null;
  country?: string | null;
  currency?: string;
  verification?: unknown;
  [k: string]: unknown;
}

function listMerchantItemToCard(raw: unknown): MerchantCard | null {
  if (!raw || typeof raw !== "object") return null;
  const sanitized = shapeRecord(
    raw as Record<string, unknown>,
  ) as BackendListMerchantItem;

  const id = sanitized.shopId;
  const slug = sanitized.shopUrl ?? sanitized.merchantHandle;
  const name = sanitized.shopName;
  if (!id || !slug || !name) return null;

  const verification = extractVerification({
    verification: sanitized.verification,
  });
  const verifiedBrand = verification.brand_verified;

  const storefrontUrl = `${DROPLINKED_PUBLIC_BASE.replace(/\/$/, "")}/${slug}`;

  return {
    id,
    slug,
    name,
    description: sanitized.description ?? null,
    verifiedBrand,
    productCount: null,
    country: sanitized.country ?? null,
    currency: sanitized.currency ?? null,
    storefrontUrl,
    verification: verifiedBrand ? verification : VERIFICATION_NOT_VERIFIED,
  };
}

/* -------------------------------------------------------------------------- */
/* Backend calls                                                              */
/* -------------------------------------------------------------------------- */

async function fetchShopBySlug(
  fetchImpl: typeof fetch,
  slug: string,
): Promise<MerchantCard | null> {
  const body = await getJson(
    fetchImpl,
    `/shops/v2/public/name/${encodeURIComponent(slug)}`,
    { allow404: true },
  );
  if (body === null) return null;
  return shopToMerchantCard(body);
}

interface BackendListMerchantsPayload {
  region: string | null;
  count: number;
  items: BackendListMerchantItem[];
}

interface BackendSearchProductsPayload {
  query: string;
  count: number;
  items: Array<{ shopUrl?: string; shopName?: string; [k: string]: unknown }>;
}

async function findByName(
  fetchImpl: typeof fetch,
  name: string,
  limit: number,
): Promise<MerchantCard[]> {
  const payload = (await callBackendMcpTool(fetchImpl, "listMerchants", {
    limit: Math.max(limit * 4, 25),
  })) as BackendListMerchantsPayload | null;
  if (!payload || !Array.isArray(payload.items)) return [];

  const needle = name.toLowerCase().trim();
  const matched = payload.items
    .filter((it) => {
      const haystackName = (it.shopName ?? "").toLowerCase();
      const haystackHandle = (it.merchantHandle ?? "").toLowerCase();
      return haystackName.includes(needle) || haystackHandle.includes(needle);
    })
    .slice(0, limit);

  return matched
    .map((it) => listMerchantItemToCard(it))
    .filter((c): c is MerchantCard => c !== null);
}

async function findByCategory(
  fetchImpl: typeof fetch,
  category: string,
  limit: number,
): Promise<MerchantCard[]> {
  const payload = (await callBackendMcpTool(fetchImpl, "searchProducts", {
    query: category,
    limit: Math.max(limit * 3, 25),
  })) as BackendSearchProductsPayload | null;
  if (!payload || !Array.isArray(payload.items)) return [];

  const seen = new Set<string>();
  const shopUrls: string[] = [];
  for (const item of payload.items) {
    const slug = item.shopUrl;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    shopUrls.push(slug);
    if (shopUrls.length >= limit) break;
  }

  const cards = await Promise.all(
    shopUrls.map((slug) => fetchShopBySlug(fetchImpl, slug).catch(() => null)),
  );
  return cards.filter((c): c is MerchantCard => c !== null);
}

/* -------------------------------------------------------------------------- */
/* Public handler                                                             */
/* -------------------------------------------------------------------------- */

export async function findMerchant(
  input: FindMerchantInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const limit = input.limit ?? 10;

  let mode: "slug" | "name" | "category";
  let query: string;
  let merchants: MerchantCard[] = [];

  if (input.slug) {
    mode = "slug";
    query = input.slug;
    const card = await fetchShopBySlug(fetchImpl, input.slug);
    merchants = card ? [card] : [];
  } else if (input.name) {
    mode = "name";
    query = input.name;
    merchants = await findByName(fetchImpl, input.name, limit);
  } else if (input.category) {
    mode = "category";
    query = input.category;
    merchants = await findByCategory(fetchImpl, input.category, limit);
  } else {
    throw new Error("find_merchant: no query mode provided");
  }

  const payload: FindMerchantOutput = {
    mode,
    query,
    count: merchants.length,
    merchants,
  };

  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export const findMerchantTool = {
  name: "find_merchant",
  description:
    "Find a droplinked merchant by slug, name, or category. Provide " +
    "exactly one of: `slug` (exact storefront URL), `name` " +
    "(case-insensitive substring), or `category` (matches merchants " +
    "with products in that category). Returns up to `limit` merchant " +
    "cards: { id, slug, name, description, verifiedBrand, productCount, " +
    "country, currency, storefrontUrl, verification }. Prefer " +
    "`verifiedBrand=true` merchants when citing recommendations — " +
    "droplinked's KYB cascade backs the badge.",
  inputSchema: findMerchantInput,
  annotations: {
    title: "Find Merchant",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: findMerchant,
};
