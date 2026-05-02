// E2E eval harness for the chat engine.
//
// What this is: a NODE process that exercises the same agentic loop
// the production chat route runs, but with TOOL CALLS STUBBED out
// per scenario. Real Anthropic API calls. Real system prompt builder.
// Real post-processing (banned narration, dedupe, etc.).
//
// What this catches that the existing evals miss:
//   - Whether the AI calls search_products at all (was the #1 demo
//     failure: AI ships pitch text without ever invoking a tool)
//   - Whether the AI's final text matches the products that were
//     actually returned (text-card mismatch)
//   - Multi-turn flows with chips/conditions/typos/pivots
//
// What it does NOT do (yet):
//   - Run real prisma queries (tools are stubbed)
//   - Render the actual product cards (we capture which products WOULD
//     render based on the agentic loop's output, not the full
//     render-layer filter pipeline)
//   - Replace the existing eval-scenarios.mjs (which is single-turn,
//     no tools, faster)
//
// USAGE
//   ANTHROPIC_API_KEY=... npm run eval:e2e
//   ANTHROPIC_API_KEY=... npm run eval:e2e -- --filter="flat feet"
//   ANTHROPIC_API_KEY=... npm run eval:e2e -- --verbose
//
// COST
//   Each scenario = 1 Sonnet call + up to 3 hops with tool stubs.
//   Roughly $0.01-0.05 per scenario. A full 10-scenario run is ~$0.30.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../app/lib/chat-prompt.server.js";
import { TOOLS } from "../app/lib/chat-tool-schemas.js";
import {
  stripBannedNarration,
  stripMetaNarration,
  dedupeConsecutiveSentences,
  looksLikeProductPitch,
  detectConditionOrOccasion,
} from "../app/lib/chat-helpers.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_PATH = path.join(__dirname, "e2e-scenarios.json");
const FIXTURES_DIR = path.join(__dirname, "e2e-fixtures");

const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(`--${n}=`.length);
const hasFlag = (n) => args.includes(`--${n}`);
const filterTerm = arg("filter")?.toLowerCase() || "";
const verbose = hasFlag("verbose");
const onlyHard = hasFlag("hard");
const onlySimple = hasFlag("simple");

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Missing ANTHROPIC_API_KEY. Run: ANTHROPIC_API_KEY=... npm run eval:e2e");
  process.exit(1);
}

const client = new Anthropic({ apiKey });
const MODEL = process.env.E2E_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const MAX_HOPS = 3;

// Load a knowledge fixture by name from scripts/e2e-fixtures/. Lets
// hard-mode scenarios reference shared knowledge content (e.g.
// 'aetrex' loads aetrex-style FAQs / rules / brand) without inlining
// kilobytes of text into the scenarios JSON.
const fixtureCache = new Map();
function loadKnowledgeFixture(name) {
  if (!name) return null;
  if (fixtureCache.has(name)) return fixtureCache.get(name);
  const file = path.join(FIXTURES_DIR, `knowledge-${name}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Missing knowledge fixture: ${file}`);
    process.exit(1);
  }
  const content = JSON.parse(fs.readFileSync(file, "utf-8"));
  fixtureCache.set(name, content);
  return content;
}

// Apply the same tool-result stubbing per scenario. A stub is a list of
// rules; the FIRST rule whose `if_query_matches` regex matches the
// tool input wins. Default rule (no `if_query_matches`) catches all.
function stubToolResult(toolName, input, scenarioStubs) {
  const stubs = (scenarioStubs && scenarioStubs[toolName]) || [];
  for (const s of stubs) {
    if (!s.if_query_matches) return s.return ?? {};
    const haystack = JSON.stringify(input || {});
    const re = new RegExp(s.if_query_matches, "i");
    if (re.test(haystack)) return s.return ?? {};
  }
  return { products: [], _stubbed: true, note: `No matching stub for ${toolName}` };
}

// Build a minimal config object for buildSystemPrompt. The scenario
// can override any field via scenario.merchantConfig.
function buildScenarioConfig(scenario) {
  const base = {
    assistantName: "Test Assistant",
    assistantTagline: "",
    assistantBrief: "",
    showFollowUps: false,
  };
  return { ...base, ...(scenario.merchantConfig?.config || {}) };
}

