/**
 * Bedrock transport support. Claude Code on Bedrock does not speak the first-party
 * `/v1/messages` API: it signs its own SigV4 requests to
 * `POST /model/<url-encoded model id>/invoke` (or `/invoke-with-response-stream`), with no
 * `model` field in the body (Bedrock rejects one). This module bridges that shape to and
 * from the one the rest of jev-router already understands.
 */
import { readFileSync } from "node:fs";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
// The installed SDK (3.972.84) exports the default chain as `defaultProvider`; there is no
// `fromNodeProviderChain` export in this package version.
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const BEDROCK_PATH_RE = /^\/model\/([^/]+)\/(invoke(?:-with-response-stream)?)$/;

/**
 * Splits a Bedrock invoke path into the model id (decoded) and the action, or null if the
 * path is not a Bedrock model-invoke request.
 *
 * @returns {?{model: string, action: string}}
 */
export function parseBedrockPath(path) {
  const match = BEDROCK_PATH_RE.exec(path ?? "");
  if (!match) return null;
  return { model: decodeURIComponent(match[1]), action: match[2] };
}

/** Builds a Bedrock invoke path for a model id, the inverse of {@link parseBedrockPath}. */
export function bedrockPath(model, action) {
  return `/model/${encodeURIComponent(model)}/${action}`;
}

/**
 * Our shared `.claude/settings.json` names one Bedrock model id per tier via
 * `ANTHROPIC_DEFAULT_*_MODEL`. The `[1m]` suffix requests a long-context variant of the same
 * model rather than naming a different one, and Claude Code's default 200k window applies to
 * whatever we route to anyway (see the Risks section of the handoff), so it is stripped before
 * the id is offered to Jev and the rest of jev-router as a routing target.
 */
const DEFAULT_MODEL_ENV = {
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
};

/** Bedrock's own default model id per tier, used when a setting is not present. */
const BEDROCK_DEFAULT_MODEL = {
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  sonnet: "us.anthropic.claude-sonnet-5",
  opus: "us.anthropic.claude-opus-5-5",
  fable: "us.anthropic.claude-fable-5-1",
};

const stripContextSuffix = (id) => id.replace(/\[[^\]]*\]$/, "");

/** One Bedrock model id per tier, sourced from our settings and falling back to Bedrock's own defaults. */
export function bedrockModels(env = {}) {
  return Object.entries(DEFAULT_MODEL_ENV).map(([tier, key]) => ({
    id: stripContextSuffix(env[key] ?? BEDROCK_DEFAULT_MODEL[tier]),
  }));
}

/**
 * The default credential chain does its own network/file probing (env vars, SSO cache,
 * instance metadata, ...), so it is resolved once per process rather than once per request.
 */
let defaultCredentials;
function nodeCredentialProvider() {
  defaultCredentials ??= defaultProvider();
  return defaultCredentials;
}

/** Headers a Claude Code request never gets to keep: they were signed for the wrong service. */
const STRIPPED_HEADERS = ["authorization", "x-api-key"];

/**
 * SigV4-signs a Bedrock `invoke`/`invoke-with-response-stream` request. `path` is the exact
 * string that goes out on the wire, already `encodeURIComponent`-escaped once by
 * {@link bedrockPath}. AWS's SigV4 spec calls for URI-escaping each path segment a *second*
 * time when building the canonical request for every service except S3 — Bedrock is not S3,
 * so `uriEscapePath` is left at its default (true). Passing `false` here looks like the safe
 * choice to avoid double-encoding, but it produces a signature real Bedrock rejects with a
 * 403 "signature we calculated does not match" whose own recomputed canonical string shows
 * the doubled encoding it expected; confirmed against the live endpoint, not just a stub.
 * `credentials` defaults to the standard AWS provider chain, so a caller running under an SSO
 * session or instance role needs nothing extra.
 *
 * @returns {Promise<Record<string,string>>} the full signed header set, including
 *   `authorization`, `x-amz-date` and `host`.
 */
export async function signRequest({
  region,
  method = "POST",
  path,
  headers = {},
  body,
  credentials,
  signingDate,
}) {
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const toSign = { ...headers, host };
  for (const name of Object.keys(toSign)) {
    if (STRIPPED_HEADERS.includes(name.toLowerCase())) delete toSign[name];
  }
  const signer = new SignatureV4({
    service: "bedrock",
    region,
    credentials: credentials ?? nodeCredentialProvider(),
    sha256: Sha256,
  });
  const signed = await signer.sign(
    { method, protocol: "https:", hostname: host, path, headers: toSign, body },
    signingDate ? { signingDate } : undefined,
  );
  return signed.headers;
}

/**
 * `env` blocks from each settings file, merged left to right (a later file overrides an
 * earlier one). A missing or malformed file contributes nothing rather than failing the
 * whole lookup, the same tolerance `src/settings.mjs` gives a broken `settings.json`.
 */
function mergedSettingsEnv(settingsFiles = []) {
  const merged = {};
  for (const file of settingsFiles) {
    try {
      Object.assign(merged, JSON.parse(readFileSync(file, "utf8")).env);
    } catch {
      // Missing, unreadable, or not JSON; nothing to contribute.
    }
  }
  return merged;
}

/** `"0"` and `"false"` are how a settings file spells "off"; anything else truthy is on. */
const isOn = (value) => Boolean(value) && value !== "0" && value !== "false";

/**
 * Whether Claude Code is running on Bedrock, and if so, the region and model catalog to run
 * the proxy with. `settingsFiles` should be given lowest-precedence first: our shared,
 * checked-in `.claude/settings.json` is where `CLAUDE_CODE_USE_BEDROCK` and the account's
 * default model ids normally live, and a project's own `settings.local.json` — read last, so
 * it wins — is where a per-project override would go.
 *
 * @returns {?{region: string, models: {id: string}[]}}
 */
export function bedrockConfig(env = {}, settingsFiles = []) {
  const settingsEnv = mergedSettingsEnv(settingsFiles);
  if (!isOn(env.CLAUDE_CODE_USE_BEDROCK) && !isOn(settingsEnv.CLAUDE_CODE_USE_BEDROCK)) return null;
  const region = env.JEV_BEDROCK_REGION || env.AWS_REGION || settingsEnv.AWS_REGION || "us-east-1";
  return { region, models: bedrockModels({ ...settingsEnv, ...env }) };
}
