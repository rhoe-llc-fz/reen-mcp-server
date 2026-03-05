#!/usr/bin/env node
/**
 * REEN MCP Server — native tools for AI agents.
 * Thin wrapper over REST API backend.reen.tech.
 *
 * Transport: stdio (standard for Claude Code, Cursor, Codex).
 * Auth: REEN_API_TOKEN env.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReenClient, log } from "./client.js";

// --- Config ---

const token = process.env.REEN_API_TOKEN;
if (!token) {
  process.stderr.write(
    "Error: REEN_API_TOKEN environment variable is required.\n" +
    "Get your token at https://reen.tech → Settings → API Tokens.\n"
  );
  process.exit(1);
}

const baseUrl = process.env.REEN_API_URL || "https://backend.reen.tech";
const client = new ReenClient({ baseUrl, token });

// --- Server ---

const server = new McpServer({
  name: "reen-mcp-server",
  version: "0.1.0",
});

// =============================================
// Tool: whoami
// =============================================
server.tool(
  "whoami",
  "Get current authenticated user info (sanity check)",
  {},
  async () => {
    const data = await client.get<{ username: string; role: string; email?: string }>("/api/auth/me");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: list_plans
// =============================================
server.tool(
  "list_plans",
  "List all Gantt plans. Returns summary by default (id, title, status, progress). Use detail_level='full' to include tasks.",
  {
    detail_level: z.enum(["summary", "full"]).optional().default("summary")
      .describe("'summary' = id+title+status+progress, 'full' = include tasks[]"),
  },
  async ({ detail_level }) => {
    const data = await client.get<{ plans: Plan[] }>("/api/gant/plans");
    let result: unknown;
    if (detail_level === "summary") {
      result = data.plans.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        progress: p.progress,
        project_path: p.project_path,
        task_count: p.tasks?.length ?? 0,
      }));
    } else {
      result = data.plans;
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// =============================================
// Tool: get_plan
// =============================================
server.tool(
  "get_plan",
  "Get a specific plan by ID with all tasks and subtasks",
  {
    plan_id: z.string().describe("Plan ID (e.g. 'argus-20260212-113911-6e2e82')"),
    detail_level: z.enum(["summary", "full"]).optional().default("summary")
      .describe("'summary' = narrative + compact task tree (no description/briefing). 'full' = everything (can be very large). Use 'summary' for initial overview, 'full' only when you need task details."),
  },
  async ({ plan_id, detail_level }) => {
    const data = await client.get<{ plans: Plan[] }>("/api/gant/plans");
    const plan = data.plans.find((p) => p.id === plan_id);
    if (!plan) {
      return { content: [{ type: "text", text: `Plan '${plan_id}' not found` }], isError: true };
    }

    if (detail_level === "full") {
      return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
    }

    // --- summary mode: compact view with narrative ---
    const narData = await client.get<{ narrative: string }>(`/api/gant/plans/${plan_id}/narrative`);
    const allTasks: Task[] = plan.tasks ?? [];

    // Построить дерево: top-level задачи + подсчёт subtasks
    const topLevel = allTasks.filter((t) => !t.parent_task_id);
    const summaryTasks = topLevel.map((t) => {
      const children = allTasks.filter((c) => c.parent_task_id === t.id);
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        progress: t.progress,
        start_date: t.start_date,
        end_date: t.end_date,
        subtask_count: children.length,
        subtasks_done: children.filter((c) => c.status === "done").length,
      };
    });

    const summary = {
      id: plan.id,
      title: plan.title,
      status: plan.status,
      progress: plan.progress,
      start_date: plan.start_date,
      due_date: plan.due_date,
      description: plan.description,
      narrative: narData.narrative || "",
      total_tasks: allTasks.length,
      tasks: summaryTasks,
    };

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  },
);

// =============================================
// Tool: create_plan
// =============================================
server.tool(
  "create_plan",
  "Create a new Gantt plan",
  {
    title: z.string().describe("Plan title"),
    description: z.string().optional().describe("Plan description"),
    start_date: z.string().describe("Start date YYYY-MM-DD"),
    due_date: z.string().describe("Due date YYYY-MM-DD"),
    branch: z.string().optional().default("argus").describe("Branch name"),
  },
  async ({ title, description, start_date, due_date, branch }) => {
    const data = await client.post("/api/gant/plans", { title, description, start_date, due_date, branch });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: update_plan
// =============================================
server.tool(
  "update_plan",
  "Update plan fields (title, description, status, progress)",
  {
    plan_id: z.string().describe("Plan ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["planned", "in-progress", "done", "blocked", "cancelled"]).optional().describe("New status"),
    progress: z.number().min(0).max(1).optional().describe("Progress 0.0-1.0"),
    change_reason: z.string().optional().describe("Why this change was made (recorded in audit log)"),
    change_evidence: z.array(z.string()).optional().describe("Supporting evidence/references for the change"),
  },
  async ({ plan_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== undefined));
    const data = await client.patch(`/api/gant/plans/${plan_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: delete_plan
// =============================================
server.tool(
  "delete_plan",
  "Delete a plan by ID",
  {
    plan_id: z.string().describe("Plan ID to delete"),
  },
  async ({ plan_id }) => {
    const data = await client.delete(`/api/gant/plans/${plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: create_task
// =============================================
server.tool(
  "create_task",
  "Create a new top-level task (phase) in a plan",
  {
    plan_id: z.string().describe("Plan ID"),
    title: z.string().describe("Task title"),
    start_date: z.string().describe("Start date YYYY-MM-DD"),
    end_date: z.string().describe("End date YYYY-MM-DD"),
    status: z.enum(["planned", "in-progress", "done", "blocked", "cancelled"]).optional().default("planned"),
    position: z.number().int().min(0).optional().describe("Position index (0-based). Omit to append at end"),
  },
  async (args) => {
    const data = await client.post("/api/gant/task", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: create_subtask
// =============================================
server.tool(
  "create_subtask",
  "Create a subtask under an existing task",
  {
    plan_id: z.string().describe("Plan ID"),
    task_id: z.string().describe("Parent task ID"),
    title: z.string().describe("Subtask title"),
    start_date: z.string().describe("Start date YYYY-MM-DD"),
    end_date: z.string().describe("End date YYYY-MM-DD"),
    status: z.enum(["planned", "in-progress", "done", "blocked", "cancelled"]).optional().default("planned"),
    path: z.array(z.number()).optional().default([]).describe("Path to nested parent (e.g. [0, 2])"),
    position: z.number().int().min(0).optional().describe("Position index (0-based). Omit to append at end"),
  },
  async (args) => {
    const data = await client.post("/api/gant/subtask", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: update_task
// =============================================
server.tool(
  "update_task",
  "Update a task's title, status, description, or progress",
  {
    task_id: z.string().describe("Task ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["planned", "in-progress", "done", "blocked", "cancelled"]).optional().describe("New status"),
    progress: z.number().min(0).max(1).optional().describe("Progress 0.0-1.0"),
    change_reason: z.string().optional().describe("Why this change was made (recorded in audit log)"),
    change_evidence: z.array(z.string()).optional().describe("Supporting evidence/references for the change"),
  },
  async ({ task_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== undefined));
    const data = await client.patch(`/api/gant/tasks/${task_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: update_task_dates
// =============================================
server.tool(
  "update_task_dates",
  "Update a task's start and/or due dates",
  {
    plan_id: z.string().describe("Plan ID"),
    task_id: z.string().describe("Task ID"),
    start_date: z.string().optional().describe("New start date YYYY-MM-DD"),
    due_date: z.string().optional().describe("New due date YYYY-MM-DD"),
  },
  async ({ plan_id, task_id, start_date, due_date }) => {
    // Backend expects end_date, not due_date
    const data = await client.patch("/api/gant/task/dates", { plan_id, task_id, start_date, end_date: due_date });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: delete_task
// =============================================
server.tool(
  "delete_task",
  "Delete a task from a plan",
  {
    plan_id: z.string().describe("Plan ID"),
    task_id: z.string().describe("Task ID to delete"),
  },
  async (args) => {
    const data = await client.delete("/api/gant/task", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: reorder_task
// =============================================
server.tool(
  "reorder_task",
  "Move a task to a new position within its sibling group",
  {
    task_id: z.string().describe("Task ID to move"),
    position: z.number().int().min(0).describe("New position index (0-based)"),
  },
  async ({ task_id, position }) => {
    const data = await client.post("/api/gant/tasks/reorder", { task_id, position });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: get_plan_progress
// =============================================
server.tool(
  "get_plan_progress",
  "Get progress for all tasks in a plan (bulk)",
  {
    plan_id: z.string().describe("Plan ID"),
  },
  async ({ plan_id }) => {
    const data = await client.get(`/api/gant/progress-bulk/${plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Narrative tools ---

server.tool(
  "get_narrative",
  "Get the narrative text content of a plan",
  {
    plan_id: z.string().describe("Plan ID"),
  },
  async ({ plan_id }) => {
    const data = await client.get(`/api/gant/plans/${plan_id}/narrative`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_narrative",
  "Update the narrative text content of a plan",
  {
    plan_id: z.string().describe("Plan ID"),
    narrative: z.string().describe("Narrative text (Markdown)"),
  },
  async ({ plan_id, narrative }) => {
    const data = await client.put(`/api/gant/plans/${plan_id}/narrative`, { narrative });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Ex-Help tools ---

server.tool(
  "list_exhelp",
  "List all Ex-Help requests for a plan",
  {
    plan_id: z.string().describe("Plan ID"),
  },
  async ({ plan_id }) => {
    const data = await client.get(`/api/gant/exhelp/${plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "create_exhelp",
  "Create a new Ex-Help request for a plan",
  {
    plan_id: z.string().describe("Plan ID"),
    title: z.string().optional().default("").describe("Request title"),
    problem: z.string().optional().default("").describe("Problem description (Markdown)"),
    initial_prompt: z.string().optional().describe("Initial system prompt for AI models analyzing this request"),
  },
  async ({ plan_id, title, problem, initial_prompt }) => {
    const body: Record<string, unknown> = { title, problem };
    if (initial_prompt) body.initial_prompt = initial_prompt;
    const data = await client.post(`/api/gant/exhelp/${plan_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_exhelp",
  "Update an Ex-Help request (title, problem, answer, status, initial_prompt)",
  {
    exhelp_id: z.string().describe("Ex-Help request ID"),
    title: z.string().optional().describe("New title"),
    problem: z.string().optional().describe("Updated problem description (Markdown)"),
    answer: z.string().optional().describe("Answer text (Markdown)"),
    answers: z.array(z.object({
      model_id: z.string().describe("Model ID: claude, gpt, gemini, grok"),
      text: z.string().describe("Answer text (Markdown)"),
      created_at: z.string().optional().describe("ISO timestamp"),
    })).optional().describe("Array of model-specific answers"),
    status: z.enum(["draft", "sent", "answered"]).optional().describe("New status"),
    initial_prompt: z.string().optional().describe("Initial system prompt for AI models analyzing this request"),
  },
  async ({ exhelp_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== undefined));
    const data = await client.patch(`/api/gant/exhelp/${exhelp_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_exhelp_answer",
  "Add or update an AI model's answer for an Ex-Help request",
  {
    exhelp_id: z.string().describe("Ex-Help request ID"),
    model_id: z.enum(["claude", "gpt", "gemini", "grok"]).describe("Model ID"),
    text: z.string().describe("Answer text (Markdown)"),
  },
  async ({ exhelp_id, model_id, text }) => {
    // Get current answers
    const current = await client.get<{ exhelp?: { answers?: unknown } }>(`/api/gant/exhelp/${exhelp_id}/pack?format=json`);
    let answers: Array<{ model_id: string; text: string; created_at?: string }> = [];
    const exhelp = (current as Record<string, unknown>)?.exhelp as Record<string, unknown> | undefined;
    const raw = exhelp?.answers;
    if (Array.isArray(raw)) answers = raw as typeof answers;
    // Update or add answer
    const entry = { model_id, text, created_at: new Date().toISOString() };
    const idx = answers.findIndex(a => a.model_id === model_id);
    if (idx >= 0) answers[idx] = entry;
    else answers.push(entry);
    const data = await client.patch(`/api/gant/exhelp/${exhelp_id}`, { answers });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_exhelp_pack",
  "Generate a context pack for an Ex-Help request (includes plan, tasks, files)",
  {
    exhelp_id: z.string().describe("Ex-Help request ID"),
    format: z.enum(["json", "md"]).optional().default("json").describe("Output format: json or md"),
  },
  async ({ exhelp_id, format }) => {
    const data = await client.get(`/api/gant/exhelp/${exhelp_id}/pack?format=${format}`);
    return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_exhelp",
  "Delete an Ex-Help request",
  {
    exhelp_id: z.string().describe("Ex-Help request ID to delete"),
  },
  async ({ exhelp_id }) => {
    const data = await client.delete(`/api/gant/exhelp/${exhelp_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "share_exhelp",
  "Generate a public share link for an Ex-Help request (7-day TTL, no auth required to view)",
  {
    exhelp_id: z.string().describe("Ex-Help request ID"),
  },
  async ({ exhelp_id }) => {
    const data = await client.post(`/api/gant/exhelp/${exhelp_id}/share`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "list_plan_files",
  "List files attached to a plan (filterable by context: narrative or exhelp)",
  {
    plan_id: z.string().describe("Plan ID"),
    context: z.enum(["narrative", "exhelp"]).optional().describe("Filter by context type"),
    exhelp_id: z.string().optional().describe("Filter by Ex-Help request ID (when context=exhelp)"),
  },
  async ({ plan_id, context, exhelp_id }) => {
    let path = `/api/gant/plans/${plan_id}/files`;
    const params: string[] = [];
    if (context) params.push(`context=${context}`);
    if (exhelp_id) params.push(`exhelp_id=${exhelp_id}`);
    if (params.length) path += `?${params.join("&")}`;
    const data = await client.get(path);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Conference tools ---

server.tool(
  "list_conferences",
  "List all conferences for the current user",
  {},
  async () => {
    const data = await client.get<{ conferences: unknown[] }>("/api/conferences");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_conference_initial_prompt",
  "Get the initial system prompt of a conference",
  {
    conference_id: z.string().describe("Conference ID"),
  },
  async ({ conference_id }) => {
    const data = await client.get(`/api/conferences/${conference_id}/initial-prompt`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_conference_initial_prompt",
  "Update the initial system prompt of a conference",
  {
    conference_id: z.string().describe("Conference ID"),
    initial_prompt: z.string().describe("New initial prompt text"),
  },
  async ({ conference_id, initial_prompt }) => {
    const data = await client.put(`/api/conferences/${conference_id}/initial-prompt`, { initial_prompt });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "create_conference",
  "Create a new AI conference for multi-model discussions",
  {
    title: z.string().describe("Conference title"),
    description: z.string().optional().describe("Conference description"),
    book_id: z.string().optional().describe("Link to Research Library book (must be 'completed' status)"),
  },
  async ({ title, description, book_id }) => {
    const data = await client.post("/api/conferences", { title, description, book_id });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "read_conference_messages",
  "Read recent messages from a conference (history + metadata)",
  {
    conference_id: z.string().describe("Conference ID"),
    limit: z.number().optional().default(50).describe("Number of recent messages to return (default 50)"),
  },
  async ({ conference_id, limit }) => {
    const data = await client.get(`/api/conferences/${conference_id}?limit=${limit}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_conference_agents",
  "Set active AI models for a conference. Valid models: claude, gpt, gemini, grok",
  {
    conference_id: z.string().describe("Conference ID"),
    agents: z.array(z.enum(["claude", "gpt", "gemini", "grok"])).max(4).describe("List of active model IDs"),
  },
  async ({ conference_id, agents }) => {
    const data = await client.put(`/api/conferences/${conference_id}/agents`, { agents });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "send_conference_message",
  "Send a message to a conference. Use mentions to @mention other AI models (claude, gpt, gemini, grok) and trigger their response.",
  {
    conference_id: z.string().describe("Conference ID"),
    content: z.string().describe("Message text (supports @mentions like @claude, @gpt, @gemini, @all)"),
    author: z.string().optional().default("claude-code").describe("Author name displayed in chat"),
    mentions: z.array(z.string()).optional().default([]).describe("Explicit @mentions to route message (e.g. ['claude', 'gpt'])"),
  },
  async ({ conference_id, content, author, mentions }) => {
    const data = await client.post(`/api/conferences/${conference_id}/messages`, { content, author, mentions });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: list_artifacts
// =============================================
server.tool(
  "list_artifacts",
  "List all artifacts for a plan",
  {
    plan_id: z.string().describe("Plan ID"),
  },
  async ({ plan_id }) => {
    const data = await client.get(`/api/gant/artifacts/${plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: create_artifact
// =============================================
server.tool(
  "create_artifact",
  "Create a new artifact (note/file) in a plan",
  {
    plan_id: z.string().describe("Plan ID"),
    title: z.string().optional().default("New Artifact").describe("Artifact title"),
    content: z.string().optional().default("").describe("Artifact content (Markdown)"),
  },
  async ({ plan_id, title, content }) => {
    const data = await client.post(`/api/gant/artifacts/${plan_id}`, { title, content });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: update_artifact
// =============================================
server.tool(
  "update_artifact",
  "Update an artifact's title or content",
  {
    artifact_id: z.string().describe("Artifact ID"),
    title: z.string().optional().describe("New title"),
    content: z.string().optional().describe("New content (Markdown)"),
  },
  async ({ artifact_id, title, content }) => {
    const body: Record<string, string> = {};
    if (title !== undefined) body.title = title;
    if (content !== undefined) body.content = content;
    const data = await client.patch(`/api/gant/artifacts/${artifact_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// =============================================
// Tool: delete_artifact
// =============================================
server.tool(
  "delete_artifact",
  "Delete an artifact (soft delete)",
  {
    artifact_id: z.string().describe("Artifact ID to delete"),
  },
  async ({ artifact_id }) => {
    const data = await client.delete(`/api/gant/artifacts/${artifact_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Research tools ---

server.tool(
  "research_upload_book",
  "Upload a book/document for analysis via JSON. Pipeline extracts text, segments into chapters, then stops at 'segments_ready' for your local AI to analyze.",
  {
    title: z.string().describe("Book title"),
    text: z.string().describe("Full text content of the book/document"),
    author: z.string().optional().describe("Author name"),
    domain: z.string().optional().describe("Knowledge domain (e.g. 'physics', 'philosophy')"),
    language: z.string().optional().describe("Language code (e.g. 'en', 'ru'). Auto-detected if omitted."),
  },
  async (args) => {
    const data = await client.post("/api/research/books/json", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "research_list_books",
  "List all books in the user's research library with their processing status.",
  {},
  async () => {
    const data = await client.get("/api/research/books");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "research_get_book",
  "Get a book's knowledge graph (cards + edges). Only meaningful when status = 'completed'.",
  {
    book_id: z.string().describe("Book ID"),
  },
  async ({ book_id }) => {
    const data = await client.get(`/api/research/books/${book_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "research_get_book_status",
  "Check a book's processing status and progress.",
  {
    book_id: z.string().describe("Book ID"),
  },
  async ({ book_id }) => {
    const data = await client.get(`/api/research/books/${book_id}/status`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "research_get_segments",
  "Get raw text segments (chapters) of a book for analysis. Returns segments array + expected output schema + page_images (base64 PNG renders of pages containing graphics/diagrams). Only works when status = 'segments_ready'.",
  {
    book_id: z.string().describe("Book ID"),
  },
  async ({ book_id }) => {
    const data = await client.get(`/api/research/books/${book_id}/segments`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "research_submit_analysis",
  "Submit analysis results (cards + edges) produced by your local AI model. This completes the book processing and builds the knowledge graph. Can be called on 'segments_ready' or 'completed' books (re-submission replaces old data).",
  {
    book_id: z.string().describe("Book ID"),
    cards: z.array(z.object({
      chapter_number: z.number().int().describe("Chapter index (1-based, matching segment order)"),
      title: z.string().describe("Chapter title"),
      essence: z.string().describe("Core insight of this chapter in one sentence — not a summary, but what the reader understands after this chapter"),
      thesis: z.string().optional().describe("The specific argumentative claim this chapter advances. What is the author ARGUING? 1-2 sentences."),
      chapter_context: z.string().optional().describe("This chapter's role in the book's architecture: what it builds upon and what it enables. 2-3 sentences."),
      summary_simple: z.string().describe("Reconstruction of the chapter's argument for a non-specialist. State the problem, explain the approach, present conclusions. 8-12 sentences."),
      argument_structure: z.string().optional().describe("Logical skeleton: premises → reasoning steps → conclusion. Think proof outline. 3-6 sentences."),
      summary_technical: z.string().describe("Analytical deep dive using author's terminology and notation. Preserve formal elements, explain distinctions, trace implications. 12-20 sentences."),
      formal_elements: z.string().optional().describe("Formal models, mathematical notation, taxonomies — reproduced verbatim with explanation. null if none."),
      importance: z.number().int().min(1).max(5).describe("Importance rating 1-5"),
      key_terms: z.array(z.string()).optional().default([]).describe("Key terms/concepts including technical terms in author's notation"),
      evidence_quotes: z.array(z.object({
        text: z.string(),
        location: z.string().optional(),
      })).optional().default([]).describe("Verbatim quotes capturing key claims, not just definitions"),
    })).describe("Analysis cards, one per chapter"),
    edges: z.array(z.object({
      from_chapter: z.number().int().describe("Source chapter number"),
      to_chapter: z.number().int().describe("Target chapter number"),
      type: z.enum(["depends_on", "extends", "illustrates"]).describe("Relationship type"),
      confidence: z.number().min(0).max(1).optional().default(1.0).describe("Confidence 0.0-1.0"),
      why: z.string().optional().describe("Explanation of the connection"),
    })).optional().default([]).describe("Edges connecting chapters"),
    book_summary: z.string().optional().describe("Overall book summary (2-3 sentences)"),
  },
  async ({ book_id, cards, edges, book_summary }) => {
    const body: Record<string, unknown> = { cards, edges };
    if (book_summary) body.book_summary = book_summary;
    const data = await client.post(`/api/research/books/${book_id}/analyze`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "research_delete_book",
  "Delete a book from the research library.",
  {
    book_id: z.string().describe("Book ID to delete"),
  },
  async ({ book_id }) => {
    const data = await client.delete(`/api/research/books/${book_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Strategic Plans ---

server.tool(
  "list_strategic_plans",
  "List all strategic plans for the current user",
  {},
  async () => {
    const data = await client.get("/api/gant/strategic-plans");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "create_strategic_plan",
  "Create a new strategic plan (free-form canvas where cards = plans)",
  {
    title: z.string().describe("Strategic plan title"),
    description: z.string().optional().describe("Strategic plan description"),
  },
  async ({ title, description }) => {
    const body: Record<string, unknown> = { title };
    if (description) body.description = description;
    const data = await client.post("/api/gant/strategic-plans", body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_strategic_plan",
  "Get a strategic plan with all cards and edges (full canvas)",
  {
    strategic_plan_id: z.string().describe("Strategic plan ID"),
  },
  async ({ strategic_plan_id }) => {
    const data = await client.get(`/api/gant/strategic-plans/${strategic_plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "update_strategic_plan",
  "Update a strategic plan's title or description",
  {
    strategic_plan_id: z.string().describe("Strategic plan ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
  },
  async ({ strategic_plan_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== undefined));
    const data = await client.patch(`/api/gant/strategic-plans/${strategic_plan_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "delete_strategic_plan",
  "Delete a strategic plan (soft delete)",
  {
    strategic_plan_id: z.string().describe("Strategic plan ID to delete"),
  },
  async ({ strategic_plan_id }) => {
    const data = await client.delete(`/api/gant/strategic-plans/${strategic_plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_strategic_plan_card",
  "Add a plan card to the strategic plan canvas",
  {
    strategic_plan_id: z.string().describe("Strategic plan ID"),
    plan_id: z.string().describe("Plan ID to add as a card"),
    position_x: z.number().optional().describe("X position on canvas (default: auto)"),
    position_y: z.number().optional().describe("Y position on canvas (default: auto)"),
  },
  async ({ strategic_plan_id, plan_id, position_x, position_y }) => {
    const body: Record<string, unknown> = { plan_id };
    if (position_x !== undefined) body.position_x = position_x;
    if (position_y !== undefined) body.position_y = position_y;
    const data = await client.post(`/api/gant/strategic-plans/${strategic_plan_id}/cards`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "remove_strategic_plan_card",
  "Remove a plan card from the strategic plan canvas",
  {
    strategic_plan_id: z.string().describe("Strategic plan ID"),
    card_id: z.string().describe("Card ID to remove"),
  },
  async ({ strategic_plan_id, card_id }) => {
    const data = await client.delete(`/api/gant/strategic-plans/${strategic_plan_id}/cards/${card_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "add_strategic_plan_edge",
  "Add an edge (arrow) between two cards on the strategic plan canvas",
  {
    strategic_plan_id: z.string().describe("Strategic plan ID"),
    source_card_id: z.string().describe("Source card ID"),
    target_card_id: z.string().describe("Target card ID"),
    label: z.string().optional().describe("Optional text label on the edge"),
    edge_type: z.enum(["default", "dependency", "feeds", "blocks"]).optional().default("default")
      .describe("Edge type: default, dependency, feeds, blocks"),
  },
  async ({ strategic_plan_id, source_card_id, target_card_id, label, edge_type }) => {
    const body: Record<string, unknown> = { source_card_id, target_card_id, edge_type };
    if (label) body.label = label;
    const data = await client.post(`/api/gant/strategic-plans/${strategic_plan_id}/edges`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Types ---

interface Plan {
  id: string;
  title: string;
  description?: string;
  status: string;
  progress: number;
  start_date?: string;
  due_date?: string;
  project_path?: string;
  tasks?: Task[];
  [key: string]: unknown;
}

interface Task {
  id: string;
  title: string;
  status: string;
  progress?: number;
  start_date?: string;
  end_date?: string;
  parent_task_id?: string | null;
  [key: string]: unknown;
}

// --- Start ---

async function main() {
  log(`Starting reen-mcp-server v0.1.0`);
  log(`API: ${baseUrl}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Connected via stdio");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
