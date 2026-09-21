/**
 * A real headless-DOM smoke test (trellis-gui tasks.md 6/7 — this repo
 * has no display available for a real browser (verified: the sandboxed
 * browser-automation tools refuse localhost/private IPs, and no local
 * Chrome DevTools session is attachable in this environment), so this
 * is the strongest verification available: mount the real `<App/>`
 * component tree in jsdom, against a REAL sidecar process (spawned
 * exactly like the sidecar's own test suite does — no mocked fetch, no
 * stubbed data), and assert real fetched content lands in the DOM.
 * `jsdom` is a devDependency of `@trellis/gui` only — never shipped in
 * the built app.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = fileURLToPath(new URL(".", import.meta.url));
const guiRoot = join(here, "..");
const repoRoot = join(guiRoot, "..", "..");

function cli(homeDir: string, args: string[]): string {
  return execFileSync("npx", ["tsx", "src/cli.ts", ...args], { cwd: repoRoot, env: { ...process.env, HOME: homeDir }, encoding: "utf-8" });
}

async function startSidecar(homeDir: string): Promise<{ port: number; close: () => Promise<void> }> {
  const { createSidecarServer, listenOnEphemeralLoopbackPort } = await import("../sidecar/server.js");
  const { createReadRoutes } = await import("../sidecar/routes/read.js");
  const { createPlanApplyRoutes } = await import("../sidecar/routes/planApply.js");
  const { createChatRoutes } = await import("../sidecar/routes/chat.js");
  const { createLiveUpdates } = await import("../sidecar/liveUpdates.js");
  const { createChatSessionStore } = await import("../sidecar/chatSessionStore.js");
  const { PlanStore } = await import("../sidecar/planStore.js");

  const liveUpdates = createLiveUpdates(homeDir, 50);
  const server = createSidecarServer([
    ...createReadRoutes(homeDir),
    ...createPlanApplyRoutes(homeDir, new PlanStore()),
    ...createChatRoutes(homeDir, createChatSessionStore(), (message) => liveUpdates.broadcast(message)),
  ]);
  liveUpdates.attach(server);
  const port = await listenOnEphemeralLoopbackPort(server);
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        liveUpdates.close();
        server.close(() => resolve());
      }),
  };
}

test("App: mounts against a real sidecar and renders real MCP data fetched over HTTP", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-smoke-"));
  cli(homeDir, ["init"]);
  cli(homeDir, ["mcp", "add", "smoke-test-server", "--transport", "stdio", "--command", "echo", "--json"]);

  const sidecar = await startSidecar(homeDir);
  try {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: `http://localhost/?port=${sidecar.port}`,
    });
    // React/ReactDOM/the app read these globals at module-eval time —
    // must be set before any of them are imported.
    (globalThis as unknown as { window: typeof window }).window = dom.window as unknown as typeof window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    // Node 22 ships its own non-configurable-by-default `navigator`
    // global (a `NavigatorID`-like object with just `userAgent`) that
    // collides with jsdom's fuller one — redefine it explicitly rather
    // than a plain assignment, which throws on that getter-only global.
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });

    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const { default: App } = await import("./App.js");

    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    root.render(React.createElement(App));

    const bodyContains = async (needle: string, timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (dom.window.document.body.textContent?.includes(needle)) return;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for "${needle}" in the rendered DOM. Current body: ${dom.window.document.body.textContent}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    await bodyContains("Trellis");
    await bodyContains("claude-code"); // proves the Agents tab's real /doctor fetch landed

    // Click the MCP nav tab — a real DOM event, not a direct state call —
    // then wait for that view's own real /mcp/list fetch to land.
    const mcpButton = Array.from(dom.window.document.querySelectorAll("button")).find((b) => b.textContent === "MCP");
    assert.ok(mcpButton, "expected an MCP nav button");
    mcpButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    await bodyContains("smoke-test-server");

    root.unmount();
  } finally {
    await sidecar.close();
  }
});

test("App: the confirm-modal write flow really adds an MCP server, and Cancel never calls apply", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-smoke-write-"));
  cli(homeDir, ["init"]);
  const serversYamlPath = join(homeDir, ".trellis", "mcp", "servers.yaml");

  const sidecar = await startSidecar(homeDir);
  try {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: `http://localhost/?port=${sidecar.port}` });
    (globalThis as unknown as { window: typeof window }).window = dom.window as unknown as typeof window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });

    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const { default: App } = await import("./App.js");
    const { readFileSync } = await import("node:fs");

    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    root.render(React.createElement(App));

    const bodyContains = async (needle: string, timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (dom.window.document.body.textContent?.includes(needle)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${needle}". Body: ${dom.window.document.body.textContent}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const clickButtonWithText = (text: string): void => {
      const button = Array.from(dom.window.document.querySelectorAll("button")).find((b) => b.textContent === text);
      if (!button) throw new Error(`no button with text "${text}" — body: ${dom.window.document.body.textContent}`);
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    };
    const setInputValue = (placeholder: string, value: string): void => {
      const input = dom.window.document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
      if (!input) throw new Error(`no input with placeholder "${placeholder}"`);
      // React tracks the native input value setter; assigning `.value`
      // directly and dispatching a real `input` event is what makes a
      // controlled component's onChange actually fire, same as a real
      // browser keystroke would.
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };

    await bodyContains("Trellis");
    clickButtonWithText("MCP");
    await bodyContains("No MCP servers in canonical source yet.");

    setInputValue("name", "smoke-write-server");
    setInputValue("stdio command", "echo hi");
    clickButtonWithText("Add");

    // The plan must render before Apply is clickable — this is exactly
    // what proves the modal never lets a caller skip straight to apply.
    await bodyContains('"action": "create"');
    assert.equal(readFileSync(serversYamlPath, "utf-8").includes("smoke-write-server"), false, "the plan step alone must not have written anything yet");

    clickButtonWithText("Apply");

    // Wait for the modal itself to close (ConfirmModal's onApplied ->
    // onClose) rather than re-checking for "smoke-write-server" in the
    // DOM — that text is already present in the plan preview's <pre>
    // JSON before Apply is even clicked, so it would be a false-positive
    // check for whether the real write happened.
    const modalGone = async (timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (!dom.window.document.querySelector(".modal-backdrop")) return;
        if (Date.now() > deadline) throw new Error("timed out waiting for the modal to close after Apply");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    await modalGone();

    assert.ok(readFileSync(serversYamlPath, "utf-8").includes("smoke-write-server"), "a confirmed Apply must have actually written the server into servers.yaml");

    // Now prove the other half of the spec requirement: Cancel never
    // calls /apply. Open a second Add flow, wait for its plan, then
    // Cancel instead of Apply.
    setInputValue("name", "smoke-cancelled-server");
    setInputValue("stdio command", "echo nope");
    clickButtonWithText("Add");
    await bodyContains("smoke-cancelled-server");
    clickButtonWithText("Cancel");
    await modalGone();
    assert.equal(
      readFileSync(serversYamlPath, "utf-8").includes("smoke-cancelled-server"),
      false,
      "Cancel must never result in a write — servers.yaml must not contain the cancelled server",
    );

    root.unmount();
  } finally {
    await sidecar.close();
  }
});

test("App: the MCP import flow reads a real export file and writes real servers, without leaking the secret value into the DOM", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-smoke-import-"));
  cli(homeDir, ["init"]);
  const serversYamlPath = join(homeDir, ".trellis", "mcp", "servers.yaml");

  const { writeFileSync: writeFile } = await import("node:fs");
  const exportFile = join(homeDir, "export.json");
  writeFile(
    exportFile,
    JSON.stringify({
      mcpServers: {
        "smoke-imported-server": {
          command: "npx",
          args: ["-y", "some-mcp-server"],
          env: { SMOKE_API_KEY: "sk-smoke-test-secret-value" },
        },
      },
    }),
  );

  const sidecar = await startSidecar(homeDir);
  try {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: `http://localhost/?port=${sidecar.port}` });
    (globalThis as unknown as { window: typeof window }).window = dom.window as unknown as typeof window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });

    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const { default: App } = await import("./App.js");
    const { readFileSync } = await import("node:fs");

    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    root.render(React.createElement(App));

    const bodyContains = async (needle: string, timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (dom.window.document.body.textContent?.includes(needle)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${needle}". Body: ${dom.window.document.body.textContent}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const clickButtonWithText = (text: string): void => {
      const button = Array.from(dom.window.document.querySelectorAll("button")).find((b) => b.textContent === text);
      if (!button) throw new Error(`no button with text "${text}" — body: ${dom.window.document.body.textContent}`);
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    };
    const setInputValue = (placeholder: string, value: string): void => {
      const input = dom.window.document.querySelector<HTMLInputElement>(`input[placeholder*="${placeholder}"]`);
      if (!input) throw new Error(`no input matching placeholder "${placeholder}"`);
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    const modalGone = async (timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (!dom.window.document.querySelector(".modal-backdrop")) return;
        if (Date.now() > deadline) throw new Error("timed out waiting for the modal to close");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    await bodyContains("Trellis");
    clickButtonWithText("MCP");
    await bodyContains("mcpServers");

    setInputValue("mcpServers", exportFile);
    clickButtonWithText("Import");

    await bodyContains("smoke-imported-server");
    assert.doesNotMatch(
      dom.window.document.body.textContent ?? "",
      /sk-smoke-test-secret-value/,
      "the plan preview must never render the real secret value, even while showing the import plan",
    );
    assert.equal(readFileSync(serversYamlPath, "utf-8").includes("smoke-imported-server"), false, "the plan step alone must not have written anything yet");

    clickButtonWithText("Apply");
    await modalGone();

    const finalServersYaml = readFileSync(serversYamlPath, "utf-8");
    assert.match(finalServersYaml, /smoke-imported-server:/, "a confirmed import apply must actually write the server into servers.yaml");
    assert.doesNotMatch(finalServersYaml, /sk-smoke-test-secret-value/, "servers.yaml itself must never carry the literal secret value");

    const localEnv = readFileSync(join(homeDir, ".trellis", "mcp", "servers.local.env"), "utf-8");
    assert.match(localEnv, /SMOKE_API_KEY=sk-smoke-test-secret-value/, "the real secret value must land in the local, gitignored env file instead");

    root.unmount();
  } finally {
    await sidecar.close();
  }
});

test("App: the Chat tab really spawns a stub CLI, confirms once, and streams tool-call/tool-result/text bubbles over the real WebSocket — and chat traffic never bumps liveVersion", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-smoke-chat-"));
  cli(homeDir, ["init"]);

  const mcpDir = join(homeDir, ".trellis", "mcp");
  mkdirSync(mcpDir, { recursive: true });
  const stubCli = join(repoRoot, "test/fixtures/stub-agent-cli.js");
  writeFileSync(
    join(mcpDir, "chat-agents.yaml"),
    [
      "targets:",
      "  stub-stream:",
      '    label: "Stub Agent"',
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(stubCli)}, "stream", "{prompt}"]`,
      "    outputFormat: stream-json",
      "",
    ].join("\n"),
  );

  const sidecar = await startSidecar(homeDir);
  try {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: `http://localhost/?port=${sidecar.port}` });
    (globalThis as unknown as { window: typeof window }).window = dom.window as unknown as typeof window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
    // Deliberately NOT overriding the bare `WebSocket` global with jsdom's
    // own (jsdom has never implemented it) — `SidecarProvider` calls the
    // bare global, which in this Node process is already the real,
    // functional Node 22+ built-in `WebSocket`, exactly like the sidecar's
    // own tests already rely on.

    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const { default: App } = await import("./App.js");

    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    root.render(React.createElement(App));

    const bodyContains = async (needle: string, timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (dom.window.document.body.textContent?.includes(needle)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${needle}". Body: ${dom.window.document.body.textContent}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const clickButtonWithText = (text: string): void => {
      const button = Array.from(dom.window.document.querySelectorAll("button")).find((b) => b.textContent === text);
      if (!button) throw new Error(`no button with text "${text}" — body: ${dom.window.document.body.textContent}`);
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    };
    const setInputValue = (placeholder: string, value: string): void => {
      const input = dom.window.document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
      if (!input) throw new Error(`no input with placeholder "${placeholder}"`);
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };

    await bodyContains("Trellis");
    clickButtonWithText("Chat");
    await bodyContains("Say hello.");

    setInputValue("Message", "hello there");
    clickButtonWithText("Send");

    // First send for this target: a confirmation modal, not an immediate spawn.
    await bodyContains('Run "Stub Agent"?');
    clickButtonWithText("Confirm & send");

    await bodyContains("stream-reply:hello there");
    await bodyContains("Turn completed");
    assert.ok(
      Array.from(dom.window.document.querySelectorAll(".chat-bubble-tool")).some((el) => el.textContent?.includes("read_file")),
      "expected a real tool-call bubble from the stub CLI's stream-json output",
    );
    assert.ok(
      Array.from(dom.window.document.querySelectorAll(".chat-bubble-tool")).some((el) => el.textContent?.includes("file contents")),
      "expected a real tool-result bubble",
    );

    root.unmount();
  } finally {
    await sidecar.close();
  }
});

test("SidecarProvider: a channel:\"chat\" WS message never bumps liveVersion, while a real file-watcher change does", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-smoke-livever-"));
  cli(homeDir, ["init"]);

  const mcpDir = join(homeDir, ".trellis", "mcp");
  mkdirSync(mcpDir, { recursive: true });
  const stubCli = join(repoRoot, "test/fixtures/stub-agent-cli.js");
  writeFileSync(
    join(mcpDir, "chat-agents.yaml"),
    [
      "targets:",
      "  stub-stream:",
      '    label: "Stub Agent"',
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(stubCli)}, "stream", "{prompt}"]`,
      "    outputFormat: stream-json",
      "",
    ].join("\n"),
  );

  // Let the filesystem settle before the watcher subscribes — macOS
  // FSEvents can otherwise deliver a delayed notification for a write
  // that happened moments before `watchTrellisHome` started, arriving
  // after the WS client connects and looking indistinguishable from a
  // genuinely new change (this is what actually caused this test to be
  // flaky before this delay was added — reproduced and diagnosed live).
  await new Promise((resolve) => setTimeout(resolve, 400));

  const sidecar = await startSidecar(homeDir);
  try {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: `http://localhost/?port=${sidecar.port}` });
    (globalThis as unknown as { window: typeof window }).window = dom.window as unknown as typeof window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });

    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const { SidecarProvider, useSidecar } = await import("./lib/SidecarProvider.js");
    const { postJson } = await import("./lib/sidecar.js");

    function Probe() {
      const { port, liveVersion, chatEvents } = useSidecar();
      const [chatEventCount, setChatEventCount] = React.useState(0);
      React.useEffect(() => {
        const handler = () => setChatEventCount((n) => n + 1);
        chatEvents.addEventListener("chat", handler);
        return () => chatEvents.removeEventListener("chat", handler);
      }, [chatEvents]);
      return React.createElement(
        "div",
        null,
        React.createElement("span", { "data-testid": "port" }, port ?? "none"),
        React.createElement("span", { "data-testid": "live-version" }, liveVersion),
        React.createElement("span", { "data-testid": "chat-event-count" }, chatEventCount),
      );
    }

    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    root.render(React.createElement(SidecarProvider, null, React.createElement(Probe)));

    const textOf = (testId: string): string => dom.window.document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
    const waitForText = async (testId: string, needle: string, timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (textOf(testId) === needle) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for [data-testid="${testId}"] to equal "${needle}", got "${textOf(testId)}"`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    await waitForText("port", String(sidecar.port));
    await waitForText("chat-event-count", "0");
    // Not asserted to be exactly "0": macOS FSEvents can occasionally
    // deliver a delayed notification from the `trellis init`/config-file
    // writes done during setup, arriving just after the watcher attaches.
    // A baseline captured here (rather than a hardcoded "0") keeps the
    // test's actual claim — chat traffic doesn't move liveVersion —
    // independent of that unrelated, real filesystem-event-timing quirk.
    const baselineLiveVersion = textOf("live-version");

    // A real chat turn: several `channel: "chat"` WS broadcasts arrive
    // (turn-start, tool-call, tool-result, text-delta, turn-complete) —
    // none of them should touch liveVersion.
    const started = await postJson<{ chatId: string }>(sidecar.port, "/chat/start", { targetId: "stub-stream" });
    await postJson(sidecar.port, `/chat/${started.chatId}/message`, { message: "hi", confirm: true });
    await waitForText("chat-event-count", "5");
    assert.equal(textOf("live-version"), baselineLiveVersion, "chat traffic must never bump liveVersion");

    // A real, non-chat change through the sidecar's own write path —
    // liveVersion must bump for this, proving Probe is actually wired to
    // real WS traffic and not just permanently stuck at the baseline.
    // `mcp add` also writes a backup manifest alongside `servers.yaml`, so
    // this fires more than one watched-path change (`watcher.ts`'s own
    // "one event per changed path" contract) — assert only that it moved
    // off the baseline, not a specific count, which would be an
    // implementation detail of the backup layout, not of this test's
    // actual claim.
    cli(homeDir, ["mcp", "add", "livever-probe-server", "--transport", "stdio", "--command", "echo", "--json"]);
    const deadline = Date.now() + 5000;
    while (textOf("live-version") === baselineLiveVersion) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for liveVersion to move off its baseline (${baselineLiveVersion}) after a real mcp-add`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(textOf("chat-event-count"), "5", "a file-watcher change must never fire as a chat event");

    root.unmount();
  } finally {
    await sidecar.close();
  }
});

test("App: the language switcher really translates the UI, leaves real backend data untouched, and the choice persists via localStorage", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-smoke-i18n-"));
  cli(homeDir, ["init"]);
  cli(homeDir, ["mcp", "add", "smoke-i18n-server", "--transport", "stdio", "--command", "echo", "--json"]);

  const sidecar = await startSidecar(homeDir);
  try {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: `http://localhost/?port=${sidecar.port}` });
    (globalThis as unknown as { window: typeof window }).window = dom.window as unknown as typeof window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });

    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const { default: App } = await import("./App.js");

    const bodyContains = async (needle: string, timeoutMs = 5000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (dom.window.document.body.textContent?.includes(needle)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${needle}". Body: ${dom.window.document.body.textContent}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const bodyDoesNotContain = (needle: string): void => {
      assert.equal(dom.window.document.body.textContent?.includes(needle), false, `expected "${needle}" to be absent. Body: ${dom.window.document.body.textContent}`);
    };
    const findButtonWithText = (text: string): HTMLButtonElement | undefined =>
      Array.from(dom.window.document.querySelectorAll("button")).find((b) => b.textContent === text);
    const clickButtonWithText = (text: string): void => {
      const button = findButtonWithText(text);
      if (!button) throw new Error(`no button with text "${text}" — body: ${dom.window.document.body.textContent}`);
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    };

    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    root.render(React.createElement(App));

    // Default in this test environment: jsdom's `navigator.language` is
    // "en-US" and no prior localStorage choice exists, so English.
    await bodyContains("Trellis");
    assert.ok(findButtonWithText("Agents"), "expected the English nav label by default");
    // The provider persists whatever language is active — including the
    // detected default — as soon as it mounts, not only on an explicit
    // switch, so the stored value is already "en" here.
    assert.equal(dom.window.localStorage.getItem("trellis-gui-lang"), "en");

    // Switch to Chinese via a real click — the nav label must actually
    // change, and real backend data (the MCP server name just added
    // above) must NOT be touched by the switch.
    clickButtonWithText("中文");
    await bodyContains("代理");
    bodyDoesNotContain("Agents");
    assert.equal(dom.window.localStorage.getItem("trellis-gui-lang"), "zh", "the choice must be persisted to localStorage");

    clickButtonWithText("MCP");
    await bodyContains("smoke-i18n-server");
    assert.ok(findButtonWithText("添加"), "expected the MCP view's Add button translated to Chinese");
    assert.ok(!findButtonWithText("Add"), "the English Add button must be gone once switched to Chinese");

    // Real data must survive translation unscathed — the actual server
    // name is not, and must never become, a translation target.
    await bodyContains("smoke-i18n-server");

    // Persistence: unmount and remount fresh (same jsdom `window`, so the
    // same real `localStorage`) — the app must come back up already in
    // Chinese, proving the initial-language detection actually reads
    // localStorage rather than the switch merely being in-memory state.
    root.unmount();
    const root2 = createRoot(container);
    root2.render(React.createElement(App));
    await bodyContains("代理");
    assert.ok(!findButtonWithText("Agents"), "a fresh mount must honor the persisted language choice");

    // Switch back to English via a real click, to prove it's a genuine
    // two-way toggle, not a one-shot migration.
    clickButtonWithText("EN");
    await bodyContains("Agents");
    assert.equal(dom.window.localStorage.getItem("trellis-gui-lang"), "en");

    root2.unmount();
  } finally {
    await sidecar.close();
  }
});
