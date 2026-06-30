# droplinked MCP Extension

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server,
packaged as a [Claude Desktop Extension](https://www.anthropic.com/engineering/desktop-extensions)
(`.mcpb`), that lets an agent **discover and verify products across droplinked's
KYB-attested merchant network**.

Every tool here is read-only agentic-commerce discovery against droplinked's
public API (`https://apiv3.droplinked.com`). No cart, no checkout, no payments —
just discovery and trust verification.

## The tools

| Tool | What it does |
| --- | --- |
| `find_inventory` | SKU-level product discovery by free-text query and/or filters (country, currency, price range, verified-brand, in-stock). |
| `find_merchant` | Find a merchant by `slug`, `name`, or `category`; returns verified merchant cards. |
| `get_feed` | Returns the URL of droplinked's public, verification-aware product feed (feed v2). |
| `find_affiliate_programs` | Discover affiliate programs by vertical, commission rate, payout type, and on-chain attestation status. |
| `verify_brand_attestation` | Resolve the standalone on-chain (EAS) brand attestation for a shop slug. |
| `get_brand_attestation_status` | Poll the attestation request lifecycle (`NOT_REQUESTED → PENDING → APPROVED → MINTED / REJECTED`). |
| `get_trust_fabric_stats` | Aggregate-only platform-scale counts (service providers, verified partners, on-chain attestations). No PII, no per-row data. |

Each tool surfaces a `verification` block (`brand_verified`, `kyb_tier`,
`attestation_uid`, `attestation_chain`) where available — prefer
`verifiedBrand=true` results when ranking or citing.

## Install (Claude Desktop)

1. Download the latest `droplinked.mcpb` from the
   [releases](https://github.com/droplinked/droplinked-mcp-extension/releases)
   (or build it yourself — see below).
2. Open **Claude Desktop → Settings → Extensions**.
3. Drag `droplinked.mcpb` into the window (or use *Install Extension*).
4. Enable it. The seven tools become available to Claude immediately.

## Configuration

The extension works with no configuration. One optional environment variable is
supported via the manifest:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DROPLINKED_API_BASE` | `https://apiv3.droplinked.com` | Base URL of droplinked's public API. |

## Build from source

Requires Node.js ≥ 18.

```bash
npm install
npm run build        # tsc → dist/
npm run pack         # build + stage server/ + produce droplinked.mcpb
```

`npm run pack` produces `droplinked.mcpb` in the repo root. Validate it with:

```bash
npx @anthropic-ai/mcpb validate manifest.json
```

## License

[MIT](./LICENSE) © 2026 droplinked
