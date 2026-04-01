#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import axios from "axios";
import FormData from "form-data";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MOCHI_API_KEY = process.env.MOCHI_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const PORT = parseInt(process.env.PORT ?? "8080", 10);

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
class MochiError extends Error {
  constructor(errors, statusCode) {
    super(
      Array.isArray(errors)
        ? errors.join(", ")
        : Object.values(errors).join(", ")
    );
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

  async updateCard(cardId, { content, deckId, templateId, archived, trashed, fields }) {
    const body = {};
    if (content !== undefined) body.content = content;
    if (deckId !== undefined) body["deck-id"] = deckId;
    if (templateId !== undefined) body["template-id"] = templateId;
    if (archived !== undefined) body["archived?"] = archived;
    if (trashed !== undefined) body["trashed?"] = trashed;
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
// MCP server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "mochi-mcp", version: "1.0.0" });

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

// list_decks
server.registerTool(
  "list_decks",
  {
    title: "List Mochi decks",
    description: "List all non-archived, non-trashed decks. Use this to find the right deckId before creating cards. The response includes parent-id for subdecks.",
    inputSchema: z.object({
      bookmark: z.string().optional().describe("Pagination bookmark"),
    }),
  },
  async (args) => {
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
    description: "Create a new flashcard. Format content as: question text \\n---\\n answer text. The --- must be on its own line. Use list_decks to find deckId.",
    inputSchema: z.object({
      content: z.string().min(1).describe("Markdown content: question\\n---\\nanswer"),
      deckId: z.string().min(1).describe("ID of the target deck"),
      templateId: z.string().optional().nullable().describe("Optional template ID"),
      tags: z.array(z.string()).optional().describe("Tags for the card"),
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
    description: "Update an existing flashcard's content, deck, template, or fields. Only provided fields are updated.",
    inputSchema: z.object({
      cardId: z.string().describe("ID of the card to update"),
      content: z.string().optional().describe("New markdown content"),
      deckId: z.string().optional().describe("Move card to this deck"),
      templateId: z.string().optional(),
      fields: z.record(z.string(), z.object({ id: z.string(), value: z.string() })).optional(),
      trashed: z.boolean().optional().describe("true to soft-delete, false to restore"),
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
    description: "Permanently delete a flashcard. This cannot be undone. Prefer trashing (update_flashcard with trashed:true) when in doubt.",
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

// search_deck_cards  (lightweight duplicate check — max 50 cards)
server.registerTool(
  "search_deck_cards",
  {
    title: "Search cards in deck (duplicate check)",
    description: "Fetch up to 50 cards from a deck to check for duplicates before creating. Returns an empty list if the deck has more than 50 cards to avoid excessive token usage.",
    inputSchema: z.object({
      deckId: z.string().min(1).describe("Deck ID to search in"),
    }),
  },
  async ({ deckId }) => {
    try {
      const result = await mochi.listCards({ deckId, limit: 50 });
      const docs = result.docs ?? [];
      if (result.bookmark && docs.length === 50) {
        return ok({ note: "Deck has >50 cards — duplicate check skipped to save usage.", docs: [] });
      }
      return ok({ docs });
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

// ---------------------------------------------------------------------------
// Express app + auth middleware
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

function requireAuth(req, res, next) {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${MCP_AUTH_TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Active SSE transports keyed by sessionId
const transports = {};

app.get("/sse", requireAuth, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

app.post("/messages", requireAuth, async (req, res) => {
  const { sessionId } = req.query;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`Mochi MCP server listening on port ${PORT}`);
});
