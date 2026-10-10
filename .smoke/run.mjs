/**
 * End-to-end smoke test for the file-chat plugin.
 *
 * Runs the compiled plugin against a stubbed OpenClaw host:
 *   - `plugin-entry`        captures the registered HTTP route
 *   - `agent-runtime`       fake agent turn (writes an outbound file, streams text)
 *   - `agent-harness-runtime` in-memory agent event bus
 *   - `ssrf-runtime`        plain fetch
 *
 * Usage: node .smoke/run.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setAgentImpl } from "./node_modules/openclaw/plugin-sdk/_bus.js";
import { __emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const filesRoot = path.join(here, "workspace", "files");

// Always test the freshly built output. A stale copy here has bitten before.
const distSource = path.join(here, "..", "dist");
if (!fs.existsSync(path.join(distSource, "index.js"))) {
  console.error("dist/index.js not found — run `npm run build` first");
  process.exit(1);
}
fs.rmSync(path.join(here, "dist"), { recursive: true, force: true });
fs.cpSync(distSource, path.join(here, "dist"), { recursive: true });

// Imported after the copy so the test never exercises a stale build.
const { default: pluginEntry } = await import("./dist/index.js");

fs.rmSync(path.join(here, "workspace"), { recursive: true, force: true });
fs.mkdirSync(filesRoot, { recursive: true });

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` -> ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------- fake agent

let outboundWrites = 0;
let capturedOpts;

setAgentImpl(async (opts) => {
  capturedOpts = opts;

  // Derive the outbound directory the way the model would: it is stated in the
  // system prompt. This also verifies placeholder substitution.
  const match = opts.extraSystemPrompt?.match(/^\s{2}(\S.*)$/m);
  const outboundDir = match ? match[1].trim() : undefined;
  if (!outboundDir) {
    throw new Error("could not locate outbound directory in system prompt");
  }

  const text = "done: 处理完成";
  for (const ch of text) {
    __emitAgentEvent({ runId: opts.runId, seq: 0, stream: "assistant", ts: Date.now(), data: { delta: ch } });
  }
  __emitAgentEvent({ runId: opts.runId, seq: 0, stream: "thinking", ts: Date.now(), data: { delta: "思考中" } });

  outboundWrites += 1;
  // First turn writes a file; subsequent turns write nothing new.
  if (outboundWrites === 1) {
    fs.writeFileSync(path.join(outboundDir, "report.md"), "# report\nhello\n");
    fs.mkdirSync(path.join(outboundDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(outboundDir, "nested", "data.csv"), "a,b\n1,2\n");
  }

  __emitAgentEvent({ runId: opts.runId, seq: 0, stream: "lifecycle", ts: Date.now(), data: { phase: "end" } });
});

// ------------------------------------------------------------- plugin + api

const captured = { route: undefined };
const fakeApi = {
  id: "file-chat",
  name: "File Chat HTTP API",
  config: { agents: { defaults: {} } },
  pluginConfig: {
    apiKey: "secret-key",
    filesRoot,
    publicPathPrefix: "",
  },
  logger: {
    info: (msg) => console.log(`  [host] ${msg}`),
    warn: (msg) => console.log(`  [host:warn] ${msg}`),
    error: (msg) => console.log(`  [host:error] ${msg}`),
    debug: () => {},
  },
  registerHttpRoute: (params) => {
    captured.route = params;
  },
  resolvePath: (p) => p,
};

pluginEntry.register(fakeApi);

if (!captured.route) {
  console.error("plugin did not register an HTTP route");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  Promise.resolve(captured.route.handler(req, res)).catch((err) => {
    console.error("handler threw:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end(String(err));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}${captured.route.path}`;

// A tiny file server so the "download URL" inbound path can be exercised.
const fileServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/pdf", "content-length": "11" });
  res.end("PDF-BYTES!!");
});
await new Promise((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
const remoteFileUrl = `http://127.0.0.1:${fileServer.address().port}/remote.pdf`;

const AUTH = { "x-api-key": "secret-key", "content-type": "application/json" };

// -------------------------------------------------------------- test 1: JSON

section("1. JSON request, non-streaming, base64 attachment");
{
  const res = await fetch(base, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      message: "总结这个文件",
      user: "alice",
      stream: false,
      files: [
        { name: "contract.pdf", mimeType: "application/pdf", content: Buffer.from("PDF-CONTENT").toString("base64") },
      ],
    }),
  });
  const json = await res.json();

  check("status 200", res.status === 200, res.status);
  check("finish_reason stop", json.choices?.[0]?.finish_reason === "stop", json.choices?.[0]?.finish_reason);
  check("assistant content streamed", String(json.choices?.[0]?.message?.content ?? "").includes("done"), json.choices?.[0]?.message?.content);
  check("reasoning_content present", json.choices?.[0]?.message?.reasoning_content === "思考中", json.choices?.[0]?.message?.reasoning_content);
  check("sessionKey stable per user", json.sessionKey === "file-chat-user-alice", json.sessionKey);
  check("sessionGenerated false", json.sessionGenerated === false, json.sessionGenerated);
  check("1 inbound file", json.files?.inbound?.length === 1, JSON.stringify(json.files?.inbound));
  check(
    "inbound path is relative to filesRoot",
    json.files?.inbound?.[0]?.path === "inbound/file-chat-user-alice/contract.pdf",
    json.files?.inbound?.[0]?.path,
  );
  check("inbound file on disk", fs.existsSync(json.files?.inbound?.[0]?.absolutePath ?? ""), json.files?.inbound?.[0]?.absolutePath);
  check("2 outbound files detected", json.files?.outbound?.length === 2, JSON.stringify(json.files?.outbound?.map((f) => f.path)));
  check(
    "outbound path relative form",
    json.files?.outbound?.some((f) => f.path === "outbound/file-chat-user-alice/report.md"),
    JSON.stringify(json.files?.outbound?.map((f) => f.path)),
  );
  check(
    "nested outbound file reported",
    json.files?.outbound?.some((f) => f.path === "outbound/file-chat-user-alice/nested/data.csv"),
    JSON.stringify(json.files?.outbound?.map((f) => f.path)),
  );
  check(
    "footer appended to content",
    String(json.choices?.[0]?.message?.content ?? "").includes("[file-chat outbound files]"),
    json.choices?.[0]?.message?.content,
  );
  check(
    "system prompt got absolute outbound dir",
    capturedOpts?.extraSystemPrompt?.includes(path.join("outbound", "file-chat-user-alice")),
    capturedOpts?.extraSystemPrompt,
  );
  check("deliver false", capturedOpts?.deliver === false, capturedOpts?.deliver);
  check("allowModelOverride false without override", capturedOpts?.allowModelOverride === false, capturedOpts?.allowModelOverride);
  check(
    "inbound absolute path injected into message",
    String(capturedOpts?.message ?? "").includes("[file-chat inbound files]"),
    capturedOpts?.message,
  );
}

// ------------------------------------- test 2: outbound diff does not repeat

section("2. Second turn in same session: unchanged files are not re-reported");
{
  const res = await fetch(base, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ message: "再来一次", user: "alice", stream: false }),
  });
  const json = await res.json();
  check("status 200", res.status === 200, res.status);
  check("no outbound files reported", (json.files?.outbound ?? []).length === 0, JSON.stringify(json.files?.outbound));
  check("no inbound files", (json.files?.inbound ?? []).length === 0, JSON.stringify(json.files?.inbound));
  check("no footer when nothing produced", !String(json.choices?.[0]?.message?.content ?? "").includes("outbound files"), json.choices?.[0]?.message?.content);
}

// ------------------------------------------------------------ test 3: stream

section("3. Streaming (SSE) with multipart upload");
{
  const form = new FormData();
  form.set("message", "分析附件");
  form.set("user", "bob");
  form.set("stream", "true");
  form.set("files", new Blob([Buffer.from("hello world")], { type: "text/plain" }), "notes.txt");

  const res = await fetch(base, {
    method: "POST",
    headers: { "x-api-key": "secret-key" },
    body: form,
  });
  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));

  check("status 200", res.status === 200, res.status);
  check("content-type is SSE", String(res.headers.get("content-type")).includes("text/event-stream"), res.headers.get("content-type"));
  check("terminated with [DONE]", lines[lines.length - 1] === "[DONE]", lines[lines.length - 1]);

  const chunks = lines.filter((l) => l !== "[DONE]").map((l) => JSON.parse(l));
  check("first chunk is role delta", chunks[0]?.choices?.[0]?.delta?.role === "assistant", JSON.stringify(chunks[0]));
  const streamedContent = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  check("assistant deltas streamed", streamedContent.includes("done"), JSON.stringify(streamedContent));
  check("reasoning delta streamed", chunks.some((c) => c.choices?.[0]?.delta?.reasoning_content === "思考中"), "no reasoning delta");
  const last = chunks[chunks.length - 1];
  check("final chunk has finish_reason stop", last?.choices?.[0]?.finish_reason === "stop", JSON.stringify(last));
  check("final chunk carries files", Array.isArray(last?.files?.inbound) && Array.isArray(last?.files?.outbound), JSON.stringify(last?.files));
  check("multipart filename preserved", last?.files?.inbound?.[0]?.name === "notes.txt", last?.files?.inbound?.[0]?.name);
  check(
    "multipart file landed on disk",
    fs.existsSync(last?.files?.inbound?.[0]?.absolutePath ?? ""),
    last?.files?.inbound?.[0]?.absolutePath,
  );
}

// -------------------------------------------------------- test 4: traversal

section("4. Path traversal in filename is neutralised");
{
  const res = await fetch(base, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      message: "traversal",
      user: "carol",
      stream: false,
      files: [{ name: "../../../evil.txt", content: Buffer.from("x").toString("base64") }],
    }),
  });
  const json = await res.json();
  const saved = json.files?.inbound?.[0];
  check("status 200", res.status === 200, res.status);
  check("name sanitised", saved?.name === "evil.txt", saved?.name);
  check(
    "stored inside inbound dir",
    String(saved?.absolutePath ?? "").startsWith(path.join(filesRoot, "inbound")),
    saved?.absolutePath,
  );
  check("nothing written above filesRoot", !fs.existsSync(path.join(here, "workspace", "evil.txt")), "escaped the root");
}

// ----------------------------------------------- test 4b: traversal sessionKey

section("4b. Traversal in sessionKey stays inside filesRoot");
{
  const res = await fetch(base, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ message: "sid", sessionKey: "../../escape", stream: false }),
  });
  const json = await res.json();
  check("status 200", res.status === 200, res.status);
  check(
    "session dir sanitised",
    String(json.files?.inbound?.[0]?.absolutePath ?? json.sessionKey).length > 0 &&
      fs.existsSync(path.join(filesRoot, "outbound")) &&
      !fs.existsSync(path.join(here, "workspace", "escape")),
    json.sessionKey,
  );
  check("sessionKey echoed", json.sessionKey === "../../escape", json.sessionKey);
}

// ------------------------------------------------------------ test 5: errors

section("5. Auth and validation errors");
{
  const unauth = await fetch(base, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ message: "" }),
  });
  check("empty message -> 400", unauth.status === 400, unauth.status);

  const noKey = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  check("missing api key -> 401", noKey.status === 401, noKey.status);

  const wrongKey = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "nope" },
    body: JSON.stringify({ message: "hi" }),
  });
  check("wrong api key -> 401", wrongKey.status === 401, wrongKey.status);

  const reserved = await fetch(base, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ message: "hi", sessionKey: "cron:job1" }),
  });
  check("reserved sessionKey namespace -> 400", reserved.status === 400, reserved.status);

  const get = await fetch(base, { method: "GET" });
  check("GET -> 405", get.status === 405, get.status);

  const badJson = await fetch(base, {
    method: "POST",
    headers: AUTH,
    body: "{not json",
  });
  check("malformed JSON -> 400", badJson.status === 400, badJson.status);
}

// ------------------------------------------------------- test 6: URL inbound

section("6. Inbound file by download URL");
{
  const res = await fetch(base, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ message: "fetch it", user: "dave", stream: false, urls: [remoteFileUrl] }),
  });
  const json = await res.json();
  const saved = json.files?.inbound?.[0];
  check("status 200", res.status === 200, res.status);
  check("one inbound file", json.files?.inbound?.length === 1, JSON.stringify(json.files?.inbound));
  check("source is url", saved?.source === "url", saved?.source);
  check("extension inferred from content-type", saved?.name === "file.pdf", saved?.name);
  check("bytes written", saved?.size === 11, saved?.size);
  check(
    "content matches",
    fs.readFileSync(saved?.absolutePath ?? "", "utf-8") === "PDF-BYTES!!",
    "content mismatch",
  );
}

// ------------------------------------------- test 7: no apiKey => gateway auth

section("7. Without apiKey the route uses gateway auth and skips key checks");
{
  const captured2 = { route: undefined };
  const entry2 = (await import("./dist/index.js?fresh=1")).default;
  entry2.register({
    ...fakeApi,
    pluginConfig: { filesRoot, appendOutboundFooter: false },
    registerHttpRoute: (params) => {
      captured2.route = params;
    },
  });
  check("auth is gateway", captured2.route?.auth === "gateway", captured2.route?.auth);

  const server2 = http.createServer((req, res) => {
    Promise.resolve(captured2.route.handler(req, res)).catch(() => res.end());
  });
  await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}${captured2.route.path}`;
  const res = await fetch(base2, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "no key needed", user: "erin", stream: false }),
  });
  const json = await res.json();
  check("status 200 without api key", res.status === 200, res.status);
  check("footer suppressed by config", !String(json.choices?.[0]?.message?.content ?? "").includes("outbound files"), json.choices?.[0]?.message?.content);
  await new Promise((resolve) => server2.close(resolve));
}

// ------------------------------------------------------------------- report

section("Files on disk");
console.log(
  JSON.stringify(
    listTree(path.join(here, "workspace")),
    null,
    2,
  ),
);

console.log(`\n${passed} passed, ${failed} failed`);
server.close();
fileServer.close();
process.exit(failed === 0 ? 0 : 1);

function listTree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${rel}/`);
      } else {
        out.push(rel);
      }
    }
  };
  if (fs.existsSync(root)) {
    walk(root, "");
  }
  return out;
}
