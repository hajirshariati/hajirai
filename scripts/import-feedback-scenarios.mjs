// Import chat-feedback records (👍 / 👎 votes from the widget) and
// convert them into scenarios for the eval suite. Each thumbs-down is
// effectively a regression test — the AI response that frustrated the
// customer should not happen again. Thumbs-up are positive lock-ins.
//
// USAGE
//   node scripts/import-feedback-scenarios.mjs                    # last 30 days, all shops, downvotes only
//   node scripts/import-feedback-scenarios.mjs --shop=foo.myshopify.com
//   node scripts/import-feedback-scenarios.mjs --days=7 --limit=50
//   node scripts/import-feedback-scenarios.mjs --vote=all          # imports both up and down
//
// OUTPUT
//   scripts/scenarios.from-feedback.json — review, refine expectations
//   then run with:
//     npm run eval:feedback

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "scenarios.from-feedback.json");

const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const hasFlag = (name) => args.includes(`--${name}`);
const shopArg = arg("shop");
const limitArg = Number(arg("limit")) || 100;
const sinceDays = Number(arg("days")) || 30;
const voteFilter = arg("vote") || "down";
const noDedupe = hasFlag("no-dedupe");

// Import prisma after parsing args so the script can boot even if
// the DB env isn't set up — useful for dry-run / --help.
const { default: prisma } = await import("../app/db.server.js");

const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

// Two-pass count so we can show the user what we found vs what we
// actually imported. The "with conversation" filter is what the eval
// harness needs (history + trigger), but we want to surface the
// difference if the widget didn't capture conversation on some turns.
const totalInRange = await prisma.chatFeedback.count({
  where: {
    createdAt: { gte: since },
    ...(voteFilter !== "all" ? { vote: voteFilter } : {}),
    ...(shopArg ? { shop: shopArg } : {}),
  },
});
const withConversation = await prisma.chatFeedback.count({
  where: {
    createdAt: { gte: since },
    conversation: { not: null },
    ...(voteFilter !== "all" ? { vote: voteFilter } : {}),
    ...(shopArg ? { shop: shopArg } : {}),
  },
});

const where = { createdAt: { gte: since }, conversation: { not: null } };
if (voteFilter !== "all") where.vote = voteFilter;
if (shopArg) where.shop = shopArg;

const records = await prisma.chatFeedback.findMany({
  where,
  orderBy: { createdAt: "desc" },
  take: limitArg,
  select: {
    id: true,
    shop: true,
    vote: true,
    botResponse: true,
    conversation: true,
    products: true,
    createdAt: true,
  },
});

// Baseline expectations applied to every imported scenario. These
// catch the most common AI failure modes regardless of the specific
// customer ask. Refine per-scenario in the JSON file as needed.
const BASELINE_EXPECT = {
  mustNotContain: [
    "Lynco",
    "trust me",
    "you'll love",
    "perfect for you",
    "I guarantee",
    "100%",
    "the customer",
    "the user",
  ],
  mustNotMatch: "(let me look|i'?ll find|one moment|hold on|right away|we know\\s*:|since (the customer|you('ve)? established))",
};

const scenarios = [];
let skippedNoConv = 0;
let skippedNoUserMsg = 0;

for (const r of records) {
  let conv;
  try { conv = JSON.parse(r.conversation); } catch { skippedNoConv++; continue; }
  if (!Array.isArray(conv) || conv.length === 0) { skippedNoConv++; continue; }

  // The last user message in the stored conversation is the trigger.
  // Everything before it becomes the scenario's history.
  let lastUserIndex = -1;
  for (let i = conv.length - 1; i >= 0; i--) {
    if (conv[i]?.role === "user" && typeof conv[i].content === "string") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) { skippedNoUserMsg++; continue; }

  const history = conv.slice(0, lastUserIndex)
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: String(m.content) }));

  const triggerMessage = String(conv[lastUserIndex].content).trim();
  if (!triggerMessage) { skippedNoUserMsg++; continue; }

  const voteIcon = r.vote === "up" ? "thumbs-up" : "thumbs-down";
  const titleSnippet = triggerMessage.slice(0, 50) + (triggerMessage.length > 50 ? "…" : "");

  scenarios.push({
    name: `feedback ${voteIcon} ${r.id.slice(0, 8)}: ${titleSnippet}`,
    _source: {
      feedbackId: r.id,
      vote: r.vote,
      voteAt: r.createdAt.toISOString(),
      shop: r.shop,
      previousResponse: (r.botResponse || "").slice(0, 200),
    },
    ...(history.length > 0 ? { history } : {}),
    messages: [triggerMessage],
    expect: { ...BASELINE_EXPECT },
  });
}

// Dedupe by exact (history, trigger) match. Same customer asking the
// same thing twice → one scenario by default. Pass --no-dedupe to
// keep every record (useful when you want to see all 👎 events).
let unique = scenarios;
let dedupedCount = 0;
if (!noDedupe) {
  const seen = new Set();
  const out = [];
  for (const s of scenarios) {
    const key = JSON.stringify({ h: s.history || [], m: s.messages });
    if (seen.has(key)) { dedupedCount++; continue; }
    seen.add(key);
    out.push(s);
  }
  unique = out;
}

fs.writeFileSync(OUT_PATH, JSON.stringify(unique, null, 2) + "\n");

const up = unique.filter((s) => s._source.vote === "up").length;
const down = unique.filter((s) => s._source.vote === "down").length;

console.log(``);
console.log(`Feedback import summary (last ${sinceDays} days, vote=${voteFilter}${shopArg ? `, shop=${shopArg}` : ""}):`);
console.log(`  Total feedback records:     ${totalInRange}`);
console.log(`  With conversation captured: ${withConversation}`);
if (totalInRange > withConversation) {
  console.log(`    ⚠ ${totalInRange - withConversation} record(s) had no conversation field — widget may not be capturing the conversation on those events.`);
}
if (skippedNoConv > 0) console.log(`  Skipped (parse error):      ${skippedNoConv}`);
if (skippedNoUserMsg > 0) console.log(`  Skipped (no user message):  ${skippedNoUserMsg}`);
if (!noDedupe && dedupedCount > 0) {
  console.log(`  Deduped (same trigger):     ${dedupedCount}  (use --no-dedupe to keep duplicates)`);
}
console.log(`  Imported scenarios:         ${unique.length}  (👍 ${up} / 👎 ${down})`);
console.log(``);
console.log(`File: ${path.relative(process.cwd(), OUT_PATH)}`);
console.log(``);
console.log(`Next steps:`);
console.log(`  1. Open the file and review each scenario's _source.previousResponse`);
console.log(`     to see what the AI said when it got rated down.`);
console.log(`  2. Add scenario-specific expectations (mustMentionAny, etc.) where`);
console.log(`     a baseline pass isn't strict enough.`);
console.log(`  3. Run:`);
console.log(`       ANTHROPIC_API_KEY=... npm run eval:feedback`);
console.log(``);

await prisma.$disconnect();
