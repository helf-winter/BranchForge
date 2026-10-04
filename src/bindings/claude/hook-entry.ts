import { openRuntime } from "../../application/runtime.js";
import { HarnessError } from "../../domain/errors.js";
import { mapClaudeHook } from "./hook-mapper.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
let runtime: ReturnType<typeof openRuntime> | undefined;
try {
  runtime = openRuntime();
  const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  const event = mapClaudeHook(raw);
  const result = await runtime.hooks.ingest(event);
  if (result.directive?.kind === "deny") {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.directive.reason,
      },
    })}\n`);
  } else if (result.directive?.kind === "context") {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event.eventName,
        additionalContext: result.directive.context,
      },
    })}\n`);
  }
} catch (error) {
  const normalized = error instanceof HarnessError ? error : new HarnessError("storage_failure", error instanceof Error ? error.message : String(error));
  process.stderr.write(`${JSON.stringify({
    error: {
      code: normalized.code,
      message: "Agent Harness hook failed open; Claude execution continues.",
    },
  })}\n`);
} finally {
  try {
    runtime?.close();
  } catch {
    // Hook cleanup failures must not turn observation into a Claude execution gate.
  }
}
