/**
 * MCP stdio handshake probe: spawn, send `initialize`, resolve on the
 * first `id: 1` response or process exit, whichever comes first. This is a
 * direct port of the probe script used repeatedly by hand during this
 * project's research (docs/research.md) — see design.md D1 for why this is
 * hand-rolled JSON-RPC rather than `@modelcontextprotocol/sdk`'s client.
 */

import { spawn } from "node:child_process";
import type { McpProbeResult } from "../core/types.js";

export interface McpProbeTarget {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
}

export function probeMcpServer(
  def: McpProbeTarget,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<McpProbeResult> {
  if (def.transport !== "stdio" || !def.command) {
    return Promise.resolve({
      ok: false,
      error: `probeMcpServer only handshakes stdio servers with a command (got transport=${def.transport})`,
    });
  }

  return new Promise((resolve) => {
    const child = spawn(def.command as string, def.args ?? [], { env });

    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      // A wrapper (npx, a shell shim) can absorb SIGTERM without forwarding
      // it to the real server it launched. Escalate once, short grace
      // period, so a probe never leaves a live process behind.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, 500).unref();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `no response within ${timeoutMs}ms`, stderr: stderrBuf || undefined });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: { id?: number; error?: unknown; result?: { serverInfo?: { name?: string; version?: string } } };
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish({ ok: false, error: JSON.stringify(msg.error), stderr: stderrBuf || undefined });
          } else {
            finish({ ok: true, serverInfo: msg.result?.serverInfo, stderr: stderrBuf || undefined });
          }
          return;
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });

    child.on("exit", (code) => {
      finish({ ok: false, error: `process exited (code ${code}) before responding`, stderr: stderrBuf || undefined });
    });

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "trellis-doctor", version: "0.0.0" },
      },
    };
    child.stdin?.write(`${JSON.stringify(request)}\n`);
  });
}
