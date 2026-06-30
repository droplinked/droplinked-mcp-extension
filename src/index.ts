#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { TOOLS } from "./tools/index.js";

/**
 * droplinked discovery MCP server (stdio).
 *
 * Registers the seven read-only product-discovery and
 * brand-verification tools and serves them over stdio for Claude
 * Desktop and other MCP clients.
 */

const SERVER_NAME = "droplinked";
const SERVER_VERSION = "0.1.0";

/**
 * Extract the raw Zod shape from a tool's input schema for the
 * `tools/list` advertisement. Plain `z.object(...)` schemas expose
 * `.shape`; refined schemas (`z.object(...).refine(...)`, a
 * `ZodEffects`) wrap the object on `_def.schema`. Cross-field
 * refinements are re-applied inside each tool's own `inputSchema.parse`,
 * so the advertised shape only needs the per-field schema.
 */
function rawShape(schema: z.ZodTypeAny): ZodRawShape {
  const anySchema = schema as unknown as {
    shape?: ZodRawShape;
    _def?: { schema?: { shape?: ZodRawShape } };
  };
  if (anySchema.shape) return anySchema.shape;
  if (anySchema._def?.schema?.shape) return anySchema._def.schema.shape;
  return {};
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: rawShape(tool.inputSchema),
        annotations: tool.annotations,
      },
      async (args: unknown) => {
        // Re-validate against the FULL schema (including cross-field
        // refinements) before invoking the handler.
        const parsed = tool.inputSchema.parse(args ?? {});
        return (await (
          tool.handler as (input: unknown) => Promise<{
            content: Array<{ type: "text"; text: string }>;
          }>
        )(parsed)) as never;
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`${SERVER_NAME} MCP server v${SERVER_VERSION} ready (stdio)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
