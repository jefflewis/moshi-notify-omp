/**
 * Moshi Notify — Oh My Pi extension
 *
 * Bridges Oh My Pi lifecycle events to the Moshi API for iOS push
 * notifications and Live Activity updates.
 *
 * Quiet mode: only todo_write updates and critical messages are pushed.
 *
 * Events mapped:
 *   tool_call         → pre_tool / tool_running    (todo_write only)
 *   tool_result       → post_tool / tool_finished  (todo_write only)
 *   turn_end          → notification / approval    (only when assistant asks a question)
 *   auto_retry_start  → notification / error       (visible push)
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir, hostname } from "os";
import { basename } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN_PATH = `${homedir()}/.config/moshi/token`;
const API_URL = "https://api.getmoshi.app/api/v1/agent-events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventType =
	| "pre_tool"
	| "post_tool"
	| "notification"
	| "stop";

type Category =
	| "approval_required"
	| "task_complete"
	| "tool_running"
	| "tool_finished"
	| "info"
	| "error";

interface AgentEvent {
	source: "claude";
	eventType: EventType;
	sessionId: string;
	category: Category;
	title: string;
	message: string;
	eventId: string;
	projectName?: string;
	modelName?: string;
	toolName?: string;
	contextPercent?: number;
	host?: string;
}

interface TodoPhase {
	name: string;
	tasks: Array<{ content: string; status: string }>;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

async function loadToken(): Promise<string | null> {
	try {
		const file = Bun.file(TOKEN_PATH);
		const text = await file.text();
		return text.trim() || null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function sendEvent(token: string, event: AgentEvent): Promise<void> {
	const body = JSON.stringify(event);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await fetch(API_URL, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(5_000),
			});
			if (res.ok || res.status < 500) return;
		} catch {
			if (attempt > 0) return;
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(value: string | undefined, max = 240): string {
	if (!value) return "";
	const text = value.trim().replace(/\s+/g, " ");
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}...`;
}

// ---------------------------------------------------------------------------
// Todo state extraction
// ---------------------------------------------------------------------------

function extractTodoState(result: unknown): { currentTask: string; phase: string; progress: string } | null {
	const r = result as {
		details?: {
			phases?: TodoPhase[];
		};
	} | undefined;

	const phases = r?.details?.phases;
	if (!phases || phases.length === 0) return null;

	for (const phase of phases) {
		const inProgress = phase.tasks.find((t) => t.status === "in_progress");
		if (inProgress) {
			const total = phase.tasks.length;
			const done = phase.tasks.filter((t) => t.status === "completed").length;
			return {
				currentTask: inProgress.content,
				phase: phase.name,
				progress: `${done}/${total}`,
			};
		}
	}

	const lastPhase = phases[phases.length - 1];
	if (!lastPhase) return null;
	const total = lastPhase.tasks.length;
	const done = lastPhase.tasks.filter((t) => t.status === "completed").length;
	if (done === total && total > 0) {
		return {
			currentTask: "All tasks complete",
			phase: lastPhase.name,
			progress: `${done}/${total}`,
		};
	}

	return null;
}

// ---------------------------------------------------------------------------
// Question detection
// ---------------------------------------------------------------------------

function isAskingForInput(message: string): boolean {
	const normalized = message.trim().replace(/\s+/g, " ");
	if (!normalized) return false;

	// Explicit approval / confirmation phrases
	if (/^(may|can|should|shall) i\b/i.test(normalized)) return true;
	if (/^(would|do) you (like|want) me to\b/i.test(normalized)) return true;
	if (/^(which|what|where|when|who|how)\b/i.test(normalized) && normalized.endsWith("?")) return true;
	if (/please (confirm|approve|verify)/i.test(normalized)) return true;
	if (/want me to proceed/i.test(normalized)) return true;
	if (/need your (input|approval|confirmation)/i.test(normalized)) return true;

	// Short trailing question (assistant genuinely asking something)
	const lastSentence = normalized.split(/[.!]\s+/).pop() ?? "";
	return lastSentence.endsWith("?") && lastSentence.length <= 200;
}

// ---------------------------------------------------------------------------
// Tmux context
// ---------------------------------------------------------------------------

let cachedTmuxContext: string | undefined;

function getTmuxContext(): string | undefined {
	if (cachedTmuxContext !== undefined) return cachedTmuxContext || undefined;

	if (!process.env.TMUX) {
		cachedTmuxContext = "";
		return undefined;
	}

	try {
		const proc = Bun.spawnSync(["tmux", "display-message", "-p", "#S:#W"]);
		if (proc.exitCode === 0) {
			const text = new TextDecoder().decode(proc.stdout).trim();
			cachedTmuxContext = text || "";
			return text || undefined;
		}
	} catch {
		// tmux not available
	}

	cachedTmuxContext = "";
	return undefined;
}

function buildTitle(base: string, tmuxContext?: string): string {
	const parts: string[] = [];
	if (tmuxContext) parts.push(tmuxContext);
	parts.push(base);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function moshiNotify(pi: ExtensionAPI) {
	let token: string | null = null;
	let lastAssistantMessage = "";

	async function getToken(): Promise<string | null> {
		if (token) return token;
		token = await loadToken();
		return token;
	}

	function buildEvent(
		ctx: {
			cwd: string;
			sessionManager: { getSessionId(): string };
			model?: string | { id?: string; name?: string };
			getContextUsage?(): { percent: number | null } | undefined;
		},
		eventType: EventType,
		category: Category,
		title: string,
		message: string,
		toolName?: string,
	): AgentEvent {
		const sessionId = ctx.sessionManager.getSessionId();
		const projectName = basename(ctx.cwd);
		const modelName =
			typeof ctx.model === "string"
				? ctx.model
				: ctx.model?.id ?? ctx.model?.name;
		const contextPercent = ctx.getContextUsage?.()?.percent ?? undefined;

		return {
			source: "claude",
			eventType,
			sessionId,
			category,
			title,
			message,
			eventId: crypto.randomUUID(),
			projectName,
			modelName,
			toolName,
			contextPercent: contextPercent ?? undefined,
			host: hostname(),
		};
	}

	async function dispatch(
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
		eventType: EventType,
		category: Category,
		title: string,
		message: string,
		toolName?: string,
	) {
		const t = await getToken();
		if (!t) return;

		const event = buildEvent(
			{
				cwd: ctx.cwd,
				sessionManager: ctx.sessionManager,
				model: ctx.model,
				getContextUsage: ctx.getContextUsage,
			},
			eventType,
			category,
			title,
			message,
			toolName,
		);

		await sendEvent(t, event);
	}

	// --- Capture assistant messages for question detection -------------------

	pi.on("message_end", async (event, _ctx) => {
		const msg = event.message as { role?: string; content?: Array<{ type: string; text?: string }> | string } | undefined;
		if (!msg || msg.role !== "assistant") return;

		let text = "";
		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = msg.content
				.filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join(" ");
		}

		lastAssistantMessage = text.trim();
	});

	// --- Turn end → only when assistant is asking for input -----------------

	pi.on("turn_end", async (_event, ctx) => {
		if (!lastAssistantMessage || !isAskingForInput(lastAssistantMessage)) {
			lastAssistantMessage = "";
			return;
		}

		await dispatch(
			ctx,
			"notification",
			"approval_required",
			buildTitle("Waiting for Reply", getTmuxContext()),
			truncate(lastAssistantMessage, 240),
		);

		lastAssistantMessage = "";
	});

	// --- Tool call → todo_write only ----------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "todo_write") return;

		await dispatch(
			ctx,
			"pre_tool",
			"tool_running",
			buildTitle("Updating tasks", getTmuxContext()),
			"Updating task list",
			event.toolName,
		);
	});

	// --- Tool result → todo_write only --------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "todo_write") return;

		if (event.isError) {
			const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
			const errorText = result?.content?.find((c) => c.type === "text")?.text ?? "Error updating tasks";
			await dispatch(
				ctx,
				"post_tool",
				"error",
				buildTitle("Task Update Failed", getTmuxContext()),
				truncate(errorText, 200),
				event.toolName,
			);
			return;
		}

		const todo = extractTodoState(event.result);
		if (todo) {
			await dispatch(
				ctx,
				"notification",
				"info",
				buildTitle(`${todo.phase} · ${todo.progress}`, getTmuxContext()),
				todo.currentTask,
				event.toolName,
			);
		}
	});

	// --- Auto retry → visible push ------------------------------------------

	pi.on("auto_retry_start", async (event, ctx) => {
		const attemptMsg = event.attempt > 1 ? ` (attempt ${event.attempt}/${event.maxAttempts})` : "";
		await dispatch(
			ctx,
			"notification",
			"error",
			buildTitle("Retrying", getTmuxContext()),
			`The agent is retrying after an error${attemptMsg}`,
		);
	});
}
