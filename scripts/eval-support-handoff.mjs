// Support-handoff safety layer — when the bot genuinely can't finish, hand off
// to customer service instead of dead-ending; never on a successful turn.
//
// Run: node scripts/eval-support-handoff.mjs

import assert from "node:assert/strict";
import {
  detectSupportHandoffNeed,
  buildSupportHandoffText,
  supportConfigured,
  normalizedSupportLabel,
  supportChatLabel,
  handoffMetaTextLeak,
  isAccountSupportHandoffRequest,
  buildAccountSupportHandoffText,
  applyAnswerSourceContract,
  stripHandoffMetaText,
  isDeadEndAnswer,
} from "../app/lib/support-handoff.js";
import { planTurn, WORKFLOWS } from "../app/lib/turn-plan.server.js";

// Mirror of the widget's openSupportChat provider priority (Zendesk > Intercom >
// Gorgias > fallback URL). Kept here as the documented contract — the widget IIFE
// can't be imported, so this locks the decision the widget must implement.
function pickSupportTarget({ hasZendesk = false, hasIntercom = false, hasGorgias = false, fallbackUrl = "" } = {}) {
  if (hasZendesk) return "zendesk";
  if (hasIntercom) return "intercom";
  if (hasGorgias) return "gorgias";
  if (fallbackUrl) return { url: fallbackUrl };
  return null;
}

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name} — ${err.message}`); fails.push({ name, err }); fail++; }
}

const ctxOf = (workflow, msg, extra = {}) => ({
  latestUserMessage: msg,
  turnPlan: { workflow },
  supportUrl: "https://aetrex.example/support",
  supportLabel: "Visit Support Hub",
  ...extra,
});
const CARD = { title: "Savannah Adjustable Quarter Strap Sandal - Champagne" };

// ── 1. Explicit human/support request → hard, drop cards ──────────────
check("'I want to talk to customer service' → hard explicit_human_request", () => {
  const h = detectSupportHandoffNeed({ text: "Sure!", ctx: ctxOf("clarification", "I want to talk to customer service"), pool: [CARD] });
  assert.equal(h.mode, "hard");
  assert.equal(h.reason, "explicit_human_request");
});
check("'can I speak to a human' / 'connect me to customer service' → hard", () => {
  for (const m of ["can I speak to a human?", "connect me to customer service", "I want to contact support"]) {
    assert.equal(detectSupportHandoffNeed({ ctx: ctxOf("browse", m), pool: [] }).mode, "hard", m);
  }
});

// ── 1c. Repeated frustration → hard repeated_frustration ──────────────
check("frustrated + escalated → hard repeated_frustration", () => {
  for (const m of ["are you stupid?", "you're not listening", "I already told you", "this is so annoying", "stop asking"]) {
    const h = detectSupportHandoffNeed({ ctx: ctxOf("condition_recommendation", m), pool: [], frustrationEscalated: true });
    assert.equal(h.mode, "hard", m);
    assert.equal(h.reason, "repeated_frustration", m);
  }
});
check("frustration on the FIRST occurrence (not escalated) does NOT hand off", () => {
  const h = detectSupportHandoffNeed({ ctx: ctxOf("clarification", "this is annoying"), pool: [], frustrationEscalated: false });
  assert.equal(h.mode, null);
});
check("explicit human request still wins over the frustration path", () => {
  const h = detectSupportHandoffNeed({ ctx: ctxOf("browse", "this is annoying, get me a human"), pool: [], frustrationEscalated: true });
  assert.equal(h.reason, "explicit_human_request");
});

// ── 2. Unknown policy → hard policy_no_answer ─────────────────────────
check("unknown policy ('I don't have access') → hard policy_no_answer", () => {
  const h = detectSupportHandoffNeed({
    text: "I don't have access to that information.",
    ctx: ctxOf("policy_account", "Can I use three promo codes with my insurance reimbursement?"),
    pool: [],
  });
  assert.equal(h.mode, "hard");
  assert.equal(h.reason, "policy_no_answer");
});

// ── 3. Failed product/data answer, no cards → hard dead_end ───────────
check("dead-end text + no cards → hard dead_end_no_answer", () => {
  const h = detectSupportHandoffNeed({
    text: "I don't have access to that information.",
    ctx: ctxOf("named_product_advisory", "is the Xyz any good?"),
    pool: [],
  });
  assert.equal(h.mode, "hard");
  assert.equal(h.reason, "dead_end_no_answer");
});

// ── 4. Partial availability (width not tracked) → soft, keep card ─────
check("partial availability (width not listed) + card → soft, keep card", () => {
  const text = "I can find the Savannah in Champagne in size 7, but I don't see Wide listed as a separate width option in the data.";
  const h = detectSupportHandoffNeed({ text, ctx: ctxOf("availability", "Do you have Savannah in champagne size 7 wide?"), pool: [CARD] });
  assert.equal(h.mode, "soft");
  assert.equal(h.reason, "partial_availability");
});
check("UNKNOWN availability ('can't verify size … open the product page') + card → soft", () => {
  const text = "I can find the Lina in Navy, but I can't verify size 7 from the data I have here. Open the product page to confirm current size availability.";
  assert.equal(detectSupportHandoffNeed({ text, ctx: ctxOf("availability", "do you have the Lina in a 7?"), pool: [CARD] }).mode, "soft");
});

// ── 5/6/7. Successful / clarification turns → NO handoff ──────────────
check("generic sizing clarification → no handoff", () => {
  const h = detectSupportHandoffNeed({ text: "Which product are you sizing for, and what's your usual size?", ctx: ctxOf("sizing_help", "I need help choosing the right size"), pool: [] });
  assert.equal(h.mode, null);
});
check("successful sale_browse → no handoff", () => {
  assert.equal(detectSupportHandoffNeed({ text: "Here are some sandals on sale right now.", ctx: ctxOf("sale_browse", "Show me current sales and promotions"), pool: [CARD, CARD] }).mode, null);
});
check("successful comparison → no handoff", () => {
  assert.equal(detectSupportHandoffNeed({ text: "Pick Savannah for all-day walking — more supportive. Choose Jillian for style.", ctx: ctxOf("comparison", "Which is better, Jillian or Savannah?"), pool: [CARD, CARD] }).mode, null);
});
check("successful exact availability (AVAILABLE) → no handoff", () => {
  assert.equal(detectSupportHandoffNeed({ text: "Yes — the Jillian is available in Black, size 8.", ctx: ctxOf("availability", "Jillian black size 8?"), pool: [CARD] }).mode, null);
});
check("successful condition recommendation → no handoff", () => {
  assert.equal(detectSupportHandoffNeed({ text: "For plantar fasciitis, these have great arch support.", ctx: ctxOf("condition_recommendation", "what helps plantar fasciitis?"), pool: [CARD, CARD] }).mode, null);
});

// ── 8. Validation failure → hard validation_failed ───────────────────
check("validator ok=false → hard validation_failed (even on an answer workflow)", () => {
  const h = detectSupportHandoffNeed({ text: "some uncertain draft", ctx: ctxOf("named_product_advisory", "is the Reagan worth it?"), pool: [], validation: { ok: false } });
  assert.equal(h.mode, "hard");
  assert.equal(h.reason, "validation_failed");
});
check("qualitySignals.supportHandoffReason=validation_failed → hard", () => {
  assert.equal(detectSupportHandoffNeed({ text: "x", ctx: ctxOf("comparison", "a vs b"), pool: [CARD], qualitySignals: { supportHandoffReason: "validation_failed" } }).mode, "hard");
});

// ── text builder + CTA config ─────────────────────────────────────────
check("hard text is a clean handoff, names customer service, no button word", () => {
  const t = buildSupportHandoffText({ ctx: ctxOf("policy_account", "x"), reason: "dead_end_no_answer", partial: false });
  assert.match(t, /Aetrex customer service/);
  assert.doesNotMatch(t, /\bhttps?:\/\//);
});
check("soft partial text mentions exact fit/width confirmation", () => {
  const t = buildSupportHandoffText({ ctx: ctxOf("availability", "x"), reason: "partial_availability", partial: true });
  assert.match(t, /Aetrex customer service/);
  assert.match(t, /fit or width/i);
});
check("supportConfigured: blank url → false (no fake CTA), real url → true", () => {
  assert.equal(supportConfigured({ supportUrl: "" }), false);
  assert.equal(supportConfigured({ supportUrl: "   " }), false);
  assert.equal(supportConfigured({ supportUrl: "https://x/support" }), true);
});
check("normalizedSupportLabel: custom honored, legacy/blank → 'Visit Support Hub'", () => {
  assert.equal(normalizedSupportLabel({ supportLabel: "Chat with us" }), "Chat with us");
  assert.equal(normalizedSupportLabel({ supportLabel: "Contact customer service" }), "Visit Support Hub");
  assert.equal(normalizedSupportLabel({}), "Visit Support Hub");
});
check("blank supportUrl → text still names customer service (no button implied)", () => {
  const t = buildSupportHandoffText({ ctx: { supportUrl: "" }, reason: "validation_failed", partial: false });
  assert.match(t, /Aetrex customer service/);
});

// ── live-chat button label + provider priority (widget contract) ──────
check("supportChatLabel: link-style defaults → 'Chat with Aetrex Support'", () => {
  assert.equal(supportChatLabel({ supportLabel: "Visit Support Hub" }), "Chat with Aetrex Support");
  assert.equal(supportChatLabel({ supportLabel: "Contact customer service" }), "Chat with Aetrex Support");
  assert.equal(supportChatLabel({}), "Chat with Aetrex Support");
});
check("supportChatLabel: a meaningful custom label is honored", () => {
  assert.equal(supportChatLabel({ supportLabel: "Message our team" }), "Message our team");
});
check("widget openSupportChat priority: Zendesk wins when present", () => {
  assert.equal(pickSupportTarget({ hasZendesk: true, fallbackUrl: "https://x/support" }), "zendesk");
  assert.equal(pickSupportTarget({ hasZendesk: true, hasIntercom: true, hasGorgias: true }), "zendesk");
});
check("widget openSupportChat priority: Intercom/Gorgias before URL", () => {
  assert.equal(pickSupportTarget({ hasIntercom: true, fallbackUrl: "https://x/support" }), "intercom");
  assert.equal(pickSupportTarget({ hasGorgias: true, fallbackUrl: "https://x/support" }), "gorgias");
});
check("widget openSupportChat: falls back to URL only when no provider exists", () => {
  assert.deepEqual(pickSupportTarget({ fallbackUrl: "https://x/support" }), { url: "https://x/support" });
  assert.equal(pickSupportTarget({}), null);
});

// ── 2026-07: ANSWER-SOURCE CONTRACT (RAG-first knowledge, handoff for private) ─
// Bug: a teacher-verification question force-handed-off and discarded the RAG
// answer; and a draft could ship "[Support Hub button is available above]". The
// contract now answers KNOWLEDGE turns from RAG (meta stripped) and reserves the
// support handoff for PRIVATE account/order turns or when no knowledge answers.

// Customer-visible text must never carry brackets / button words / UI directions.
function assertCleanHandoffText(t, label) {
  assert.doesNotMatch(t, /[\[\]]/, `${label}: no brackets in "${t}"`);
  assert.doesNotMatch(t, /\bbutton\b/i, `${label}: no "button" in "${t}"`);
  assert.doesNotMatch(t, /\bavailable\s+(?:above|below)\b/i, `${label}: no "available above/below" in "${t}"`);
  assert.doesNotMatch(t, /\b(?:click|use|tap|press|hit)\s+the\s+(?:button|link)\b/i, `${label}: no UI instruction in "${t}"`);
  assert.doesNotMatch(t, /\b(?:button|link|cta)\s+(?:above|below)\b/i, `${label}: no "button above/below" in "${t}"`);
}

check("handoffMetaTextLeak: flags the exact PRD leak + the whole banned list", () => {
  for (const t of [
    "Our team is happy to help with account verification questions. [Support Hub button is available above]",
    "The Support Hub button is available above.",
    "Click the button below to chat.",
    "Use the button above to reach support.",
    "[button] to continue",
    "See the link above for details.",
    "The chat button is available above to talk to us.",
  ]) {
    assert.equal(handoffMetaTextLeak(t), true, `should flag: "${t}"`);
  }
  for (const t of [
    "To verify as a teacher you upload your school ID through SheerID at checkout.",
    "Our return policy is 30 days from delivery.",
    "I can help you find supportive sandals.",
  ]) {
    assert.equal(handoffMetaTextLeak(t), false, `should NOT flag: "${t}"`);
  }
});

check("stripHandoffMetaText: removes UI meta but KEEPS the real answer", () => {
  const r = stripHandoffMetaText("Teacher discounts are verified via SheerID at checkout. [Support Hub button is available above]");
  assert.match(r, /verified via SheerID/i);
  assertCleanHandoffText(r, "stripped");
  // A pure-meta reply strips down to (near) nothing → treated as no-answer.
  assert.equal(isDeadEndAnswer(stripHandoffMetaText("[Support Hub button is available above]")), true);
});

check("isDeadEndAnswer: 'I don't have that' true; a real answer false", () => {
  assert.equal(isDeadEndAnswer("I don't have that specific detail in my notes."), true);
  assert.equal(isDeadEndAnswer("I can't find that information."), true);
  assert.equal(isDeadEndAnswer(""), true);
  assert.equal(isDeadEndAnswer("Teacher discounts are verified via SheerID at checkout; just upload your school ID."), false);
});

const SUPPORT_CTX = { supportUrl: "https://aetrex.example/support", supportLabel: "Visit Support Hub" };
const LEAKY_DRAFT = "Our team is happy to help with verification questions. [Support Hub button is available above]";
const chunks = (n) => Array.from({ length: n }, (_, i) => ({ fileType: "faqs", sectionTitle: "Discounts", content: "x", similarity: 0.6 - i * 0.05 }));

// ── KNOWLEDGE turns: answer from RAG, NO handoff, no cards, no meta text ──────
const KNOWLEDGE_CASES = [
  { msg: "What information do I need to provide to verify I'm a teacher?" },
  { msg: "How do I verify a student discount?" },
  { msg: "Do you offer teacher discounts?" },
  { msg: "What is your return policy?" },
  { msg: "What is Aetrex arch support technology?" },
  { msg: "How do Aetrex sizes usually fit?" },
];
for (const c of KNOWLEDGE_CASES) {
  check(`answer-source: "${c.msg.slice(0, 34)}…" → policy_knowledge, no search, no cards`, () => {
    const plan = planTurn({ message: c.msg });
    assert.equal(plan.workflow, WORKFLOWS.POLICY_KNOWLEDGE, `workflow for "${c.msg}"`);
    assert.equal(plan.searchRequired, false, "no product search");
    assert.equal(plan.productDisplayPolicy, "suppress", "no product cards");
  });

  check(`answer-source: "${c.msg.slice(0, 34)}…" → RAG answer kept, source=rag, no handoff`, () => {
    const ragAnswer = "Teacher discounts are verified via SheerID at checkout — just upload your school credentials.";
    const r = applyAnswerSourceContract({ workflow: WORKFLOWS.POLICY_KNOWLEDGE, msg: c.msg, text: ragAnswer, ctx: SUPPORT_CTX, retrievedChunks: chunks(2) });
    assert.equal(r.applies, true);
    assert.equal(r.source, "rag", "answer source is RAG");
    assert.equal(r.handoff, false, "no support handoff when knowledge answered");
    assert.equal(r.ragAttempted, true);
    assert.equal(r.ragHit, true);
    assert.equal(r.supportCta, null, "no forced support CTA on a knowledge answer");
    assert.deepEqual(r.cards, [], "no product cards");
    assert.equal(r.suppressProductQuickReplies, true, "no product quick replies");
    assert.equal(r.text, ragAnswer, "the RAG answer is preserved");
    assertCleanHandoffText(r.text, c.msg);
  });

  check(`answer-source: "${c.msg.slice(0, 34)}…" → leaky RAG answer stripped, still source=rag + invariant`, () => {
    const leakyRag = "Teacher discounts are verified via SheerID at checkout. [Support Hub button is available above]";
    const r = applyAnswerSourceContract({ workflow: WORKFLOWS.POLICY_KNOWLEDGE, msg: c.msg, text: leakyRag, ctx: SUPPORT_CTX, retrievedChunks: chunks(2) });
    assert.equal(r.source, "rag", "still answered from RAG (we strip meta, not discard the answer)");
    assert.equal(r.metaLeak, true, "the UI-meta leak is detected → support_meta_text_leak fires");
    assert.match(r.text, /SheerID/i, "the real answer survives");
    assertCleanHandoffText(r.text, c.msg);
  });

  check(`answer-source: "${c.msg.slice(0, 34)}…" → no knowledge hit → friendly handoff`, () => {
    const deadEnd = "I don't have that specific detail in my notes.";
    const r = applyAnswerSourceContract({ workflow: WORKFLOWS.POLICY_KNOWLEDGE, msg: c.msg, text: deadEnd, ctx: SUPPORT_CTX, retrievedChunks: [] });
    assert.equal(r.source, "support_handoff", "falls back to support when no knowledge answered");
    assert.equal(r.handoff, true);
    assert.equal(r.handoffReason, "no_knowledge_match");
    assert.ok(r.supportCta && r.supportCta.fallbackUrl === SUPPORT_CTX.supportUrl, "real support CTA on the fallback");
    assertCleanHandoffText(r.text, c.msg);
  });
}

// ── PRIVATE turns: deterministic support handoff + CTA, never a knowledge answer
const PRIVATE_CASES = [
  { msg: "Why was my teacher verification rejected?", expect: /verification/i },
  { msg: "I need help with an order that says delivered but I didn't get it.", expect: /order/i },
  { msg: "Can someone help me with my account?", expect: /account/i },
];
for (const c of PRIVATE_CASES) {
  check(`answer-source: "${c.msg.slice(0, 34)}…" → account_private_handoff, no search`, () => {
    const plan = planTurn({ message: c.msg });
    assert.equal(plan.workflow, WORKFLOWS.ACCOUNT_PRIVATE_HANDOFF, `workflow for "${c.msg}"`);
    assert.equal(plan.searchRequired, false);
    assert.equal(plan.productDisplayPolicy, "suppress");
  });

  check(`answer-source: "${c.msg.slice(0, 34)}…" → deterministic handoff + CTA, clean (even leaky draft)`, () => {
    const r = applyAnswerSourceContract({ workflow: WORKFLOWS.ACCOUNT_PRIVATE_HANDOFF, msg: c.msg, text: LEAKY_DRAFT, ctx: SUPPORT_CTX, retrievedChunks: undefined });
    assert.equal(r.source, "support_handoff");
    assert.equal(r.handoff, true);
    assert.deepEqual(r.cards, [], "no product cards");
    assert.equal(r.suppressProductQuickReplies, true);
    assert.ok(r.supportCta && r.supportCta.fallbackUrl === SUPPORT_CTX.supportUrl, "real support CTA");
    assert.match(r.text, c.expect);
    assertCleanHandoffText(r.text, c.msg);
  });
}

check("answer-source: does NOT apply to commerce workflows (browse/availability/comparison)", () => {
  for (const wf of ["browse", "availability", "comparison", "condition_recommendation", "sale_browse", "product_spec"]) {
    assert.equal(applyAnswerSourceContract({ workflow: wf, msg: "show me sandals", text: "Here are some sandals." }).applies, false, wf);
  }
});

check("answer-source: private detector recognizes account/order/rejected; not a knowledge question", () => {
  for (const m of ["Why was my teacher verification rejected?", "I need help with an order that says delivered but I didn't get it.", "Can someone help me with my account?"]) {
    assert.equal(isAccountSupportHandoffRequest(m), true, `private: "${m}"`);
  }
  // A REQUIREMENTS / informational question is NOT a private handoff.
  assert.equal(isAccountSupportHandoffRequest("What information do I need to provide to verify I'm a teacher?"), false);
  assert.equal(isAccountSupportHandoffRequest("Do you offer teacher discounts?"), false);
  assert.equal(isAccountSupportHandoffRequest("What is your return policy?"), false);
});

console.log("");
if (fail === 0) {
  console.log(`PASS  ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`  ${f.name}: ${f.err.message}`);
  process.exit(1);
}
