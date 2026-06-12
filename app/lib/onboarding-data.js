// Onboarding content shown on /onboarding. Pure data, no React/JSX.
// Generic, merchant-facing — works for any Shopify store installing
// SEoS Assistant. The renderer in app/routes/onboarding.jsx walks
// these arrays and groups by `phase` and (in the maintain phase) by
// `cadence`.

export const PHASES = [
  { id: "install",   name: "Install",   icon: "📥", description: "Open the app, connect the AI engine, sync your catalog." },
  { id: "configure", name: "Configure", icon: "⚙️", description: "Map your product attributes and upload optional knowledge files." },
  { id: "integrate", name: "Integrate", icon: "🔌", description: "Connect optional integrations like Yotpo, Aftership, and Klaviyo." },
  { id: "launch",    name: "Launch",    icon: "🚀", description: "Style the widget, add it to your theme, QA, and monitor." },
  { id: "maintain",  name: "Maintain",  icon: "🔧", description: "Recurring tasks to keep the assistant healthy after launch." },
];

// Maintain-phase steps are grouped by how often you should run them.
// Display order is fixed here; the renderer in app/routes/onboarding.jsx
// uses this list to insert subsection headers between groups. Any
// maintain step missing a `cadence` field (or with an unknown value)
// falls into the "Other" bucket at the bottom.
export const CADENCE_SECTIONS = [
  { id: "weekly",    label: "Weekly",      blurb: "Open every Monday morning." },
  { id: "monthly",   label: "Monthly",     blurb: "Block 30 minutes on the first of each month." },
  { id: "quarterly", label: "Quarterly",   blurb: "Once a quarter — calendar reminder helps." },
  { id: "as-needed", label: "As needed",   blurb: "Triggered by a specific event (new product line, model release, complaint spike)." },
  { id: "reference", label: "Reference",   blurb: "Read-once concept guides — no schedule." },
];

// Example attribute mapping table shown in step 4. These are
// PLACEHOLDERS — your actual metafield namespaces / tag prefixes
// depend on how your store's products are structured. Edit the
// mappings in Catalog → Attribute mappings to match your data.
export const ATTRIBUTE_MAPPINGS = [
  { source: "metafield: custom.attr_gender",    attribute: "gender",     note: "Used to scope category buttons and searches by men's / women's / kids" },
  { source: "metafield: custom.attr_category",  attribute: "category",   note: "Your product types — e.g. Sneakers, Sandals, Boots, Loafers" },
  { source: "metafield: custom.attr_arch_type", attribute: "arch_type",  note: "Optional — feeds fit recommendations if you sell footwear" },
  { source: "metafield: custom.attr_fit_type",  attribute: "fit_type",   note: "Optional — Standard / Wide / Narrow for the size predictor" },
  { source: "metafield: custom.attr_use_case",  attribute: "use_case",   note: "Optional — Walking / Running / Casual / Dress, etc." },
  { source: "tag prefix: color:",               attribute: "color",      note: "Tags like 'color:black' map to the color attribute" },
  { source: "tag prefix: occasion:",            attribute: "occasion",   note: "Optional — e.g. wedding, work, beach" },
];

