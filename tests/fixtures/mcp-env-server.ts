/**
 * Minimal stdio MCP server fixture that reports environment variables.
 * Run as: bun run tests/fixtures/mcp-env-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "env-fixture", version: "0.0.0" });

server.registerTool(
  "getenv",
  {
    description: "Returns the value of an environment variable, or an empty string",
    inputSchema: { name: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => ({ content: [{ type: "text", text: process.env[name] ?? "" }] }),
);

await server.connect(new StdioServerTransport());
