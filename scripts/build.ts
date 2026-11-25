import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";

await rm("plugin/runtime", { recursive: true, force: true });
await mkdir("plugin/runtime", { recursive: true });

for (const [entry, outfile] of [
  ["agent-cli/entry.ts", "plugin/runtime/cli.mjs"],
  ["agent-claude/hook-entry.ts", "plugin/runtime/hook.mjs"],
  ["agent-claude/mcp-server.ts", "plugin/runtime/mcp.mjs"],
] as const) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    ...(outfile.endsWith("cli.mjs") ? { banner: { js: "#!/usr/bin/env node" } } : {}),
  });
}
