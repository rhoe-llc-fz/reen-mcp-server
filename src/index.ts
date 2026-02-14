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
  },
  async ({ plan_id }) => {
    const data = await client.get<{ plans: Plan[] }>("/api/gant/plans");
    const plan = data.plans.find((p) => p.id === plan_id);
    if (!plan) {
      return { content: [{ type: "text", text: `Plan '${plan_id}' not found` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
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
    status: z.enum(["planned", "in-progress", "done", "blocked"]).optional().describe("New status"),
    progress: z.number().min(0).max(1).optional().describe("Progress 0.0-1.0"),
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
    status: z.enum(["planned", "in-progress", "done", "blocked"]).optional().default("planned"),
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
    status: z.enum(["planned", "in-progress", "done", "blocked"]).optional().default("planned"),
    path: z.array(z.number()).optional().default([]).describe("Path to nested parent (e.g. [0, 2])"),
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
    status: z.enum(["planned", "in-progress", "done", "blocked"]).optional().describe("New status"),
    progress: z.number().min(0).max(1).optional().describe("Progress 0.0-1.0"),
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
  async (args) => {
    const data = await client.patch("/api/gant/task/dates", args);
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
  },
  async ({ plan_id, title, problem }) => {
    const data = await client.post(`/api/gant/exhelp/${plan_id}`, { title, problem });
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
  project_path?: string;
  tasks?: Task[];
  [key: string]: unknown;
}

interface Task {
  id: string;
  title: string;
  status: string;
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
