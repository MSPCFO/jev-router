import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBedrockPath,
  bedrockPath,
  bedrockModels,
  signRequest,
  bedrockConfig,
} from "../src/bedrock.mjs";
import { tierOf } from "../src/config.mjs";
import { startProxy } from "../src/proxy.mjs";

const CREDENTIALS = { accessKeyId: "AKIDTEST", secretAccessKey: "secret" };

test("parses an invoke-with-response-stream path for the sentinel model", () => {
  assert.deepEqual(parseBedrockPath("/model/jev-router/invoke-with-response-stream"), {
    model: "jev-router",
    action: "invoke-with-response-stream",
  });
});

test("decodes a bracketed context-window suffix in the model id", () => {
  assert.deepEqual(parseBedrockPath("/model/us.anthropic.claude-opus-5-5%5B1m%5D/invoke"), {
    model: "us.anthropic.claude-opus-5-5[1m]",
    action: "invoke",
  });
});

test("decodes a colon in the model id", () => {
  assert.deepEqual(
    parseBedrockPath("/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke"),
    { model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", action: "invoke" },
  );
});

test("a non-model path is not a Bedrock invoke request", () => {
  assert.equal(parseBedrockPath("/v1/models"), null);
  assert.equal(parseBedrockPath("/"), null);
  assert.equal(parseBedrockPath(""), null);
});

test("bedrockPath round-trips a model id through encodeURIComponent", () => {
  const model = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
  const path = bedrockPath(model, "invoke-with-response-stream");
  assert.equal(path, `/model/${encodeURIComponent(model)}/invoke-with-response-stream`);
  assert.deepEqual(parseBedrockPath(path), { model, action: "invoke-with-response-stream" });
});

test("bedrockPath round-trips a bracketed model id", () => {
  const model = "us.anthropic.claude-opus-5-5[1m]";
  const path = bedrockPath(model, "invoke");
  assert.deepEqual(parseBedrockPath(path), { model, action: "invoke" });
});

test("builds the catalog from our default model env, stripping the context suffix", () => {
  const env = {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-5",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-5-5[1m]",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "us.anthropic.claude-fable-5-1[1m]",
  };
  const models = bedrockModels(env);
  assert.deepEqual(models.map(({ id }) => id), [
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-sonnet-5",
    "us.anthropic.claude-opus-5-5",
    "us.anthropic.claude-fable-5-1",
  ]);
  for (const { id } of models) assert.ok(tierOf(id), `${id} should resolve to a tier`);
});

test("falls back to Bedrock's default model ids with an empty env", () => {
  const models = bedrockModels({});
  assert.deepEqual(models.map(({ id }) => id), [
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-sonnet-5",
    "us.anthropic.claude-opus-5-5",
    "us.anthropic.claude-fable-5-1",
  ]);
});

test("signs a request with SigV4 and sets the Bedrock host", async () => {
  const headers = await signRequest({
    region: "us-east-1",
    method: "POST",
    path: bedrockPath("us.anthropic.claude-sonnet-5", "invoke"),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31" }),
    credentials: CREDENTIALS,
  });
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
  assert.ok(headers["x-amz-date"]);
  assert.equal(headers.host, "bedrock-runtime.us-east-1.amazonaws.com");
});

test("drops any incoming authorization and x-api-key headers before signing", async () => {
  const headers = await signRequest({
    region: "us-east-1",
    method: "POST",
    path: "/model/us.anthropic.claude-sonnet-5/invoke",
    headers: { authorization: "Bearer stale", "x-api-key": "stale-key" },
    body: "{}",
    credentials: CREDENTIALS,
  });
  assert.notEqual(headers.authorization, "Bearer stale");
  assert.equal(headers["x-api-key"], undefined);
});

test("does not double-encode a path that already has percent-encoded colons and brackets", async () => {
  const path = bedrockPath("us.anthropic.claude-haiku-4-5-20251001-v1:0", "invoke");
  const signingDate = new Date("2026-01-01T00:00:00Z");
  const headers = await signRequest({
    region: "us-east-1",
    method: "POST",
    path,
    headers: {},
    body: "{}",
    credentials: CREDENTIALS,
    signingDate,
  });
  // Re-sign the same request straight through the underlying library with
  // `uriEscapePath: false`. If signRequest instead let the default `uriEscapePath: true`
  // apply, it would percent-encode the `%` in the already-encoded path a second time and
  // produce a different signature from this one, which pins the path down as sent.
  const { SignatureV4 } = await import("@smithy/signature-v4");
  const { Sha256 } = await import("@aws-crypto/sha256-js");
  const signer = new SignatureV4({
    service: "bedrock",
    region: "us-east-1",
    credentials: CREDENTIALS,
    sha256: Sha256,
    uriEscapePath: false,
  });
  const expected = await signer.sign(
    {
      method: "POST",
      protocol: "https:",
      hostname: "bedrock-runtime.us-east-1.amazonaws.com",
      path,
      headers: { host: "bedrock-runtime.us-east-1.amazonaws.com" },
      body: "{}",
    },
    { signingDate },
  );
  assert.equal(headers.authorization, expected.headers.authorization);
});

/** A stub Bedrock endpoint that records every request it receives and replies with `reply`. */
function stubBedrock(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.end(reply);
    });
  });
  return { server, seen };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("a routed request lands on the chosen model's Bedrock path, stripped and signed", async (t) => {
  const { server, seen } = stubBedrock('{"id":"msg_1"}');
  const port = await listen(server);
  t.after(() => server.close());

  const bedrock = {
    region: "us-east-1",
    models: bedrockModels({}),
    credentials: CREDENTIALS,
  };
  const { port: proxyPort, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${port}`,
    bedrock,
    route: async () => ({
      choice: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      confidence: 0.9,
      ms: 1,
    }),
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${proxyPort}/model/jev-router/invoke-with-response-stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      thinking: { type: "adaptive" },
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "rename this variable" }],
    }),
  });

  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    `/model/${encodeURIComponent("us.anthropic.claude-haiku-4-5-20251001-v1:0")}/invoke-with-response-stream`,
  );
  const forwarded = JSON.parse(seen[0].body.toString());
  assert.equal(forwarded.model, undefined, "Bedrock rejects an extra model field");
  assert.equal(forwarded.thinking, undefined, "Haiku cannot accept thinking");
  assert.match(seen[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
});

test("an explicit model choice keeps its own Bedrock path and body, only re-signed", async (t) => {
  const { server, seen } = stubBedrock('{"id":"msg_1"}');
  const port = await listen(server);
  t.after(() => server.close());

  const bedrock = { region: "us-east-1", models: bedrockModels({}), credentials: CREDENTIALS };
  const { port: proxyPort, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${port}`,
    bedrock,
    route: async () => {
      throw new Error("an explicit model choice must never be routed");
    },
  });
  t.after(close);

  const body = {
    model: "us.anthropic.claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
  };
  await fetch(`http://127.0.0.1:${proxyPort}/model/us.anthropic.claude-sonnet-5/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/model/us.anthropic.claude-sonnet-5/invoke");
  const forwarded = JSON.parse(seen[0].body.toString());
  assert.equal(forwarded.model, undefined);
  assert.deepEqual(forwarded.messages, body.messages);
  assert.match(seen[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
});

test("a binary response streams back byte-identical", async (t) => {
  const binary = Buffer.from([0x00, 0x01, 0xff, 0x02, 0xfe, 0x03]);
  const { server } = stubBedrock(binary);
  const port = await listen(server);
  t.after(() => server.close());

  const bedrock = { region: "us-east-1", models: bedrockModels({}), credentials: CREDENTIALS };
  const { port: proxyPort, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${port}`,
    bedrock,
    route: async () => ({ choice: "us.anthropic.claude-sonnet-5", confidence: 0.9, ms: 1 }),
  });
  t.after(close);

  const response = await fetch(`http://127.0.0.1:${proxyPort}/model/us.anthropic.claude-sonnet-5/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "us.anthropic.claude-sonnet-5", messages: [] }),
  });
  const received = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(received, binary);
});

/** Writes a `settings.json`-shaped file with the given `env` block to a fresh temp dir. */
const settingsFile = (env) => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-bedrock-")), "settings.json");
  writeFileSync(file, JSON.stringify({ env }));
  return file;
};
const MISSING_FILE = join(tmpdir(), "jev-bedrock-does-not-exist", "settings.json");

test("bedrockConfig is null when Bedrock is off everywhere", () => {
  assert.equal(bedrockConfig({}, []), null);
  assert.equal(bedrockConfig({ AWS_REGION: "us-west-2" }, [settingsFile({})]), null);
});

test("bedrockConfig turns on from CLAUDE_CODE_USE_BEDROCK in the environment", () => {
  const config = bedrockConfig({ CLAUDE_CODE_USE_BEDROCK: "1" }, []);
  assert.ok(config);
  assert.equal(config.region, "us-east-1");
});

test("bedrockConfig turns on from CLAUDE_CODE_USE_BEDROCK in any settings file", () => {
  const config = bedrockConfig({}, [settingsFile({}), settingsFile({ CLAUDE_CODE_USE_BEDROCK: "1" })]);
  assert.ok(config);
});

test("region precedence: JEV_BEDROCK_REGION beats everything else", () => {
  const config = bedrockConfig(
    { CLAUDE_CODE_USE_BEDROCK: "1", JEV_BEDROCK_REGION: "eu-west-1", AWS_REGION: "us-west-2" },
    [settingsFile({ AWS_REGION: "ap-south-1" })],
  );
  assert.equal(config.region, "eu-west-1");
});

test("region precedence: env AWS_REGION beats the settings file", () => {
  const config = bedrockConfig({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" }, [
    settingsFile({ AWS_REGION: "ap-south-1" }),
  ]);
  assert.equal(config.region, "us-west-2");
});

test("region precedence: the settings file beats the us-east-1 default", () => {
  const config = bedrockConfig({ CLAUDE_CODE_USE_BEDROCK: "1" }, [
    settingsFile({ AWS_REGION: "ap-south-1" }),
  ]);
  assert.equal(config.region, "ap-south-1");
});

test("region falls back to us-east-1 when nothing sets it", () => {
  const config = bedrockConfig({ CLAUDE_CODE_USE_BEDROCK: "1" }, [MISSING_FILE]);
  assert.equal(config.region, "us-east-1");
});

test("bedrockConfig's models come from settings and env default-model settings, merged", () => {
  const config = bedrockConfig(
    {
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-5-5[1m]",
    },
    [settingsFile({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0" })],
  );
  assert.deepEqual(config.models, bedrockModels({
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-5-5[1m]",
  }));
});

test("a missing or unreadable settings file is not an error", () => {
  assert.doesNotThrow(() => bedrockConfig({ CLAUDE_CODE_USE_BEDROCK: "1" }, [MISSING_FILE]));
});
