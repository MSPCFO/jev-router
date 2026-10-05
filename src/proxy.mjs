import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  TIERS,
  tierOf,
  idOf,
  availableTiers,
  tierSpec,
  isAuto,
  shouldUseExactModel,
} from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { writeDecision, writeStatus } from "./status.mjs";
import { parseBedrockPath, bedrockPath, signRequest } from "./bedrock.mjs";
import { routingEnabled } from "./routing-switch.mjs";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  const last = body?.messages?.[body.messages.length - 1];
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control. The first tier seen in a conversation is the baseline; any later change means the
 * user picked a model with /model, and an explicit choice must beat the router. Compared by
 * tier rather than exact model id, because Claude Code varies the id within a tier.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}


export async function startProxy({
  upstreamURL,
  route = askJev,
  bedrock,
  port = 0,
  host = "127.0.0.1",
  sha,
} = {}) {
  const resolvedUpstreamURL =
    upstreamURL ?? (bedrock ? `https://bedrock-runtime.${bedrock.region}.amazonaws.com` : ANTHROPIC_BASE_URL);

  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  // Bedrock has no `/v1/models` endpoint to learn the account's exact model ids from, so the
  // catalog starts pre-filled with what our own settings say each tier's model id is.
  const catalog = new Map(bedrock?.models?.map((model) => [model.id, model]) ?? []);
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size > 50) convos.delete(convos.keys().next().value);
      convos.set(key, (s = { tier: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    // Lets `jev-daemon` tell a live router from a stale pid or an unrelated listener.
    if (req.method === "GET" && (req.url ?? "").split("?")[0] === "/jev/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jev: true, sha: sha ?? null, pid: process.pid }));
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      // Bedrock carries the model in the path, not the body, and rejects an extra `model`
      // key, so this is patched in before routing and undone right before the request is
      // forwarded; everything between sees the same shape as the first-party API.
      const bedrockRequest = bedrock ? parseBedrockPath(req.url) : null;
      let outPath = req.url ?? "";

      if (bedrock ? bedrockRequest : /^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          if (bedrockRequest) body.model = bedrockRequest.model;
          // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          // Anything that is not the sentinel is a model the user chose, and an explicit
          // choice beats the router. That also covers Claude Code's own cheap Haiku calls
          // for titles and summaries, which must never be pinned up to the session's tier.
          if (!isAuto(body.model)) {
            debug(`passthrough, user selected ${body.model}`);
            // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
            // calls carry no tools and must not flip the status line to manual mid-session.
            if (Array.isArray(body.tools)) {
              writeStatus(sessionOf(body), { manual: true, at: Date.now() });
            }
          } else {
            const key = conversationKey(body);
            const state = stateFor(key);
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = state.tier ?? "opus";
            const prompt = newTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>");
            let fresh = null;
            if (prompt && !explaining) {
              const models = claudeModels([...catalog.values()]).filter((model) =>
                availableTiers().includes(model.tier),
              );
              const available = [...new Set(models.map((model) => model.tier))];
              const currentModel = state.model ?? modelForTier(models, current);
              const contextTokens = Math.round(JSON.stringify(body.messages).length / 4);
              if (!routingEnabled()) {
                // The user turned routing off: keep the session on the Opus tier and never
                // call Jev. The status line shows this as "jev off".
                state.tier = "opus";
                state.model = modelForTier(models, "opus");
                fresh = {
                  prompt,
                  model: state.model,
                  confidence: null,
                  metrics: null,
                  reason: "off",
                  jev: null,
                };
              } else {
                const jev = await route({ prompt, current: currentModel, contextTokens, models });
                const chosen = models.find((model) => model.id === jev?.choice);
                const tierAnswer = jev && { ...jev, choice: chosen?.tier };
                const { tier, reason } = decide({
                  prompt,
                  jev: tierAnswer,
                  current,
                  available,
                  contextTokens,
                });
                const model =
                  shouldUseExactModel(reason, chosen?.tier, tier)
                    ? chosen.id
                    : tier === current
                      ? currentModel
                      : modelForTier(models, tier);
                state.tier = tier;
                state.model = model;
                fresh = {
                  prompt,
                  model,
                  confidence: jev?.confidence ?? null,
                  metrics: jev?.metrics ?? null,
                  reason,
                  jev: jev ? { request: jev.request, response: jev.response } : null,
                };
                debug(
                  `${key} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                    `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
                );
              }
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            const tier = state.tier ?? current;
            const model = state.model ?? idOf(tier);
            debug(`${key} rewrite ${body.model} -> ${model}`);
            applyTier(body, tier, model);
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible.
            // `claude -p` omits metadata on the first request of a session, so there is no
            // session id to file the decision under and it would be dropped. The conversation
            // key is stable for the same conversation and is already what `debug` prints, so
            // it is the identifier a user can pass to `jev-explain` for a print-mode run.
            if (fresh && !explaining) {
              writeDecision(sessionOf(body) || key, {
                tier,
                ...fresh,
                ...(fresh.reason === "off" ? { off: true } : {}),
                at: Date.now(),
              });
            }
          }
          if (bedrockRequest) {
            // Move the model back where Bedrock expects it and strip it from the body,
            // which Bedrock rejects as an unknown field.
            outPath = bedrockPath(body.model, bedrockRequest.action);
            delete body.model;
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const target = new URL(resolvedUpstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      let headers;
      if (bedrock) {
        // Bedrock signs the exact bytes being sent, so this has to happen last, after the
        // body has been rewritten and re-serialized above. Only the two headers Bedrock
        // actually cares about survive; everything else (including whatever SigV4 Claude
        // Code itself computed) is replaced.
        const passthrough = {};
        if (req.headers["content-type"]) passthrough["content-type"] = req.headers["content-type"];
        if (req.headers["accept"]) passthrough["accept"] = req.headers["accept"];
        headers = await signRequest({
          region: bedrock.region,
          method: req.method,
          path: outPath,
          headers: passthrough,
          body: out,
          credentials: bedrock.credentials,
        });
      } else {
        headers = { ...req.headers, host: target.host };
        delete headers["content-length"];
        if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
          delete headers["accept-encoding"];
        }
        // Under JEV_DEBUG, ask for an uncompressed stream so the model the API reports can be
        // read back out of it. Not worth the bandwidth cost in normal operation.
        if (process.env.JEV_DEBUG) delete headers["accept-encoding"];
      }
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: bedrock ? outPath : `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels =
            !bedrock && req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const chunks = [];
            up.on("data", (chunk) => chunks.push(chunk));
            up.on("end", () => {
              const data = Buffer.concat(chunks);
              try {
                for (const model of JSON.parse(data.toString()).data ?? []) {
                  if (tierOf(model?.id)) catalog.set(model.id, model);
                }
              } catch (err) {
                debug(`could not read Claude model catalog: ${err.message}`);
              }
              const headers = { ...up.headers };
              delete headers["content-length"];
              res.writeHead(up.statusCode, headers);
              res.end(data);
            });
            return;
          }
          res.writeHead(up.statusCode, up.headers);
          // Report the model the API itself says it used, so the routing can be confirmed
          // from the wire rather than trusted from our own decision log. Claude Code's UI
          // always shows the model it asked for, never the one we rewrote to.
          if (process.env.JEV_DEBUG) {
            let seen = false;
            up.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${up.statusCode} served by ${m[1]}`);
            });
          }
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { port: server.address().port, close: () => server.close() };
}