// Run one scenario through a real agentic loop with stubbed tools.
async function runScenario(scenario) {
  const messages = (scenario.history || []).map((m) => ({ role: m.role, content: String(m.content) }));
  for (const m of scenario.messages || []) messages.push({ role: "user", content: String(m) });

  const config = buildScenarioConfig(scenario);
  // Knowledge can be inline (scenario.merchantConfig.knowledge) or loaded
  // from a shared fixture (scenario.merchantConfig.knowledgeFixture: 'aetrex').
  // Hard-mode scenarios use the fixture to push prompt size near production scale.
  const inlineKnowledge = scenario.merchantConfig?.knowledge || [];
  const fixtureName = scenario.merchantConfig?.knowledgeFixture;
  const knowledge = fixtureName
    ? [...inlineKnowledge, ...(loadKnowledgeFixture(fixtureName) || [])]
    : inlineKnowledge;
  const systemPrompt = buildSystemPrompt({
    config,
    knowledge,
    shop: scenario.merchantConfig?.shop || "test.myshopify.com",
    attributeNames: scenario.merchantConfig?.attributeNames || [],
    categoryExclusions: [],
    querySynonyms: [],
    customerContext: null,
    fitPredictorEnabled: false,
    catalogProductTypes: scenario.merchantConfig?.catalogProductTypes || [],
    scopedGender: scenario.merchantConfig?.scopedGender || null,
    answeredChoices: scenario.merchantConfig?.answeredChoices || [],
    categoryGenderMap: scenario.merchantConfig?.categoryGenderMap || {},
    activeCampaigns: scenario.merchantConfig?.activeCampaigns || [],
  });

  const toolCalls = [];
  let allProducts = [];
  let finalText = "";

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools: TOOLS,
      });
    } catch (err) {
      return {
        ok: false,
        name: scenario.name,
        reasons: [`Anthropic error on hop ${hop}: ${err?.message || err}`],
        toolCalls,
      };
    }

    for (const block of response.content) {
      if (block.type === "text") finalText += (finalText ? "\n" : "") + block.text;
    }

    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const toolResults = toolUses.map((tu) => {
      const stubbed = stubToolResult(tu.name, tu.input, scenario.toolStubs);
      toolCalls.push({ name: tu.name, input: tu.input, stubbed });
      if (Array.isArray(stubbed.products)) {
        for (const p of stubbed.products) {
          if (!allProducts.find((x) => x.handle === p.handle)) allProducts.push(p);
        }
      }
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(stubbed),
      };
    });
    messages.push({ role: "user", content: toolResults });
  }

  // Apply production post-processing so assertions match what the
  // customer would actually see, not the raw model output.
  finalText = stripBannedNarration(finalText);
  finalText = stripMetaNarration(finalText);
  finalText = dedupeConsecutiveSentences(finalText);
  if (allProducts.length === 0 && looksLikeProductPitch(finalText)) finalText = "";
  if (!finalText) finalText = "I'm not finding a great match for that right now.";

  return checkAssertions(scenario, { finalText, toolCalls, products: allProducts });
}

// Assertion language. Each scenario.expect can include any of these.
function checkAssertions(scenario, result) {
  const expect = scenario.expect || {};
  const reasons = [];
  const lowerText = (result.finalText || "").toLowerCase();

  if (expect.must_call_tool) {
    if (!result.toolCalls.some((c) => c.name === expect.must_call_tool)) {
      reasons.push(`AI did not call ${expect.must_call_tool} (called: ${result.toolCalls.map((c) => c.name).join(", ") || "none"})`);
    }
  }
  if (expect.must_not_call_tool) {
    if (result.toolCalls.some((c) => c.name === expect.must_not_call_tool)) {
      reasons.push(`AI called ${expect.must_not_call_tool} but should not have`);
    }
  }
  for (const phrase of expect.text_must_contain || []) {
    if (!lowerText.includes(String(phrase).toLowerCase())) {
      reasons.push(`text missing required phrase: "${phrase}"`);
    }
  }
  for (const phrase of expect.text_must_not_contain || []) {
    if (lowerText.includes(String(phrase).toLowerCase())) {
      reasons.push(`text contains forbidden phrase: "${phrase}"`);
    }
  }
  if (expect.tool_query_matches && expect.must_call_tool) {
    const call = result.toolCalls.find((c) => c.name === expect.must_call_tool);
    if (call) {
      const re = new RegExp(expect.tool_query_matches, "i");
      const queryStr = JSON.stringify(call.input || {});
      if (!re.test(queryStr)) {
        reasons.push(`${expect.must_call_tool} input did not match /${expect.tool_query_matches}/i (was: ${queryStr.slice(0, 200)})`);
      }
    }
  }
  if (expect.products_must_include_handle) {
    const wanted = String(expect.products_must_include_handle).toLowerCase();
    if (!result.products.some((p) => String(p.handle || "").toLowerCase() === wanted)) {
      reasons.push(`expected product handle "${wanted}" not in returned products`);
    }
  }
  if (expect.products_must_not_include_handle) {
    const banned = String(expect.products_must_not_include_handle).toLowerCase();
    if (result.products.some((p) => String(p.handle || "").toLowerCase() === banned)) {
      reasons.push(`forbidden product handle "${banned}" appeared in returned products`);
    }
  }

  return {
    ok: reasons.length === 0,
    name: scenario.name,
    reasons,
    finalText: result.finalText,
    toolCalls: result.toolCalls,
    products: result.products,
  };
}

// ── Main ───────────────────────────────────────────────────────
const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf-8"));
let filtered = scenarios;
if (filterTerm) filtered = filtered.filter((s) => s.name.toLowerCase().includes(filterTerm));
if (onlyHard) filtered = filtered.filter((s) => s._mode === "hard");
if (onlySimple) filtered = filtered.filter((s) => s._mode !== "hard");

if (filtered.length === 0) {
  console.error(`No scenarios match the active filters (filter="${filterTerm}" hard=${onlyHard} simple=${onlySimple})`);
  process.exit(1);
}

console.log(`Running ${filtered.length} E2E scenario(s) against ${MODEL}…\n`);

let passed = 0;
let failed = 0;
const failures = [];

for (const scenario of filtered) {
  process.stdout.write(`  ${scenario.name} … `);
  const result = await runScenario(scenario);
  if (result.ok) {
    passed++;
    process.stdout.write("✓\n");
  } else {
    failed++;
    failures.push(result);
    process.stdout.write("✗\n");
    for (const r of result.reasons || []) console.log(`      → ${r}`);
  }
  if (verbose) {
    console.log(`      tools called: ${result.toolCalls?.map((c) => `${c.name}(${JSON.stringify(c.input).slice(0, 80)})`).join(", ") || "none"}`);
    console.log(`      text: "${(result.finalText || "").slice(0, 200)}"`);
  }
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  • ${f.name}`);
    for (const r of f.reasons) console.log(`      ${r}`);
  }
  process.exit(1);
}
