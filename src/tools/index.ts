/**
 * Tool registry — the seven read-only droplinked discovery tools.
 *
 * Each entry exposes `{ name, description, inputSchema, annotations,
 * handler }`. The server in `../index.ts` registers them with the MCP
 * SDK.
 */

import { findInventoryTool } from "./find-inventory.js";
import { findMerchantTool } from "./find-merchant.js";
import { getFeedTool } from "./get-feed.js";
import { findAffiliateProgramsTool } from "./find-affiliate-programs.js";
import { verifyBrandAttestationTool } from "./verify-brand-attestation.js";
import { getBrandAttestationStatusTool } from "./get-brand-attestation-status.js";
import { getTrustFabricStatsTool } from "./get-trust-fabric-stats.js";

export const TOOLS = [
  findInventoryTool,
  findMerchantTool,
  getFeedTool,
  findAffiliateProgramsTool,
  verifyBrandAttestationTool,
  getBrandAttestationStatusTool,
  getTrustFabricStatsTool,
] as const;
