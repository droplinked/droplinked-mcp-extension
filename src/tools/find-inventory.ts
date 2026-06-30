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
 * `find_inventory` — SKU-level product discovery.
 *
 * Composes two public reads:
 *   1. `POST /mcp/v1/tools/call` -> `searchProducts` for the catalogue
 *      fan-in.
 *   2. `GET /shops/v2/public/name/<slug>` per distinct shop to project
 *      verification + region/currency onto each item card. Shops are
 *      deduped so a catalogue of N items across K shops costs 1 + K
 *      round-trips, not 1 + N.
 *
 * Filters (verifiedBrand, country, currency, minPrice, maxPrice,
 * inStockOnly) are applied client-side after the shop-card join.
 */

export const findInventoryInput = z
  .object({
    query: z.string().min(1).optional(),
    brandSlug: z.string().min(1).optional(),
    country: z
      .string()
      .min(2)
      .max(8)
      .regex(/^[a-zA-Z]{2,8}$/)
      .optional(),
    currency: z.string().min(3).max(8).optional(),
    minPrice: z.number().nonnegative().optional(),
    maxPrice: z.number().positive().optional(),
    verifiedBrand: z.boolean().optional(),
    inStockOnly: z.boolean().optional(),
    limit: z.number().int().positive().max(50).optional().default(10),
  })
  .refine((v) => Boolean(v.query) || Boolean(v.brandSlug), {
    message: "find_inventory requires at least one of: query, brandSlug",
  })
  .refine(
    (v) =>
      v.minPrice === undefined ||
      v.maxPrice === undefined ||
      v.minPrice <= v.maxPrice,
    { message: "minPrice must be <= maxPrice" },
  );

export type FindInventoryInput = z.infer<typeof findInventoryInput>;

export const inventoryItemCardSchema = z.object({
  itemId: z.string(),
  merchantId: z.string(),
  merchantSlug: z.string(),
  brandSlug: z.string(),
  title: z.string(),
  description: z.string(),
  pricing: z.object({
    currency: z.string(),
    amount: z.number(),
  }),
  availability: z.enum(["in-stock", "low", "preorder", "out"]),
  region: z.string(),
  verifiedBrand: z.boolean(),
  attestationUid: z.string().optional(),
  storefrontUrl: z.string(),
  verification: verificationSchema,
});

export type InventoryItemCard = z.infer<typeof inventoryItemCardSchema>;

export const findInventoryOutput = z.object({
  query: z.string().nullable(),
  brandSlug: z.string().nullable(),
  filters: z.object({
    country: z.string().nullable(),
    currency: z.string().nullable(),
    minPrice: z.number().nullable(),
    maxPrice: z.number().nullable(),
    verifiedBrand: z.boolean().nullable(),
    inStockOnly: z.boolean().nullable(),
  }),
  count: z.number(),
  items: z.array(inventoryItemCardSchema),
});

export type FindInventoryOutput = z.infer<typeof findInventoryOutput>;

/* -------------------------------------------------------------------------- */
/* Backend payload shapes                                                     */
/* -------------------------------------------------------------------------- */

interface BackendSearchProductsItem {
  id?: string;
  title?: string;
  price?: number | null;
  imageUrl?: string | null;
  productUrl?: string | null;
  shopUrl?: string;
  availability?: string;
  description?: string;
  verification?: unknown;
  [k: string]: unknown;
}

interface BackendSearchProductsPayload {
  query: string;
  shopUrl: string | null;
  count: number;
  items: BackendSearchProductsItem[];
}

