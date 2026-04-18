#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import axios from "axios";
import FormData from "form-data";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MOCHI_API_KEY = process.env.MOCHI_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const PORT = parseInt(process.env.PORT ?? "8080", 10);
const CLAUDEREMINDERS_URL = process.env.CLAUDEREMINDERS_URL ?? "https://claudereminders.fly.dev";
const CLAUDEREMINDERS_NOTIFY_TOKEN = process.env.CLAUDEREMINDERS_NOTIFY_TOKEN;

if (!MOCHI_API_KEY) {
  console.error("MOCHI_API_KEY environment variable is not set");
  process.exit(1);
}
if (!MCP_AUTH_TOKEN) {
  console.error("MCP_AUTH_TOKEN environment variable is not set");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Mochi API error class
// ---------------------------------------------------------------------------
function formatMochiErrors(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data !== "object") return String(data);
  if (Array.isArray(data)) return data.map(formatMochiErrors).filter(Boolean).join(", ");
  const parts = [];
  for (const [key, val] of Object.entries(data)) {
    const formatted = formatMochiErrors(val);
    parts.push(formatted ? `${key}: ${formatted}` : key);
  }
  return parts.join("; ");
}

class MochiError extends Error {
  constructor(errors, statusCode) {
    const message = formatMochiErrors(errors) || `Request failed with status ${statusCode}`;
    super(message);
    this.errors = errors;
    this.statusCode = statusCode;
    this.name = "MochiError";
  }
}