export const STEPS = [
  {
    phase: "install",
    icon: "📂",
    title: "Open the app",
    short: "Apps → SEoS Assistant in your Shopify admin.",
    body: "Open the SEoS Assistant app from your Shopify admin (Apps → SEoS Assistant). The home page is the setup checklist — every step below lives inside the admin, no external tools needed.",
  },
  {
    phase: "install",
    icon: "🔑",
    title: "Connect the AI engine",
    short: "Paste your Anthropic API key. Choose Smart routing.",
    body: "Settings → AI engine → API key. Paste your Anthropic API key from console.anthropic.com. Choose Smart routing as the strategy.",
    tip: "Smart routing runs standard shopping turns on the Fast model and escalates product comparisons and complex queries to the Standard model. Every reply is fact-checked against live catalog data before it reaches the customer; if a check fails, the turn automatically re-runs on the Standard model. Best balance of cost and quality.",
  },
  {
    phase: "install",
    icon: "⏱",
    title: "Wait for the catalog to sync",
    short: "Your products mirror in a few minutes.",
    body: "First load triggers a full Shopify catalog sync. Most catalogs finish in 2–5 minutes. The home page shows '[X] products synced' once it's done; do not move on until that number stabilizes.",
  },
  {
    phase: "configure",
    icon: "🗂",
    title: "Map your product attributes",
    short: "Map your metafields / tags to clean attribute names.",
    body: "Catalog → Attribute mappings. Tell the assistant which of your Shopify metafields or tag prefixes carry the data it should filter on (gender, category, color, etc.). Use the reference table below as a starting point and edit the keys to match your store's actual metafield namespace.",
    showAttributeTable: true,
  },
  {
    phase: "configure",
    icon: "📚",
    title: "Upload knowledge files (optional)",
    short: "FAQs, brand voice, sizing guides, product specs.",
    body: "Knowledge → Knowledge files. Upload anything the assistant should know that isn't in the product catalog: FAQs, return policy, brand voice notes, sizing charts, fit glossary, or a SKU-keyed CSV of extra product attributes (material, care, fit notes). With RAG enabled (next step), only the sections relevant to each question are sent to the AI per turn.",
    list: [
      "FAQ markdown — sizing, returns, shipping, technology questions",
      "Brand voice — tone guidelines (e.g. warm, expert, never pushy)",
      "Sizing guide — how to read your size chart for each product line",
      "Glossary — definitions of your product technologies and proprietary terms",
      "Product attributes CSV — SKU-keyed material / care / fit-notes per product",
    ],
    tip: "Use the in-app templates (Knowledge → Knowledge files → each category has a Download button) — they're pre-formatted with `═══` dividers so each section becomes one retrievable chunk when RAG is on. A CSV with a SKU column auto-links each row to your catalog.",
  },
  {
    phase: "configure",
    icon: "🧠",
    title: "Turn on semantic search + RAG retrieval (optional)",
    short: "Match by meaning, not just keywords.",
    body: "Optional — the assistant already searches your catalog with AI and works fully without this; an embedding key sharpens matching by meaning. Settings → Semantic search. Paste an OpenAI or Voyage AI key. One key powers two features: semantic product matching (a customer asking 'shoes for standing all day' finds arch-support styles even when 'standing' isn't in the description), and RAG over your knowledge files (only the top relevant sections are sent to the AI per chat turn instead of the full corpus).",
    list: [
      "Paste the embedding API key in Settings → Semantic search and save.",
      "Open Catalog → Semantic search and click Backfill embeddings — one-time, typically under $1.",
      "Open Knowledge → Knowledge files and toggle 'Use RAG retrieval' — only enabled once an embedding provider is configured.",
      "After enabling RAG, re-upload existing knowledge files so they get chunked and embedded.",
    ],
    tip: "New uploads embed automatically — no manual rebuild needed once RAG is on. The Knowledge size bar on the Knowledge page shows your total upload size; with RAG on, only ~3 KB reaches the AI per turn regardless of total size.",
  },
  {
    phase: "integrate",
    icon: "⭐",
    title: "Connect Yotpo — reviews + loyalty (optional)",
    short: "Reviews powers fit summaries; Loyalty powers VIP perks.",
    body: "Settings → Integrations → Yotpo Reviews and Yotpo Loyalty & Referrals. Paste each API key from your Yotpo account.",
    list: [
      "Yotpo Reviews API key → enables review-based fit summaries",
      "Yotpo Loyalty API key + GUID → enables points balance, tier, and personal referral link inside chat",
    ],
  },
  {
    phase: "integrate",
    icon: "📦",
    title: "Connect Aftership (optional)",
    short: "Branded tracking + return-reason data for the fit predictor.",
    body: "Settings → Integrations → Aftership. Paste your Aftership API key. Two effects: return-reason data feeds the fit predictor (so 'too small' returns inform sizing recommendations), and tracking links shown to logged-in shoppers route to your branded Aftership tracking page.",
  },
  {
    phase: "integrate",
    icon: "📧",
    title: "Connect Klaviyo (optional)",
    short: "Segments adapt VIP-mode tone for logged-in shoppers.",
    body: "Settings → Integrations → Klaviyo. Paste your Klaviyo Company ID, List ID, and private API key. The private key unlocks segment enrichment in VIP mode — the assistant adapts tone based on whether a logged-in shopper is in a VIP, Winback, or Churn-Risk segment. Segment names are never shown to the customer.",
  },
  {
    phase: "integrate",
    icon: "👤",
    title: "Enable VIP mode (optional)",
    short: "Personalize chat for logged-in customers.",
    body: "Settings → VIP customer experience → toggle VIP mode on. Logged-in shoppers now get personalized greetings, size recommendations anchored on their order history, and loyalty references in chat. None of their data is stored — every lookup is per-conversation, in-memory only.",
    tip: "Test VIP mode with a real customer account that has at least 2 past orders. Without past orders the size predictor falls back to review and return data.",
  },
  {
    phase: "integrate",
    icon: "📏",
    title: "Configure the fit predictor (optional)",
    short: "Combines reviews + returns + order history into one fit signal.",
    body: "Fit predictor (Beta) → Enable. The predictor combines Yotpo review fit data, Aftership return reasons, and the customer's own order history into a single confidence score per product. If your store also has an external sizing API, paste its endpoint and key to feed that data in too.",
  },
  {
    phase: "launch",
    icon: "🎨",
    title: "Customize the widget appearance",
    short: "Brand colors, logo, assistant name, welcome banner.",
    body: "Open Theme Editor → SEoS Assistant block. Set your brand colors, upload your avatar (square logo), and write a welcome banner. Set the assistant name and tagline to match the rest of your site.",
    tip: "The Enterprise plan removes the SEoS Assistant tagline from the widget footer — confirm it's gone before going live.",
  },
  {
    phase: "launch",
    icon: "🧩",
    title: "Add the chat block to your live theme",
    short: "Add the SEoS Assistant block to your live theme. Save.",
    body: "In Theme Editor, add the SEoS Assistant block to the body of your live theme. Save. The launcher now appears in the bottom corner of every storefront page. If you want to hide it on specific pages (cart, checkout-confirmation), use Settings → Widget visibility → Hide-on URLs.",
  },
  {
    phase: "launch",
    icon: "💬",
    title: "Smoke-test the assistant from the admin home",
    short: "Use the built-in test chat — it talks to the real engine and never touches your analytics.",
    body: "The admin home page has an 'Ask anything…' box right under the greeting. It posts to the same chat handler the storefront widget uses — same system prompt, same tools, same grounding fact-checker, same model routing — so what you see in the test reply is exactly what a customer would get on the storefront. The one difference: test chats are flagged as internal, so they do NOT count toward your Analytics dashboard, AI cost totals, satisfaction rate, or your plan's monthly message quota. Run a few representative questions before pointing customers at the widget.",
    list: [
      "Ask one open-ended question (e.g. 'I need shoes for plantar fasciitis') and check the assistant clarifies + recommends real catalog products.",
      "Ask a comparison question ('what's the difference between X and Y') and confirm both names match real products and prices.",
      "Try a tricky edge case — a product line you don't carry, or a vague color request — and confirm the assistant is honest instead of inventing options.",
    ],
    tip: "If the test chat surfaces something off, fix it once and it's fixed for every customer — same engine. The 'You don't count toward analytics' guarantee means you can stress-test freely without skewing your dashboards.",
  },
  {
    phase: "launch",
    icon: "✅",
    title: "QA with a real shopper account",
    short: "Verify VIP greeting, fit cards, loyalty, tracking, and the discovery flow.",
    body: "Log into your storefront as a test customer with at least 2 past orders. Open the chat. Verify each:",
    list: [
      "Welcome message shows the customer's first name (VIP greeting)",
      "Asking 'what size should I get in [product]' returns a fit prediction card with a confidence percentage",
      "Asking about points or rewards mentions their actual loyalty balance",
      "Asking about an order's tracking returns a link to your branded tracking page",
      "A condition-style question like 'I have foot pain, what should I wear?' walks the customer through gender → category → recommendation, only offering categories you actually sell for that gender",
    ],
  },
  {
    phase: "launch",
    icon: "📊",
    title: "Monitor in Analytics for the first week",
    short: "Watch satisfaction, AI cost, and rate-limit hits.",
    body: "The Analytics page tracks every conversation. Watch satisfaction rate (thumbs-up / down), AI cost, and rate-limit hits daily for the first week. Negative feedback surfaces specific responses to review and tune your knowledge files.",
    tip: "If AI cost spikes unexpectedly, set a Daily message cap in Settings → Daily message cap. The assistant pauses when the cap is hit and resumes the next day at midnight UTC.",
  },
  {
    phase: "maintain",
    cadence: "as-needed",
    icon: "🤖",
    title: "Update the AI model when Anthropic ships a new version",
    short: "Swap the model ID in your hosting environment variables.",
    body: "Model IDs are env-driven. When Anthropic releases a newer Claude (e.g. Sonnet 4.7 → 4.8), update the env var in your hosting provider (Railway, Vercel, etc.) → Variables → paste the new model ID → Save. The service auto-restarts in ~30 seconds.",
    list: [
      "DEFAULT_MODEL — the primary Standard model used for product questions and most chat",
      "HAIKU_MODEL — the cheap Fast model used for trivial follow-ups when Smart routing is on",
      "OPUS_MODEL — used only when the routing strategy is 'Premium quality' in admin",
    ],
    tip: "Always smoke-test 3–5 chats after switching models. If anything regresses (different phrasing, missed rules, wrong tool calls), revert the env var to the previous ID — instant rollback. Anthropic recommends explicit version pinning over 'latest' aliases.",
  },
  {
    phase: "maintain",
    cadence: "monthly",
    icon: "⚠️",
    title: "Watch logs for model deprecation warnings",
    short: "Anthropic gives ~6 months notice before a model retires.",
    body: "When a Claude model is deprecated, the API prints a warning on every chat call: 'The model X is deprecated and will reach end-of-life on [date]'. Anthropic gives roughly 6 months notice. When you see the warning, plan the model update task above before the EOL date — otherwise chat will start failing on that date.",
    tip: "Check the Anthropic model deprecation schedule monthly: https://docs.anthropic.com/en/docs/about-claude/model-deprecations",
  },
  {
    phase: "maintain",
    cadence: "as-needed",
    icon: "🧠",
    title: "Re-embed the catalog after big content edits",
    short: "Check the embedding bar in Catalog → Semantic search after bulk product changes.",
    body: "Product create/update webhooks re-sync and re-embed changed products automatically within seconds — rapid-fire updates are batched, and a bulk edit touching 40+ products automatically triggers one full catalog re-sync instead of thousands of single updates. The one gap: tools that bypass Shopify webhooks entirely (rare, but some direct-database migration apps do). After any bulk operation, glance at Catalog → Semantic search — if the embedded count sits below the product count, click Backfill to close the gap.",
    tip: "If the embedded count drops below the total products count and you didn't expect it, that's the sign — click Backfill until the bar hits 100% again.",
  },
  {
    phase: "maintain",
    cadence: "quarterly",
    icon: "📚",
    title: "Quarterly knowledge file review",
    short: "Keep FAQs, sizing, and policies current.",
    body: "Once per quarter, open Knowledge → Knowledge files and re-upload any of these that have changed on your site:",
    list: [
      "FAQ file — if shipping policy, return policy, or your FAQ page changed",
      "Sizing guide — if you updated the chart or added new size ranges",
      "Glossary — if you launched a new technology line or proprietary term",
      "Product attributes CSV — if you added new SKU-specific spec data",
    ],
    tip: "Outdated knowledge files = outdated AI answers. The AI will confidently quote a stale return policy if the file says 30 days but the site says 60.",
  },
  {
    phase: "maintain",
    cadence: "monthly",
    icon: "💳",
    title: "Monitor Anthropic credits & low-balance alerts",
    short: "Pay-as-you-go — chat goes silent if the balance hits zero.",
    body: "The Anthropic API key is pay-as-you-go from your credit balance at console.anthropic.com. If the balance reaches zero, every chat request fails with 'insufficient credit balance' and customers see an error fallback. Top up monthly or set up auto-recharge in Anthropic billing settings.",
    tip: "Configure low-balance email alerts in Anthropic console → Settings → Billing → Notifications. Set the threshold to ~30 days of typical spend to catch issues before they hit customers.",
  },
  {
    phase: "maintain",
    cadence: "weekly",
    icon: "👍",
    title: "Review chat feedback weekly",
    short: "Analytics → Negative feedback list. Each thumbs-down is a tuning signal.",
    body: "Open Analytics every Monday. Scroll to the negative feedback section — each thumbs-down attaches the conversation that triggered it. Common patterns and their fixes:",
    list: [
      "Wrong product recommended → tune knowledge files or attribute mappings",
      "AI re-asked something already answered → check that conversation history is being passed correctly",
      "AI claimed a product doesn't exist when it does → check Rules → Search behavior and Catalog → Category groups for over-aggressive filtering",
      "AI gave outdated info → refresh the relevant knowledge file",
    ],
  },
  {
    phase: "maintain",
    cadence: "as-needed",
    icon: "🗂",
    title: "Keep Category Groups aligned with new product types",
    short: "Add new categories to the right group when you launch new lines.",
    body: "When you add a new product type in Shopify, open Catalog → Category groups and add the new category to the right group. Without an entry, the new category falls outside the group filter and may appear in the wrong intent's chip list.",
    tip: "The Category groups card on the Catalog page shows your current groups. Compare against your catalog every time a new product line launches.",
  },

  // ── How RAG works ─────────────────────────────────────────────────
  {
    phase: "maintain",
    cadence: "reference",
    icon: "📖",
    title: "How RAG retrieval works",
    short: "Top-K relevant knowledge chunks per chat turn instead of dumping all files.",
    body: "Without RAG, every chat turn injects every uploaded knowledge file into the system prompt — 10–30KB of text. That bloat causes 'lost in the middle' (the AI ignores info buried in long prompts) and burns tokens on every turn. With RAG on, only the most relevant sections are retrieved per customer message. End to end:",
    list: [
      "Indexing (one-time per file): the chunker splits each file on `═══` dividers — paragraph-pack fallback if there are no dividers. Each section is embedded via your configured embedding provider (OpenAI or Voyage) and stored in the KnowledgeChunk table with a 1024-dim vector.",
      "Retrieval (every chat turn): the customer's message is embedded with the same provider. A pgvector cosine-similarity query pulls the top-5 chunks above 0.35 similarity. Those chunks (~3KB) are injected into the system prompt instead of the full ~22KB corpus.",
      "Fallback safety net: if retrieval can't run at all (no chunks embedded yet, or the embedding provider is unreachable), the prompt builder falls back to the full-dump path so nothing breaks. If retrieval runs and finds no section relevant to the question, nothing is injected — the AI answers from catalog data alone instead of being fed unrelated text.",
      "Cost: ~$0.0000004 per chat turn for embedding the customer query (effectively free). Token savings on the Anthropic call usually offset embedding cost 10x over.",
      "Multi-tenant: every chunk is scoped by shop column. One Postgres instance can serve any number of stores — each sees only its own data.",
    ],
    tip: "The Knowledge size bar on the Knowledge page reflects upload size, not runtime size. With RAG on, the AI only ever sees ~3KB of knowledge per turn even if you've uploaded 60KB total — but the bar still shows 60KB because that's what's in storage.",
  },

  // ── Quality testing (developer-only — terminal access required) ───
  {
    phase: "maintain",
    cadence: "reference",
    icon: "🧪",
    title: "How chat quality is measured",
    short: "A live grounding fact-checker plus four layers of automated tests and a real-customer feedback loop.",
    body: "The first layer runs live on every single reply: a grounding validator checks every product name, price, and feature claim the AI makes against the actual catalog data it retrieved that turn. If a claim isn't backed by evidence, the reply is rejected and the turn automatically re-runs on the stronger model with the errors spelled out — the customer only ever sees the corrected answer. On top of that, four layers of engineering tests catch regressions before deploys. The commands below need terminal access — they're for the engineering team, not something you run from the admin UI.",
    list: [
      "Quick automated checks (eval) — instant offline tests on the chat's logic. Free, takes 2 seconds. Run after any code change.",
      "Real-AI scenario tests (eval:scenarios) — simulated customer conversations sent to the real Anthropic API. Costs a few cents. Pass-rate tells you how the AI is actually behaving.",
      "Customer feedback loop (feedback:import) — every time a real customer hits 👎 in the chat widget, that conversation is stored. The import script pulls those into the test suite so the same bug never ships twice.",
      "Hallucination audit (audit:hallucinations) — scans recent live responses, extracts every product code and brand-line claim the AI made, and checks each one against your synced catalog. Surfaces 'made-up SKU' and 'fake product line' bugs that pattern-based runtime guards can't catch alone.",
    ],
    tip: "Think of it as: 'quick checks' before deploy, 'AI scenarios' to measure quality, 'feedback' to learn from real customers, 'audit' to catch fabricated facts. All four commands live in the project repo.",
  },
  {
    phase: "maintain",
    cadence: "as-needed",
    icon: "✅",
    title: "Run the quick automated checks before every code push",
    short: "npm run eval — instant offline tests, no API key needed.",
    body: "These are the fastest checks. They cover the chat's parsing, filtering, intent detection, banned-language stripping, and card-rendering logic. Free to run, finishes in a couple of seconds. Run this before pushing any code change to main.",
    commands: [
      "git pull",
      "npm run eval",
    ],
    list: [
      "All suites green = safe to push.",
      "Any suite fails = something broke. Don't deploy. Fix or revert.",
    ],
    tip: "If you're only changing rules / FAQ / brand text in the admin (not code), you don't need to run this — it tests code, not knowledge files.",
  },
  {
    phase: "maintain",
    cadence: "weekly",
    icon: "🤖",
    title: "Run the real-AI scenario tests",
    short: "npm run eval:scenarios — representative chats vs the real AI.",
    body: "This is the dashboard for chat quality. It sends the scenario suite to the real Anthropic API using the same system prompt the live chat uses, and checks whether responses pass each scenario's assertions (no banned phrases, mentions the right product line, doesn't ask gender twice, etc.). Costs roughly $0.05–0.20 per run depending on the model. Also run before any demo to a stakeholder.",
    commands: [
      "export ANTHROPIC_API_KEY=<your-key>",
      "npm run eval:scenarios",
    ],
    list: [
      "Pass rate ≥ 90% = healthy.",
      "Pass rate < 90% = something regressed. Each failed line shows the AI's actual response so you can see what broke.",
      "Re-run 2–3 times and average — the AI is non-deterministic, expect ±2-3% variance per run.",
    ],
    tip: "Set the ANTHROPIC_API_KEY env var once per terminal session, then run as many times as you like. Never paste it into a chat or commit it to git.",
  },
  {
    phase: "maintain",
    cadence: "monthly",
    icon: "👎",
    title: "Pull customer thumbs-down into the test suite",
    short: "Every 👎 in the widget becomes a regression test.",
    body: "Whenever a customer hits 'Not helpful' in the chat widget, the conversation gets saved to the database. Run the feedback importer monthly (or after any complaint spike) to convert those into scenarios. The next test run will check whether the same kind of failure can still happen.",
    commands: [
      "npm run feedback:import",
      "npm run eval:feedback",
    ],
    list: [
      "feedback:import — reads the last 30 days of 👎 and writes them to scripts/scenarios.from-feedback.json.",
      "eval:feedback — runs those imported scenarios against the live AI. Prints WHEN RATED 👎 vs RESPONSE NOW so you can compare side by side.",
      "IMPORTANT: '100% pass' on the feedback eval only means the AI's responses don't contain banned phrases. It does NOT confirm the customer's actual concern is resolved. Read both responses and judge whether RESPONSE NOW is genuinely better.",
    ],
    tip: "Optional flags: '--days=7' for the last week, '--shop=foo.myshopify.com' for one shop only, '--no-dedupe' to keep every 👎.",
  },
  {
    phase: "maintain",
    cadence: "monthly",
    icon: "🕵️",
    title: "Audit AI claims against the catalog",
    short: "npm run audit:hallucinations — find made-up SKUs and fake product lines.",
    body: "This scans recent chat responses and pulls out every product code (SKU) and brand-line claim ('Lynco is our premium orthotic line') the AI mentioned. It then checks each one against your synced Shopify catalog. Anything that doesn't resolve to a real product or variant gets flagged as a likely hallucination. Useful right before a demo, after a model upgrade, or whenever a stakeholder reports the AI 'made something up'. Read-only — never touches the live chat.",
    commands: [
      "npm run audit:hallucinations -- --days=30 --shop=<your-shop>.myshopify.com",
    ],
    list: [
      "Output: console summary (scanned / flagged / rate / top 10 flagged responses) plus a full JSON report at scripts/audit-hallucinations.json.",
      "Two violation kinds: orphan-sku (the AI mentioned a SKU that isn't in any synced variant for this shop) and definitional-claim (the AI said 'X is our premium line' but X isn't a known vendor or title token).",
      "Flagged-rate of 0–2% is healthy; over 5% means the catalog is out of sync (run a re-sync from Catalog → Catalog sync) or the model is genuinely fabricating — open the JSON report to tell which.",
    ],
    tip: "Optional flags: '--vote=down' to only audit thumbs-downed responses (the most suspicious data set), '--limit=200' to cap the scan, '--json' to print the full report to stdout.",
  },
  {
    phase: "maintain",
    cadence: "as-needed",
    icon: "✏️",
    title: "Add a new scenario when you spot a bug",
    short: "Open scripts/scenarios.json, copy an example, change a few fields.",
    body: "When a customer or QA finds a chat issue that isn't already covered, lock it in as a permanent test so it can't regress. The scenario file is plain JSON — you don't need to know JavaScript. Find a similar existing scenario, copy its block, and edit the customer messages and expected behavior.",
    list: [
      "Each scenario has a name, optional 'history' array (prior turns), 'messages' array (the new user message(s)), and 'expect' object with assertions.",
      "Common assertions: mustContain (these phrases must appear), mustNotContain (these phrases must NOT appear), shouldMentionAny (at least one of these), shouldAskAbout (the AI should ask about one of these topics), maxSentences (response can't be longer than N).",
      "After editing the file, run 'npm run eval:scenarios' to confirm it passes (or fails as expected on a buggy build), then commit and push. The new scenario protects against that bug forever.",
    ],
    tip: "Don't write scenarios from scratch — open scripts/scenarios.json and copy the closest existing one as a template.",
  },
];