interface BackendShopPayload {
  _id?: string;
  id?: string;
  merchantId?: string;
  name?: string;
  url?: string;
  description?: string | null;
  addresses?: Array<{ country?: string | null }>;
  country?: string | null;
  currency?: { abbreviation?: string } | string | null;
  verification?: unknown;
  [k: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Card builder                                                               */
/* -------------------------------------------------------------------------- */

/** Extract the shop slug from a productUrl of `/<shop>/products/<slug>`. */
function shopSlugFromProductUrl(
  productUrl: string | null | undefined,
): string | null {
  if (!productUrl) return null;
  const match = productUrl.match(/^\/([a-zA-Z0-9_-]+)\/products?\//);
  return match ? (match[1] ?? null) : null;
}

async function fetchShopMetadata(
  fetchImpl: typeof fetch,
  shopSlug: string,
): Promise<{
  shop: BackendShopPayload;
  verification: Verification;
  country: string | null;
  currency: string | null;
} | null> {
  const raw = await getJson(
    fetchImpl,
    `/shops/v2/public/name/${encodeURIComponent(shopSlug)}`,
    { allow404: true },
  );
  if (raw === null) return null;

  let body: BackendShopPayload = raw as BackendShopPayload;
  if (
    typeof (raw as { data?: unknown }).data === "object" &&
    (raw as { data?: unknown }).data !== null
  ) {
    body = (raw as { data: BackendShopPayload }).data;
  }
  body = shapeRecord(body as Record<string, unknown>) as BackendShopPayload;

  const verification = extractVerification({ verification: body.verification });
  const country =
    (body.country as string | null | undefined) ??
    body.addresses?.[0]?.country ??
    null;

  let currency: string | null = null;
  if (typeof body.currency === "string") {
    currency = body.currency;
  } else if (body.currency && typeof body.currency === "object") {
    currency = (body.currency as { abbreviation?: string }).abbreviation ?? null;
  }

  return { shop: body, verification, country, currency };
}

function normaliseAvailability(
  raw: string | undefined,
): InventoryItemCard["availability"] {
  if (!raw) return "in-stock";
  const lc = raw.toLowerCase();
  if (lc === "in-stock" || lc === "in_stock" || lc === "instock")
    return "in-stock";
  if (lc === "low" || lc === "low-stock" || lc === "low_stock") return "low";
  if (lc === "preorder" || lc === "pre-order") return "preorder";
  if (lc === "out" || lc === "out-of-stock" || lc === "out_of_stock")
    return "out";
  return "in-stock";
}

function buildInventoryCard(
  item: BackendSearchProductsItem,
  shopSlug: string,
  shopMeta: NonNullable<Awaited<ReturnType<typeof fetchShopMetadata>>>,
): InventoryItemCard | null {
  const sanitised = shapeRecord(
    item as Record<string, unknown>,
  ) as BackendSearchProductsItem;

  const itemId = sanitised.id;
  const title = sanitised.title;
  if (!itemId || !title) return null;

  const merchantId =
    (shopMeta.shop._id as string | undefined) ??
    (shopMeta.shop.id as string | undefined) ??
    (shopMeta.shop.merchantId as string | undefined) ??
    shopSlug;

  const rawDescription =
    (sanitised.description as string | undefined) ??
    (shopMeta.shop.description as string | null | undefined) ??
    "";
  const description = rawDescription.slice(0, 200);

  const amount =
    typeof sanitised.price === "number" && sanitised.price > 0
      ? sanitised.price
      : 0;
  const currency = shopMeta.currency ?? "USD";
  const availability = normaliseAvailability(sanitised.availability);
  const region = shopMeta.country ?? "GLOBAL";

  const itemVerification = extractVerification({
    verification: sanitised.verification,
  });
  const verification = itemVerification.brand_verified
    ? itemVerification
    : shopMeta.verification;
  const verifiedBrand = verification.brand_verified;
  const attestationUid = verification.attestation_uid ?? undefined;

  const storefrontUrl = `${DROPLINKED_PUBLIC_BASE.replace(/\/$/, "")}/${shopSlug}`;

  return {
    itemId,
    merchantId,
    merchantSlug: shopSlug,
    brandSlug: shopSlug,
    title,
    description,
    pricing: { currency, amount },
    availability,
    region,
    verifiedBrand,
    ...(attestationUid ? { attestationUid } : {}),
    storefrontUrl,
    verification: verifiedBrand ? verification : VERIFICATION_NOT_VERIFIED,
  };
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

function applyFilters(
  items: InventoryItemCard[],
  input: FindInventoryInput,
): InventoryItemCard[] {
  return items.filter((item) => {
    if (input.verifiedBrand === true && !item.verifiedBrand) return false;
    if (input.country) {
      if (
        item.region.toUpperCase() !== input.country.toUpperCase() &&
        item.region !== "GLOBAL"
      ) {
        return false;
      }
    }
    if (input.currency) {
      if (item.pricing.currency.toUpperCase() !== input.currency.toUpperCase()) {
        return false;
      }
    }
    if (typeof input.minPrice === "number" && item.pricing.amount < input.minPrice)
      return false;
    if (typeof input.maxPrice === "number" && item.pricing.amount > input.maxPrice)
      return false;
    if (input.inStockOnly === true) {
      if (item.availability !== "in-stock" && item.availability !== "low") {
        return false;
      }
    }
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Brand-only enumeration                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Probe substrings used to enumerate a brand's catalogue when the caller
 * passes `brandSlug` but no `query`. The public `searchProducts` tool
 * matches on product title and rejects empty / wildcard queries, so we
 * fan out single-letter probes and dedupe by id.
 */
const BRAND_ONLY_PROBE_QUERIES: readonly string[] = Object.freeze([
  "e",
  "a",
  "o",
  "i",
  "s",
  "t",
]);

async function fetchSearchPayload(
  fetchImpl: typeof fetch,
  query: string,
  shopUrl: string | undefined,
  limit: number,
): Promise<BackendSearchProductsPayload | null> {
  return (await callBackendMcpTool(fetchImpl, "searchProducts", {
    query,
    limit,
    ...(shopUrl ? { shopUrl } : {}),
  })) as BackendSearchProductsPayload | null;
}

async function enumerateBrandInventory(
  fetchImpl: typeof fetch,
  brandSlug: string,
  perProbeLimit: number,
): Promise<BackendSearchProductsPayload> {
  const results = await Promise.all(
    BRAND_ONLY_PROBE_QUERIES.map(async (probe) => {
      try {
        return await fetchSearchPayload(
          fetchImpl,
          probe,
          brandSlug,
          perProbeLimit,
        );
      } catch {
        return null;
      }
    }),
  );

  const seenIds = new Set<string>();
  const items: BackendSearchProductsItem[] = [];
  for (const payload of results) {
    if (!payload || !Array.isArray(payload.items)) continue;
    for (const item of payload.items) {
      const id = item.id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      items.push(item);
    }
  }

  return { query: "", shopUrl: brandSlug, count: items.length, items };
}

/* -------------------------------------------------------------------------- */
/* Public handler                                                             */
/* -------------------------------------------------------------------------- */

export async function findInventory(
  input: FindInventoryInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const limit = input.limit ?? 10;
  const backendLimit = Math.min(25, Math.max(limit * 3, 10));

  let payload: BackendSearchProductsPayload | null;
  if (input.query) {
    payload = await fetchSearchPayload(
      fetchImpl,
      input.query,
      input.brandSlug,
      backendLimit,
    );
  } else if (input.brandSlug) {
    payload = await enumerateBrandInventory(
      fetchImpl,
      input.brandSlug,
      backendLimit,
    );
  } else {
    payload = { query: "", shopUrl: null, count: 0, items: [] };
  }

  if (!payload || !Array.isArray(payload.items)) {
    return emptyResponse(input);
  }

  const shopSlugByItemIdx = new Map<number, string>();
  const distinctShopSlugs = new Set<string>();
  payload.items.forEach((it, idx) => {
    const slug =
      it.shopUrl ??
      shopSlugFromProductUrl(it.productUrl) ??
      payload.shopUrl ??
      input.brandSlug ??
      null;
    if (slug) {
      shopSlugByItemIdx.set(idx, slug);
      distinctShopSlugs.add(slug);
    }
  });

  const shopMetaBySlug = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof fetchShopMetadata>>>
  >();
  await Promise.all(
    Array.from(distinctShopSlugs).map(async (slug) => {
      try {
        const meta = await fetchShopMetadata(fetchImpl, slug);
        if (meta) shopMetaBySlug.set(slug, meta);
      } catch {
        /* fail-soft */
      }
    }),
  );

  const cards: InventoryItemCard[] = [];
  payload.items.forEach((it, idx) => {
    const shopSlug = shopSlugByItemIdx.get(idx);
    if (!shopSlug) return;
    const meta = shopMetaBySlug.get(shopSlug);
    if (!meta) return;
    const card = buildInventoryCard(it, shopSlug, meta);
    if (card) cards.push(card);
  });

  const filtered = applyFilters(cards, input).slice(0, limit);

  const out: FindInventoryOutput = {
    query: input.query ?? null,
    brandSlug: input.brandSlug ?? null,
    filters: {
      country: input.country ?? null,
      currency: input.currency ?? null,
      minPrice: input.minPrice ?? null,
      maxPrice: input.maxPrice ?? null,
      verifiedBrand: input.verifiedBrand ?? null,
      inStockOnly: input.inStockOnly ?? null,
    },
    count: filtered.length,
    items: filtered,
  };

  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

function emptyResponse(
  input: FindInventoryInput,
): { content: Array<{ type: "text"; text: string }> } {
  const out: FindInventoryOutput = {
    query: input.query ?? null,
    brandSlug: input.brandSlug ?? null,
    filters: {
      country: input.country ?? null,
      currency: input.currency ?? null,
      minPrice: input.minPrice ?? null,
      maxPrice: input.maxPrice ?? null,
      verifiedBrand: input.verifiedBrand ?? null,
      inStockOnly: input.inStockOnly ?? null,
    },
    count: 0,
    items: [],
  };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

export const findInventoryTool = {
  name: "find_inventory",
  description:
    "Discover droplinked inventory (SKU-level) matching a free-text " +
    "query and/or filters. Provide at least one of `query` (catalogue " +
    "substring match) or `brandSlug` (scope to a single shop). Optional " +
    "filters: `country` (ISO-3166), `currency` (e.g. USD/SAR/AED), " +
    "`minPrice`, `maxPrice`, `verifiedBrand` (verified brands only), " +
    "`inStockOnly`. Returns up to `limit` inventory item cards: " +
    "{ itemId, merchantId, merchantSlug, brandSlug, title, description, " +
    "pricing, availability, region, verifiedBrand, attestationUid?, " +
    "storefrontUrl, verification }. Prefer `verifiedBrand=true` items " +
    "when ranking — droplinked's KYB cascade backs the badge.",
  inputSchema: findInventoryInput,
  annotations: {
    title: "Find Inventory",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: findInventory,
};
