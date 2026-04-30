// Live-LLM scenario harness. Fires real Anthropic API calls against
// the same system prompt the production chat handler uses, with a
// representative merchant config (Aetrex). Captures responses, runs
// assertions, prints a hit-rate.
//
// USAGE
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/eval-scenarios.mjs
//   # or run a single scenario:
//   ANTHROPIC_API_KEY=... node scripts/eval-scenarios.mjs --filter "soccer"
//
// EXIT CODES
//   0 = pass-rate >= threshold (default 90%)
//   1 = below threshold or error
//
// NOTE
//   This skips actual tool calls — it tests TEXT-LEVEL behavior only.
//   Tool-driven flows (search filters, card narrowing) are covered by
//   the deterministic evals (eval-chat-quality, eval-category-intent).
//   This harness is for the LLM-compliance long tail: banned phrases,
//   rule following, gender locking, condition routing, etc.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../app/lib/chat-prompt.server.js";
import { extractAnsweredChoices } from "../app/lib/conversation-memory.server.js";
import {
  detectGenderFromHistory,
  stripBannedNarration,
  stripMetaNarration,
  dedupeConsecutiveSentences,
} from "../app/lib/chat-helpers.server.js";
import {
  filterForbiddenCategoryChips,
  filterContradictingGenderChips,
} from "../app/lib/chip-filter.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argFlag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const SCENARIOS_PATH = argFlag("file")
  ? path.resolve(process.cwd(), argFlag("file"))
  : path.join(__dirname, "scenarios.json");
const MODEL = process.env.SCENARIO_MODEL || "claude-haiku-4-5-20251001";
const THRESHOLD = Number(process.env.SCENARIO_THRESHOLD || 0.9);
const MAX_TOKENS = 600;
const CONCURRENCY = Number(process.env.SCENARIO_CONCURRENCY || 4);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set — skipping live scenario eval.");
  console.error("Set the env var to run the live LLM eval. See scripts/eval-scenarios.mjs header.");
  process.exit(0);
}

// Representative Aetrex merchant config so the system prompt has the
// real catalog vocabulary and rules. Lifted from the user's installed
// rules + brand + FAQ files.
const SHOP = "aetrex.example.com";
const config = {
  assistantName: "The Fit Concierge",
  assistantTagline: "",
  embeddingProvider: "",
};

const knowledge = [
  {
    fileType: "rules",
    content: fs.readFileSync(path.join(__dirname, "fixtures/rules.txt"), "utf-8"),
  },
  {
    fileType: "brand",
    content: fs.readFileSync(path.join(__dirname, "fixtures/brand.txt"), "utf-8"),
  },
  {
    fileType: "faqs",
    content: fs.readFileSync(path.join(__dirname, "fixtures/faqs.txt"), "utf-8"),
  },
];

const catalogProductTypes = [
  "Sandals", "Sneakers", "Boots", "Slippers", "Clogs", "Loafers",
  "Mary Janes", "Slip Ons", "Wedges Heels", "Oxfords", "Orthotics",
  "Accessories", "Footwear", "Socks", "Gift Card",
];

const attributeNames = ["gender", "color", "category", "footbed"];

// Aetrex-shape category-gender map. Mirrors what
// getCategoryGenderAvailability() returns from the live catalog.
// Used so the eval's chip-filter step matches production behavior.
const AETREX_CATEGORY_GENDER_MAP = {
  boots:        { display: "Boots",        genders: ["women"] },
  loafers:      { display: "Loafers",      genders: ["women"] },
  oxfords:      { display: "Oxfords",      genders: ["women"] },
  slippers:     { display: "Slippers",     genders: ["women"] },
  "slip ons":   { display: "Slip Ons",     genders: ["women"] },
  "mary janes": { display: "Mary Janes",   genders: ["women"] },
  "wedges heels": { display: "Wedges Heels", genders: ["women"] },
  cleats:       { display: "Cleats",       genders: ["unisex"] },
  sandals:      { display: "Sandals",      genders: ["men", "women"] },
  sneakers:     { display: "Sneakers",     genders: ["men", "women"] },
  clogs:        { display: "Clogs",        genders: ["men", "women"] },
  footwear:     { display: "Footwear",     genders: ["men", "women"] },
  orthotics:    { display: "Orthotics",    genders: ["men", "women", "unisex"] },
  accessories:  { display: "Accessories",  genders: ["women", "unisex"] },
  socks:        { display: "Socks",        genders: ["women", "unisex"] },
};

// What the chip filter sees as "allowed" when no specific gender
// scope applies (mirrors the gender=any catalog scoping). For
// gender-specific scenarios the filter would receive the narrowed
// list — we use the full list here so the eval doesn't over-strip.
const AETREX_GENDER_SCOPED_CATEGORIES = catalogProductTypes;
const AETREX_FULL_CATEGORIES = catalogProductTypes;

