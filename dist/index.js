#!/usr/bin/env node
/**
 * REEN MCP Server — нативные инструменты для AI-агентов.
 * Тонкая прослойка над REST API backend.reen.tech.
 *
 * Транспорт: stdio (стандарт для Claude Code, Cursor, Codex).
 * Авторизация: REEN_API_TOKEN env.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReenClient, log } from "./client.js";
// --- Config ---
const token = process.env.REEN_API_TOKEN;
if (!token) {
    process.stderr.write("Error: REEN_API_TOKEN environment variable is required.\n" +
        "Get your token at https://reen.tech → Settings → API Tokens.\n");
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
server.tool("whoami", "Get current authenticated user info (sanity check)", {}, async () => {
    const data = await client.get("/api/auth/me");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: list_plans
// =============================================
server.tool("list_plans", "List all Gantt plans. Returns summary by default (id, title, status, progress). Use detail_level='full' to include tasks.", {
    detail_level: z.enum(["summary", "full"]).optional().default("summary")
        .describe("'summary' = id+title+status+progress, 'full' = include tasks[]"),
}, async ({ detail_level }) => {
    const data = await client.get("/api/gant/plans");
    let result;
    if (detail_level === "summary") {
        result = data.plans.map((p) => ({
            id: p.id,
            title: p.title,
            status: p.status,
            progress: p.progress,
            project_path: p.project_path,
            task_count: p.tasks?.length ?? 0,
        }));
    }
    else {
        result = data.plans;
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
// =============================================
// Tool: get_plan
// =============================================
server.tool("get_plan", "Get a specific plan by ID with all tasks and subtasks", {
    plan_id: z.string().describe("Plan ID (e.g. 'argus-20260212-113911-6e2e82')"),
}, async ({ plan_id }) => {
    const data = await client.get("/api/gant/plans");
    const plan = data.plans.find((p) => p.id === plan_id);
    if (!plan) {
        return { content: [{ type: "text", text: `Plan '${plan_id}' not found` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
});
// =============================================
// Tool: create_plan
// =============================================
server.tool("create_plan", "Create a new Gantt plan", {
    title: z.string().describe("Plan title"),
    description: z.string().optional().describe("Plan description"),
    start_date: z.string().describe("Start date YYYY-MM-DD"),
    due_date: z.string().describe("Due date YYYY-MM-DD"),
    branch: z.string().optional().default("argus").describe("Branch name"),
}, async ({ title, description, start_date, due_date, branch }) => {
    const data = await client.post("/api/gant/plans", { title, description, start_date, due_date, branch });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: update_plan
// =============================================
server.tool("update_plan", "Update plan fields (title, description, status, progress)", {
    plan_id: z.string().describe("Plan ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["planned", "in-progress", "done", "blocked"]).optional().describe("New status"),
    progress: z.number().min(0).max(1).optional().describe("Progress 0.0-1.0"),
}, async ({ plan_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== undefined));
    const data = await client.patch(`/api/gant/plans/${plan_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: delete_plan
// =============================================
server.tool("delete_plan", "Delete a plan by ID", {
    plan_id: z.string().describe("Plan ID to delete"),
}, async ({ plan_id }) => {
    const data = await client.delete(`/api/gant/plans/${plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: create_task
// =============================================
server.tool("create_task", "Create a new top-level task (phase) in a plan", {
    plan_id: z.string().describe("Plan ID"),
    title: z.string().describe("Task title"),
    start_date: z.string().describe("Start date YYYY-MM-DD"),
    end_date: z.string().describe("End date YYYY-MM-DD"),
    status: z.enum(["planned", "in-progress", "done", "blocked"]).optional().default("planned"),
}, async (args) => {
    const data = await client.post("/api/gant/task", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: create_subtask
// =============================================
server.tool("create_subtask", "Create a subtask under an existing task", {
    plan_id: z.string().describe("Plan ID"),
    task_id: z.string().describe("Parent task ID"),
    title: z.string().describe("Subtask title"),
    start_date: z.string().describe("Start date YYYY-MM-DD"),
    end_date: z.string().describe("End date YYYY-MM-DD"),
    status: z.enum(["planned", "in-progress", "done", "blocked"]).optional().default("planned"),
    path: z.array(z.number()).optional().default([]).describe("Path to nested parent (e.g. [0, 2])"),
}, async (args) => {
    const data = await client.post("/api/gant/subtask", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: update_task
// =============================================
server.tool("update_task", "Update a task's title, status, description, or progress", {
    task_id: z.string().describe("Task ID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    status: z.enum(["planned", "in-progress", "done", "blocked"]).optional().describe("New status"),
    progress: z.number().min(0).max(1).optional().describe("Progress 0.0-1.0"),
}, async ({ task_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== undefined));
    const data = await client.patch(`/api/gant/tasks/${task_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: update_task_dates
// =============================================
server.tool("update_task_dates", "Update a task's start and/or due dates", {
    plan_id: z.string().describe("Plan ID"),
    task_id: z.string().describe("Task ID"),
    start_date: z.string().optional().describe("New start date YYYY-MM-DD"),
    due_date: z.string().optional().describe("New due date YYYY-MM-DD"),
}, async ({ plan_id, task_id, start_date, due_date }) => {
    // Бэкенд ожидает end_date, а не due_date
    const data = await client.patch("/api/gant/task/dates", { plan_id, task_id, start_date, end_date: due_date });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: delete_task
// =============================================
server.tool("delete_task", "Delete a task from a plan", {
    plan_id: z.string().describe("Plan ID"),
    task_id: z.string().describe("Task ID to delete"),
}, async (args) => {
    const data = await client.delete("/api/gant/task", args);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// =============================================
// Tool: get_plan_progress
// =============================================
server.tool("get_plan_progress", "Get progress for all tasks in a plan (bulk)", {
    plan_id: z.string().describe("Plan ID"),
}, async ({ plan_id }) => {
    const data = await client.get(`/api/gant/progress-bulk/${plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// --- Narrative tools ---
server.tool("get_narrative", "Get the narrative text content of a plan", {
    plan_id: z.string().describe("Plan ID"),
}, async ({ plan_id }) => {
    const data = await client.get(`/api/gant/plans/${plan_id}/narrative`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("update_narrative", "Update the narrative text content of a plan", {
    plan_id: z.string().describe("Plan ID"),
    narrative: z.string().describe("Narrative text (Markdown)"),
}, async ({ plan_id, narrative }) => {
    const data = await client.put(`/api/gant/plans/${plan_id}/narrative`, { narrative });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// --- Ex-Help tools ---
server.tool("list_exhelp", "List all Ex-Help requests for a plan", {
    plan_id: z.string().describe("Plan ID"),
}, async ({ plan_id }) => {
    const data = await client.get(`/api/gant/exhelp/${plan_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("create_exhelp", "Create a new Ex-Help request for a plan", {
    plan_id: z.string().describe("Plan ID"),
    title: z.string().optional().default("").describe("Request title"),
    problem: z.string().optional().default("").describe("Problem description (Markdown)"),
    initial_prompt: z.string().optional().describe("Initial system prompt for AI models analyzing this request"),
}, async ({ plan_id, title, problem, initial_prompt }) => {
    const body = { title, problem };
    if (initial_prompt)
        body.initial_prompt = initial_prompt;
    const data = await client.post(`/api/gant/exhelp/${plan_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("update_exhelp", "Update an Ex-Help request (title, problem, answer, status, initial_prompt)", {
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
}, async ({ exhelp_id, ...fields }) => {
    const body = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== undefined));
    const data = await client.patch(`/api/gant/exhelp/${exhelp_id}`, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("add_exhelp_answer", "Add or update an AI model's answer for an Ex-Help request", {
    exhelp_id: z.string().describe("Ex-Help request ID"),
    model_id: z.enum(["claude", "gpt", "gemini", "grok"]).describe("Model ID"),
    text: z.string().describe("Answer text (Markdown)"),
}, async ({ exhelp_id, model_id, text }) => {
    // Получаем текущие answers
    const current = await client.get(`/api/gant/exhelp/${exhelp_id}/pack?format=json`);
    let answers = [];
    const exhelp = current?.exhelp;
    const raw = exhelp?.answers;
    if (Array.isArray(raw))
        answers = raw;
    // Обновляем или добавляем ответ
    const entry = { model_id, text, created_at: new Date().toISOString() };
    const idx = answers.findIndex(a => a.model_id === model_id);
    if (idx >= 0)
        answers[idx] = entry;
    else
        answers.push(entry);
    const data = await client.patch(`/api/gant/exhelp/${exhelp_id}`, { answers });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("get_exhelp_pack", "Generate a context pack for an Ex-Help request (includes plan, tasks, files)", {
    exhelp_id: z.string().describe("Ex-Help request ID"),
    format: z.enum(["json", "md"]).optional().default("json").describe("Output format: json or md"),
}, async ({ exhelp_id, format }) => {
    const data = await client.get(`/api/gant/exhelp/${exhelp_id}/pack?format=${format}`);
    return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
});
server.tool("delete_exhelp", "Delete an Ex-Help request", {
    exhelp_id: z.string().describe("Ex-Help request ID to delete"),
}, async ({ exhelp_id }) => {
    const data = await client.delete(`/api/gant/exhelp/${exhelp_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("share_exhelp", "Generate a public share link for an Ex-Help request (7-day TTL, no auth required to view)", {
    exhelp_id: z.string().describe("Ex-Help request ID"),
}, async ({ exhelp_id }) => {
    const data = await client.post(`/api/gant/exhelp/${exhelp_id}/share`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("list_plan_files", "List files attached to a plan (filterable by context: narrative or exhelp)", {
    plan_id: z.string().describe("Plan ID"),
    context: z.enum(["narrative", "exhelp"]).optional().describe("Filter by context type"),
    exhelp_id: z.string().optional().describe("Filter by Ex-Help request ID (when context=exhelp)"),
}, async ({ plan_id, context, exhelp_id }) => {
    let path = `/api/gant/plans/${plan_id}/files`;
    const params = [];
    if (context)
        params.push(`context=${context}`);
    if (exhelp_id)
        params.push(`exhelp_id=${exhelp_id}`);
    if (params.length)
        path += `?${params.join("&")}`;
    const data = await client.get(path);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
// --- Conference tools ---
server.tool("list_conferences", "List all conferences for the current user", {}, async () => {
    const data = await client.get("/api/conferences");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("get_conference_initial_prompt", "Get the initial system prompt of a conference", {
    conference_id: z.string().describe("Conference ID"),
}, async ({ conference_id }) => {
    const data = await client.get(`/api/conferences/${conference_id}/initial-prompt`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("update_conference_initial_prompt", "Update the initial system prompt of a conference", {
    conference_id: z.string().describe("Conference ID"),
    initial_prompt: z.string().describe("New initial prompt text"),
}, async ({ conference_id, initial_prompt }) => {
    const data = await client.put(`/api/conferences/${conference_id}/initial-prompt`, { initial_prompt });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("create_conference", "Create a new AI conference for multi-model discussions", {
    title: z.string().describe("Conference title"),
    description: z.string().optional().describe("Conference description"),
}, async ({ title, description }) => {
    const data = await client.post("/api/conferences", { title, description });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("read_conference_messages", "Read recent messages from a conference (history + metadata)", {
    conference_id: z.string().describe("Conference ID"),
    limit: z.number().optional().default(50).describe("Number of recent messages to return (default 50)"),
}, async ({ conference_id, limit }) => {
    const data = await client.get(`/api/conferences/${conference_id}?limit=${limit}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("update_conference_agents", "Set active AI models for a conference. Valid models: claude, gpt, gemini, grok", {
    conference_id: z.string().describe("Conference ID"),
    agents: z.array(z.enum(["claude", "gpt", "gemini", "grok"])).max(4).describe("List of active model IDs"),
}, async ({ conference_id, agents }) => {
    const data = await client.put(`/api/conferences/${conference_id}/agents`, { agents });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
server.tool("send_conference_message", "Send a message to a conference. Use mentions to @mention other AI models (claude, gpt, gemini, grok) and trigger their response.", {
    conference_id: z.string().describe("Conference ID"),
    content: z.string().describe("Message text (supports @mentions like @claude, @gpt, @gemini, @all)"),
    author: z.string().optional().default("claude-code").describe("Author name displayed in chat"),
    mentions: z.array(z.string()).optional().default([]).describe("Explicit @mentions to route message (e.g. ['claude', 'gpt'])"),
}, async ({ conference_id, content, author, mentions }) => {
    const data = await client.post(`/api/conferences/${conference_id}/messages`, { content, author, mentions });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});
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
//# sourceMappingURL=index.js.map