// ---------------------------------------------------------------------------
// Mochi API client
// ---------------------------------------------------------------------------
class MochiClient {
  constructor(token) {
    this.token = token;
    this.api = axios.create({
      baseURL: "https://app.mochi.cards/api/",
      headers: {
        Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
    });

    this.api.interceptors.response.use(
      (res) => res,
      (error) => {
        if (axios.isAxiosError(error) && error.response) {
          const { status, data } = error.response;
          if (data && (Array.isArray(data) || typeof data === "object")) {
            throw new MochiError(data, status);
          }
          if (typeof data === "string" && data.length > 0) {
            throw new MochiError([data], status);
          }
          throw new MochiError([`Request failed with status ${status}`], status);
        }
        throw error;
      }
    );
  }

  async createCard({ content, deckId, templateId = null, tags, attachments }) {
    const body = {
      content,
      "deck-id": deckId,
      "template-id": templateId,
      "manual-tags": tags,
    };
    const res = await this.api.post("/cards", body);
    const card = res.data;

    if (attachments) {
      for (const [filename, data] of Object.entries(attachments)) {
        await this.addAttachment({ cardId: card.id, filename, data });
      }
    }
    return card;
  }

  async updateCard(cardId, { content, deckId, templateId, archived, fields }) {
    const body = {};
    if (content !== undefined) body.content = content;
    if (deckId !== undefined) body["deck-id"] = deckId;
    if (templateId !== undefined) body["template-id"] = templateId;
    if (archived !== undefined) body["archived?"] = archived;
    if (fields !== undefined) body.fields = fields;
    const res = await this.api.post(`/cards/${cardId}`, body);
    return res.data;
  }

  async deleteCard(cardId) {
    await this.api.delete(`/cards/${cardId}`);
  }

  async listCards({ deckId, limit, bookmark } = {}) {
    const params = {};
    if (deckId !== undefined) params["deck-id"] = deckId;
    if (limit !== undefined) params.limit = limit;
    if (bookmark !== undefined) params.bookmark = bookmark;
    const res = await this.api.get("/cards", { params });
    return res.data;
  }

  async listDecks({ bookmark } = {}) {
    const params = {};
    if (bookmark !== undefined) params.bookmark = bookmark;
    const res = await this.api.get("/decks", { params });
    const docs = (res.data.docs ?? [])
      .filter((d) => !d["archived?"] && !d["trashed?"])
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    return { bookmark: res.data.bookmark, docs };
  }

  async createDeck({ name, parentId }) {
    const body = { name };
    if (parentId) body["parent-id"] = parentId;
    const res = await this.api.post("/decks", body);
    return res.data;
  }

  async listTemplates({ bookmark } = {}) {
    const params = {};
    if (bookmark !== undefined) params.bookmark = bookmark;
    const res = await this.api.get("/templates", { params });
    return res.data;
  }

  async getTemplate(templateId) {
    const res = await this.api.get(`/templates/${templateId}`);
    return res.data;
  }

  async createCardFromTemplate({ templateId, deckId, fields, tags, attachments }) {
    const template = await this.getTemplate(templateId);

    const fieldNameToId = {};
    for (const [id, field] of Object.entries(template.fields ?? {})) {
      fieldNameToId[field.name] = id;
    }

    const builtFields = {};
    const fieldValues = [];
    for (const [name, value] of Object.entries(fields)) {
      const id = fieldNameToId[name];
      if (!id) {
        throw new MochiError(
          [`Unknown field name: "${name}". Available: ${Object.keys(fieldNameToId).join(", ")}`],
          400
        );
      }
      builtFields[id] = { id, value };
      fieldValues.push(value);
    }

    const body = {
      content: fieldValues.join("\n---\n"),
      "deck-id": deckId,
      "template-id": templateId,
      "manual-tags": tags,
      fields: builtFields,
    };
    const res = await this.api.post("/cards", body);
    const card = res.data;

    if (attachments) {
      for (const [filename, data] of Object.entries(attachments)) {
        await this.addAttachment({ cardId: card.id, filename, data });
      }
    }
    return card;
  }

  async getDueCards({ deckId, date } = {}) {
    const endpoint = deckId ? `/due/${deckId}` : "/due";
    const params = date ? { date } : undefined;
    const res = await this.api.get(endpoint, { params });
    return res.data;
  }

  async getCard(cardId) {
    const res = await this.api.get(`/cards/${cardId}`);
    return res.data;
  }

  async getDeckStats(deckId) {
    let total = 0;
    let bookmark = undefined;
    do {
      const result = await this.listCards({ deckId, limit: 100, bookmark });
      const docs = result.docs ?? [];
      total += docs.length;
      bookmark = docs.length === 100 ? result.bookmark : undefined;
    } while (bookmark);

    const dueResult = await this.getDueCards({ deckId });
    const due = dueResult.cards?.length ?? 0;

    return { total, due };
  }

  async searchCards(deckId, keyword) {
    const matches = [];
    let bookmark = undefined;
    const kw = keyword.toLowerCase();
    do {
      const result = await this.listCards({ deckId, limit: 100, bookmark });
      const docs = result.docs ?? [];
      for (const doc of docs) {
        const name = (doc.name ?? "").toLowerCase();
        const content = (doc.content ?? "").toLowerCase();
        if (name.includes(kw) || content.includes(kw)) {
          matches.push({ id: doc.id, name: doc.name, content: doc.content });
        }
      }
      bookmark = docs.length === 100 ? result.bookmark : undefined;
    } while (bookmark);
    return matches;
  }

  async createCardsBatch(cards) {
    const created = [];
    const failed = [];
    for (const card of cards) {
      try {
        const result = await this.createCard(card);
        created.push({ index: cards.indexOf(card), name: card.name, id: result.id });
      } catch (e) {
        failed.push({ index: cards.indexOf(card), name: card.name, error: e instanceof MochiError ? e.message : String(e) });
      }
    }
    return { created, failed, total: cards.length };
  }

  async addAttachment({ cardId, filename, data, contentType }) {
    if (!contentType) {
      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      const mime = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
        mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
        mp4: "video/mp4", pdf: "application/pdf",
      };
      contentType = mime[ext] ?? "application/octet-stream";
    }
    const buffer = Buffer.from(data, "base64");
    const form = new FormData();
    form.append("file", buffer, { filename, contentType });
    await this.api.post(
      `/cards/${cardId}/attachments/${encodeURIComponent(filename)}`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Basic ${Buffer.from(`${this.token}:`).toString("base64")}`,
        },
      }
    );
    return { filename, markdown: `![](${filename})` };
  }
}

const mochi = new MochiClient(MOCHI_API_KEY);

// ---------------------------------------------------------------------------
// Tool response helpers
// ---------------------------------------------------------------------------
function toolError(error) {
  if (error instanceof z.ZodError) {
    const msgs = error.issues.map((i) => {
      const path = i.path.join(".");
      return `${path ? path + ": " : ""}${i.message}`;
    });
    return { content: [{ type: "text", text: `Validation error:\n${msgs.join("\n")}` }], isError: true };
  }
  if (error instanceof MochiError) {
    return { content: [{ type: "text", text: `Mochi API error (${error.statusCode}): ${error.message}` }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// MCP server factory — creates one McpServer per session
// ---------------------------------------------------------------------------
function createMcpServer() {
  const server = new McpServer({ name: "mochicreator", version: "1.0.0" });

// list_decks
server.registerTool(
  "list_decks",
  {
    title: "List Mochi decks",
    description: "List all non-archived, non-trashed decks. Use this to find the right deckId before creating cards. The response includes parent-id for subdecks. Call with no arguments or an empty object on the first page.",
    inputSchema: z.object({
      bookmark: z.string().optional().describe("Pagination cursor from a previous response. Omit for the first page."),
    }),
  },
  async (args = {}) => {
    try {
      return ok(await mochi.listDecks(args));
    } catch (e) {
      return toolError(e);
    }
  }
);

// create_deck
server.registerTool(
  "create_deck",
  {
    title: "Create Mochi deck",
    description: "Create a new deck, optionally nested under a parent deck. Use parentId to create subdecks (e.g. ENAMED > Cardiologia > Arritmias).",
    inputSchema: z.object({
      name: z.string().min(1).describe("Display name for the deck"),
      parentId: z.string().optional().describe("ID of the parent deck (for subdecks)"),
    }),
  },
  async (args) => {
    try {
      return ok(await mochi.createDeck(args));
    } catch (e) {
      return toolError(e);
    }
  }
);

// create_flashcard
server.registerTool(
  "create_flashcard",
  {
    title: "Create Mochi flashcard",
    description: "Create a new flashcard. Supported formats: (1) Simple cloze: 'Term is {{answer}}.'; (2) Indexed cloze for comparisons: '{{1::X}} vs {{2::Y}}'; (3) Front/back: 'Question?\\n\\n---\\n\\nAnswer'. Always include a name (short title for searchability). Use list_decks to find deckId.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Short card title for searchability, e.g. 'Metformina - classe'"),
      content: z.string().min(1).describe("Mochi markdown: cloze {{term}}, indexed {{1::X}} {{2::Y}}, or front/back separated by \\n\\n---\\n\\n"),
      deckId: z.string().min(1).describe("ID of the target deck from list_decks"),
      templateId: z.string().optional().nullable().describe("Optional template ID"),
      tags: z.array(z.string()).optional().describe("Tags, e.g. ['#needs-visual']"),
      attachments: z.record(z.string(), z.string()).optional().describe("Map of filename to base64 data for images/audio"),
    }),
  },
  async (args) => {
    try {
      return ok(await mochi.createCard(args));
    } catch (e) {
      return toolError(e);
    }
  }
);

// create_card_from_template
server.registerTool(
  "create_card_from_template",
  {
    title: "Create Mochi card from template",
    description: "Create a flashcard using a template. Fields are specified by name (not ID). Use list_templates and get_template to discover available templates and fields.",
    inputSchema: z.object({
      templateId: z.string().min(1).describe("Template ID from list_templates"),
      deckId: z.string().min(1).describe("Target deck ID"),
      fields: z.record(z.string(), z.string()).describe("Map of field names to values"),
      tags: z.array(z.string()).optional(),
      attachments: z.record(z.string(), z.string()).optional(),
    }),
  },
  async (args) => {
    try {
      return ok(await mochi.createCardFromTemplate(args));
    } catch (e) {
      return toolError(e);
    }
  }
);

// update_flashcard
server.registerTool(
  "update_flashcard",
  {
    title: "Update Mochi flashcard",
    description: "Update an existing flashcard's content, deck, template, or fields. Only provided fields are updated. To remove a card use delete_flashcard — soft-delete (trashed) is not supported by the Mochi API.",
    inputSchema: z.object({
      cardId: z.string().describe("ID of the card to update"),
      content: z.string().optional().describe("New markdown content"),
      deckId: z.string().optional().describe("Move card to this deck"),
      templateId: z.string().optional(),
      fields: z.record(z.string(), z.object({ id: z.string(), value: z.string() })).optional(),
    }),
  },
  async ({ cardId, ...rest }) => {
    try {
      return ok(await mochi.updateCard(cardId, rest));
    } catch (e) {
      return toolError(e);
    }
  }
);

// delete_flashcard
server.registerTool(
  "delete_flashcard",
  {
    title: "Delete Mochi flashcard",
    description: "Permanently delete a flashcard. This cannot be undone.",
    inputSchema: z.object({
      cardId: z.string().describe("ID of the card to permanently delete"),
    }),
    annotations: { destructiveHint: true },
  },
  async ({ cardId }) => {
    try {
      await mochi.deleteCard(cardId);
      return ok({ success: true, cardId });
    } catch (e) {
      return toolError(e);
    }
  }
);

// archive_flashcard
server.registerTool(
  "archive_flashcard",
  {
    title: "Archive Mochi flashcard",
    description: "Archive or unarchive a flashcard.",
    inputSchema: z.object({
      cardId: z.string().describe("ID of the card"),
      archived: z.boolean().default(true).describe("true to archive, false to unarchive"),
    }),
  },
  async ({ cardId, archived }) => {
    try {
      return ok(await mochi.updateCard(cardId, { archived }));
    } catch (e) {
      return toolError(e);
    }
  }
);

// list_flashcards
server.registerTool(
  "list_flashcards",
  {
    title: "List Mochi flashcards",
    description: "List flashcards, optionally filtered by deck. Supports pagination.",
    inputSchema: z.object({
      deckId: z.string().optional().describe("Filter by deck ID"),
      limit: z.number().min(1).max(100).optional().describe("Cards per page (1-100)"),
      bookmark: z.string().optional().describe("Pagination bookmark"),
    }),
  },
  async (args) => {
    try {
      return ok(await mochi.listCards(args));
    } catch (e) {
      return toolError(e);
    }
  }
);

// search_deck_cards — keyword search with full pagination
server.registerTool(
  "search_deck_cards",
  {
    title: "Search cards in deck",
    description: "Search cards in a deck by keyword (matches card name and content, case-insensitive, paginates through all cards). Use for duplicate detection before creating cards or finding a card to edit. Without keyword, returns the first page of cards with a note if the deck is larger.",
    inputSchema: z.object({
      deckId: z.string().min(1).describe("Deck ID to search in"),
      keyword: z.string().optional().describe("Keyword to filter by (case-insensitive, matches name and content). Omit to browse the first page."),
    }),
  },
  async ({ deckId, keyword }) => {
    try {
      if (keyword) {
        const matches = await mochi.searchCards(deckId, keyword);
        return ok({ matches, count: matches.length });
      }
      const result = await mochi.listCards({ deckId, limit: 50 });
      const docs = result.docs ?? [];
      const note = result.bookmark && docs.length === 50
        ? "Deck has >50 cards — use keyword parameter to search across all cards."
        : undefined;
      return ok({ docs, ...(note ? { note } : {}) });
    } catch (e) {
      return toolError(e);
    }
  }
);

// list_templates
server.registerTool(
  "list_templates",
  {
    title: "List Mochi templates",
    description: "List all card templates.",
    inputSchema: z.object({
      bookmark: z.string().optional(),
    }),
  },
  async (args) => {
    try {
      return ok(await mochi.listTemplates(args));
    } catch (e) {
      return toolError(e);
    }
  }
);

// get_template
server.registerTool(
  "get_template",
  {
    title: "Get Mochi template details",
    description: "Fetch a template with its full field definitions. Use field names (not IDs) when calling create_card_from_template.",
    inputSchema: z.object({
      templateId: z.string().min(1).describe("Template ID"),
    }),
  },
  async ({ templateId }) => {
    try {
      return ok(await mochi.getTemplate(templateId));
    } catch (e) {
      return toolError(e);
    }
  }
);

// get_due_cards
server.registerTool(
  "get_due_cards",
  {
    title: "Get cards due for review",
    description: "Get flashcards due for spaced repetition review today (or on a specific date). Optionally filter by deck.",
    inputSchema: z.object({
      deckId: z.string().optional().describe("Filter by deck ID"),
      date: z.string().optional().describe("ISO 8601 date, defaults to today"),
    }),
  },
  async (args) => {
    try {
      return ok(await mochi.getDueCards(args));
    } catch (e) {
      return toolError(e);
    }
  }
);

// get_flashcard
server.registerTool(
  "get_flashcard",
  {
    title: "Get Mochi flashcard by ID",
    description: "Fetch a single flashcard by ID to read its current content and fields. Use this before editing to verify content, or after creating to confirm the result.",
    inputSchema: z.object({
      cardId: z.string().min(1).describe("Card ID to retrieve"),
    }),
  },
  async ({ cardId }) => {
    try {
      return ok(await mochi.getCard(cardId));
    } catch (e) {
      return toolError(e);
    }
  }
);

// get_deck_stats
server.registerTool(
  "get_deck_stats",
  {
    title: "Get deck statistics",
    description: "Get total card count and due-today count for a deck in one call. Useful at study session start to surface pending reviews before creating new cards.",
    inputSchema: z.object({
      deckId: z.string().min(1).describe("Deck ID to get stats for"),
    }),
  },
  async ({ deckId }) => {
    try {
      return ok(await mochi.getDeckStats(deckId));
    } catch (e) {
      return toolError(e);
    }
  }
);

// create_flashcards_batch
server.registerTool(
  "create_flashcards_batch",
  {
    title: "Create multiple Mochi flashcards",
    description: "Create up to 50 flashcards in a single call. Returns {created, failed, total} so partial failures are visible — if card 7 fails you know exactly which succeeded. Prefer this over multiple create_flashcard calls.",
    inputSchema: z.object({
      cards: z.array(
        z.object({
          name: z.string().min(1).describe("Short card title for searchability"),
          content: z.string().min(1).describe("Mochi markdown content"),
          deckId: z.string().min(1).describe("Target deck ID"),
          templateId: z.string().optional().nullable().describe("Optional template ID"),
          tags: z.array(z.string()).optional().describe("Tags e.g. ['#high-yield']"),
        })
      ).min(1).max(50).describe("Array of cards to create"),
    }),
  },
  async ({ cards }) => {
    try {
      return ok(await mochi.createCardsBatch(cards));
    } catch (e) {
      return toolError(e);
    }
  }
);

  return server;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Active Streamable HTTP transports keyed by sessionId
const sessions = new Map();

function isAuthorized(req) {
  const bearer = req.headers.authorization ?? "";
  const queryToken = req.query.token ?? "";
  return bearer === `Bearer ${MCP_AUTH_TOKEN}` || queryToken === MCP_AUTH_TOKEN;
}

// POST /mcp — handles both new session init and subsequent requests
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId) {
    // Existing session — session ID is implicit auth
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — must be an initialize request with valid auth
  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ error: "Expected initialize request for new session" });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => { sessions.set(id, transport); },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — SSE stream for server-to-client notifications
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessions.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handleRequest(req, res);
});

// DELETE /mcp — explicit session teardown
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId).close();
    sessions.delete(sessionId);
  }
  res.status(200).end();
});

// ---------------------------------------------------------------------------
// Notification state
// ---------------------------------------------------------------------------
const NOTIFY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const QUIET_START_HOUR = 22; // 10pm SP — no notifications
const QUIET_END_HOUR = 6;    // 6am SP — notifications resume
let lastNotifiedAt = 0;      // epoch ms, 0 = never notified

function isQuietHour() {
  const hour = new Date().getHours(); // SP time via TZ=America/Sao_Paulo in fly.toml
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

// Returns a result object describing what happened. Never throws.
async function checkAndNotify() {
  if (isQuietHour()) {
    return { skipped: "quiet hours (22:00–06:00)" };
  }
  const cooldownRemaining = NOTIFY_COOLDOWN_MS - (Date.now() - lastNotifiedAt);
  if (cooldownRemaining > 0) {
    return { skipped: `cooldown (${Math.ceil(cooldownRemaining / 60000)} min remaining)` };
  }
  if (!CLAUDEREMINDERS_NOTIFY_TOKEN) {
    return { skipped: "CLAUDEREMINDERS_NOTIFY_TOKEN not set" };
  }

  const result = await mochi.getDueCards();
  const count = result.cards?.length ?? 0;
  if (count === 0) return { notified: false, due: 0 };

  await axios.post(
    `${CLAUDEREMINDERS_URL}/notify`,
    {
      title: "Mochi — Revisões pendentes",
      message: `Você tem ${count} card${count > 1 ? "s" : ""} para revisar.`,
    },
    { headers: { Authorization: `Bearer ${CLAUDEREMINDERS_NOTIFY_TOKEN}` }, timeout: 10000 }
  );
  lastNotifiedAt = Date.now();
  console.log(`[${new Date().toISOString()}] Due cards reminder sent: ${count} cards.`);
  return { notified: true, due: count };
}

// ---------------------------------------------------------------------------
// Health check endpoint — designed for UptimeRobot monitoring
// Requires ?token=MCP_AUTH_TOKEN (or Bearer header).
// On each call: checks Mochi API, MCP sessions, and runs the notification gate.
// ---------------------------------------------------------------------------
app.get("/healthz", async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const report = {
    status: "ok",
    timestamp: new Date().toISOString(),
    mcp: { activeSessions: sessions.size },
    mochi: null,
    notification: null,
    claudeReminders: null,
  };

  // Check Mochi API
  try {
    const decks = await mochi.listDecks();
    report.mochi = { status: "ok", deckCount: decks.docs?.length ?? 0 };
  } catch (e) {
    report.mochi = { status: "down", error: e.message };
    report.status = "down";
  }

  // Check ClaudeReminders (full status if token available, fallback to /health)
  try {
    if (CLAUDEREMINDERS_NOTIFY_TOKEN) {
      const r = await axios.get(`${CLAUDEREMINDERS_URL}/status`, {
        params: { token: CLAUDEREMINDERS_NOTIFY_TOKEN },
        timeout: 7000,
      });
      report.claudeReminders = r.data;
    } else {
      const r = await axios.get(`${CLAUDEREMINDERS_URL}/health`, { timeout: 5000 });
      report.claudeReminders = { status: r.data?.status ?? "unknown" };
    }
    if (report.claudeReminders?.status !== "ok") report.status = "down";
  } catch (e) {
    report.claudeReminders = { status: "down", error: e.message };
    report.status = "down";
  }

  // Notification gate (best-effort, never blocks the response)
  try {
    report.notification = await checkAndNotify();
  } catch (e) {
    report.notification = { error: e.message };
  }

  res.json(report);
});

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

// Keep ClaudeReminders warm every 10 minutes (separate from the healthz check).
setInterval(async () => {
  try {
    const r = await axios.get(`${CLAUDEREMINDERS_URL}/health`, { timeout: 5000 });
    console.log(`[${new Date().toISOString()}] ClaudeReminders ping: ${r.data?.status ?? "unknown"}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ClaudeReminders ping failed: ${e.message}`);
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Mochi MCP server listening on port ${PORT}`);
});