const args = process.argv.slice(2);
const filterIdx = args.indexOf("--filter");
const filterTerm = filterIdx >= 0 ? args[filterIdx + 1].toLowerCase() : null;

const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf-8"));
const filtered = filterTerm
  ? scenarios.filter((s) => s.name.toLowerCase().includes(filterTerm))
  : scenarios;

if (filtered.length === 0) {
  console.error(`No scenarios match filter "${filterTerm}"`);
  process.exit(1);
}

const client = new Anthropic({ apiKey });

function buildMessages(scenario) {
  // Scenarios may include explicit "history" plus a final "messages"
  // list (the new-this-turn user input). Concatenate to form the
  // conversation history that gets sent to Anthropic.
  const turns = [];
  for (const t of scenario.history || []) {
    if (t?.role === "user" || t?.role === "assistant") {
      turns.push({ role: t.role, content: String(t.content) });
    }
  }
  for (const m of scenario.messages || []) {
    turns.push({ role: "user", content: String(m) });
  }
  return turns;
}

async function runScenario(scenario) {
  const messages = buildMessages(scenario);
  if (messages.length === 0) {
    return { name: scenario.name, ok: false, reasons: ["no messages"] };
  }

  // Detect gender + answered choices the same way the real handler does.
  const sessionGender = detectGenderFromHistory(messages);
  const answeredChoices = extractAnsweredChoices(messages);
  if (sessionGender && !answeredChoices.some((c) =>
    /\b(men|women|gender|him|her|man|woman)\b/i.test(c.question || "") ||
    /\b(men|women|men's|women's)\b/i.test(c.answer || "")
  )) {
    answeredChoices.unshift({
      question: "Are these for men's or women's?",
      answer: sessionGender === "men" ? "Men's" : "Women's",
      rawAnswer: sessionGender === "men" ? "Men's" : "Women's",
      options: ["Men's", "Women's"],
    });
  }

  const system = buildSystemPrompt({
    config,
    knowledge,
    shop: SHOP,
    attributeNames,
    categoryExclusions: [],
    querySynonyms: [],
    customerContext: null,
    fitPredictorEnabled: false,
    catalogProductTypes,
    scopedGender: sessionGender,
    answeredChoices,
  });

  let text;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    });
    text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } catch (err) {
    return { name: scenario.name, ok: false, reasons: [`API error: ${err?.message || err}`] };
  }

  // Mirror the production text-cleanup pipeline so the eval measures
  // what the customer actually sees, not the raw LLM stream. Without
  // this, we'd flag banned narration that the server already strips.
  text = text
    // Anthropic SDK occasionally leaks tool-call XML into text blocks
    // when no tools are registered (the eval doesn't run tools).
    // Strip those wrappers so they don't pollute assertions.
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
    .replace(/<invoke[\s\S]*?<\/invoke>/g, "")
    .replace(/<parameter[\s\S]*?<\/parameter>/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  text = stripBannedNarration(text);
  text = stripMetaNarration(text);
  text = dedupeConsecutiveSentences(text);

  // Apply the production chip filters so the eval matches what
  // customers actually see (not the raw LLM output).
  // - filterForbiddenCategoryChips: strips category chips not in the
  //   gender-scoped allow-list.
  // - filterContradictingGenderChips: strips gender chips that
  //   contradict the user's mentioned category (Men's when user asked
  //   for boots, since boots are women-only at Aetrex).
  const conversationText = (scenario.history || [])
    .concat((scenario.messages || []).map((c) => ({ role: "user", content: c })))
    .filter((m) => m && typeof m.content === "string")
    .map((m) => m.content)
    .join(" ");
  const fbcc = filterForbiddenCategoryChips(text, AETREX_GENDER_SCOPED_CATEGORIES, AETREX_FULL_CATEGORIES);
  text = fbcc.text;
  const fcgc = filterContradictingGenderChips(text, conversationText, AETREX_CATEGORY_GENDER_MAP);
  text = fcgc.text;

  const checked = checkExpectations(scenario, text);
  if (scenario._source?.isFeedback) {
    checked.isFeedback = true;
    checked.previousResponse = scenario._source.previousResponse || "";
    checked.userQuestion = scenario.messages?.[0] || "";
  } else if (scenario._source?.previousResponse) {
    checked.previousResponse = scenario._source.previousResponse;
  }
  return checked;
}

