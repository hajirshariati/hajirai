import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  PORT = 3001,
  INTERNAL_SECRET,
  ANTHROPIC_API_KEY: ENV_API_KEY,
  ANTHROPIC_MODEL: ENV_MODEL = "claude-sonnet-4-6",
  SYSTEM_PROMPT = "You are a helpful shopping assistant.",
} = process.env;

if (!INTERNAL_SECRET) { console.error("Missing INTERNAL_SECRET"); process.exit(1); }

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/chat", async (req, res) => {
  if (req.get("x-internal-secret") !== INTERNAL_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const apiKey = req.get("x-anthropic-api-key") || ENV_API_KEY;
  const model = req.get("x-anthropic-model") || ENV_MODEL;
  if (!apiKey) return res.status(400).json({ error: "no api key provided" });

  const { shop, message, history = [], assistant_name } = req.body || {};
  if (!shop || !message) return res.status(400).json({ error: "shop and message required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const client = new Anthropic({ apiKey });
  const system = SYSTEM_PROMPT + (assistant_name ? `\n\nYour name is ${assistant_name}.` : "");
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];

  try {
    const stream = await client.messages.stream({ model, max_tokens: 1024, system, messages });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: event.delta.text } })}\n\n`);
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    console.error("Anthropic error:", e);
    if (!res.headersSent) res.status(500).json({ error: "chat failed" });
    else res.end();
  }
});

app.listen(PORT, () => console.log(`Hajirai chat server on :${PORT}`));