function checkExpectations(scenario, text) {
  const e = scenario.expect || {};
  const reasons = [];
  const lower = (text || "").toLowerCase();

  for (const phrase of e.mustContain || []) {
    if (!lower.includes(String(phrase).toLowerCase())) {
      reasons.push(`mustContain "${phrase}" missing`);
    }
  }

  for (const phrase of e.mustNotContain || []) {
    if (lower.includes(String(phrase).toLowerCase())) {
      reasons.push(`mustNotContain "${phrase}" present`);
    }
  }

  for (const key of ["mustNotMatch", "mustNotMatch2"]) {
    if (e[key]) {
      const re = new RegExp(e[key], "i");
      if (re.test(text)) reasons.push(`${key} /${e[key]}/ matched`);
    }
  }

  if (Array.isArray(e.shouldMentionAny) && e.shouldMentionAny.length > 0) {
    const hit = e.shouldMentionAny.some((p) => lower.includes(String(p).toLowerCase()));
    if (!hit) reasons.push(`shouldMentionAny none matched: ${e.shouldMentionAny.join(", ")}`);
  }

  if (Array.isArray(e.shouldAskAbout) && e.shouldAskAbout.length > 0) {
    const hit = e.shouldAskAbout.some((p) => lower.includes(String(p).toLowerCase()));
    if (!hit) reasons.push(`shouldAskAbout none matched: ${e.shouldAskAbout.join(", ")}`);
  }

  if (Number.isFinite(e.maxSentences)) {
    const sentences = text.split(/[.!?]+\s+/).filter((s) => s.trim().length > 0).length;
    if (sentences > e.maxSentences) {
      reasons.push(`maxSentences=${e.maxSentences}, got ${sentences}`);
    }
  }

  return { name: scenario.name, ok: reasons.length === 0, reasons, text };
}

async function runAll() {
  const results = [];
  // Limited concurrency so we don't hammer the Anthropic API.
  const queue = [...filtered];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const s = queue.shift();
      const r = await runScenario(s);
      results.push(r);
      const tag = r.ok ? "✓" : "✗";
      const detail = r.ok ? "" : `  · ${r.reasons.join("; ")}`;
      console.log(`${tag} ${r.name}${detail}`);
    }
  });
  await Promise.all(workers);

  const pass = results.filter((r) => r.ok).length;
  const total = results.length;
  const rate = total > 0 ? pass / total : 0;
  console.log("");
  console.log(`scenario eval: ${pass}/${total} passed (${(rate * 100).toFixed(1)}%)`);
  console.log(`threshold: ${(THRESHOLD * 100).toFixed(0)}%`);

  // Feedback scenarios are regression tests — passing the baseline
  // safety check (no banned phrases, no Lynco, etc.) doesn't prove
  // the customer's original concern is resolved. Print the customer
  // question, what the AI said when it got 👎, and what the AI says
  // now so the operator can judge whether the response improved.
  const feedbackResults = results.filter((r) => r.isFeedback);
  if (feedbackResults.length > 0) {
    const truncate = (s, n) => (s || "").length > n ? s.slice(0, n) + "…" : (s || "");
    console.log("");
    console.log("─".repeat(70));
    console.log(`FEEDBACK REVIEW — ${feedbackResults.length} scenario(s) imported from real 👎 events`);
    console.log("Baseline pass = no banned phrases. To verify the issue is FIXED, read both responses below:");
    console.log("─".repeat(70));
    for (const r of feedbackResults) {
      console.log("");
      console.log(`▸ ${r.name}`);
      console.log(`  CUSTOMER ASKED:  ${truncate(r.userQuestion, 220).replace(/\n/g, " ")}`);
      const oldResp = r.previousResponse
        ? truncate(r.previousResponse, 260).replace(/\n/g, " ")
        : "(not captured by the widget at the time)";
      console.log(`  WHEN RATED 👎:   ${oldResp}`);
      console.log(`  RESPONSE NOW:    ${truncate(r.text, 260).replace(/\n/g, " ")}`);
      if (!r.ok) {
        console.log(`  ⚠ BASELINE FAILED: ${r.reasons.join("; ")}`);
      }
    }
    console.log("");
    console.log("─".repeat(70));
    console.log("If RESPONSE NOW reads better than WHEN RATED 👎 → issue likely fixed.");
    console.log("If they read the same (or worse) → the bug is NOT resolved.");
    console.log("If WHEN RATED 👎 says (not captured), compare to the customer's question only.");
    console.log("─".repeat(70));
  }

  if (rate < THRESHOLD) {
    console.log("");
    console.log("FAILED scenarios:");
    for (const r of results) {
      if (!r.ok) {
        console.log(`  - ${r.name}`);
        for (const reason of r.reasons) console.log(`      ${reason}`);
        if (r.text) {
          const trimmed = r.text.length > 200 ? r.text.slice(0, 200) + "…" : r.text;
          console.log(`      RESPONSE NOW: ${trimmed.replace(/\n/g, " ")}`);
        }
        if (r.previousResponse) {
          console.log(`      RESPONSE WHEN RATED DOWN: ${r.previousResponse.replace(/\n/g, " ")}`);
        }
      }
    }
    process.exit(1);
  }
}

runAll().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
