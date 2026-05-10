/**
 * Moshi Notify — Oh My Pi extension
 *
 * Bridges Oh My Pi lifecycle events to the Moshi API for iOS push
 * notifications and Live Activity updates.
 *
 * Events mapped:
 *   agent_start       → notification / info                    (visible push)
 *   turn_end          → stop / task_complete                   (visible push, filtered)
 *   tool_call         → pre_tool / tool_running                (silent Live Activity, todo only)
 *   tool_result       → post_tool / tool_finished              (silent Live Activity, todo only)
 *   auto_retry_start  → notification / error                   (visible push)
 *   agent_end         → stop / task_complete                   (visible push)
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir, hostname } from "os";
import { basename } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN_PATH = `${homedir()}/.config/moshi/token`;
const API_URL = "https://api.getmoshi.app/api/v1/agent-events";
const STOP_COOLDOWN_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventType =
	| "user_prompt"
	| "pre_tool"
	| "post_tool"
	| "notification"
	| "stop"
	| "agent_turn_complete";

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

interface SessionState {
	modelName?: string;
	lastToolName?: string;
	lastToolSummary?: string;
	lastMessage?: string;
	turnCount: number;
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

function summarizeToolInput(
	toolName: string,
	input: Record<string, unknown> | undefined,
): string {
	if (!input) return "";

	function pick(...keys: string[]): string {
		for (const key of keys) {
			const v = input[key];
			if (v != null) return String(v);
		}
		return "";
	}

	if (toolName === "bash") return pick("command", "cmd").slice(0, 200);
	if (toolName === "read") return pick("file_path", "filePath", "path", "file").slice(0, 200);
	if (toolName === "edit" || toolName === "write")
		return pick("file_path", "filePath", "path", "file").slice(0, 200);
	if (toolName === "search" || toolName === "grep")
		return pick("query", "pattern", "q").slice(0, 200);
	if (toolName === "find" || toolName === "glob")
		return pick("pattern", "query", "path").slice(0, 200);
	if (toolName === "web_fetch") return pick("url", "uri").slice(0, 200);
	if (toolName === "web_search") return pick("query", "q", "url").slice(0, 200);
	if (toolName === "task")
		return pick("description", "prompt", "task").slice(0, 200);
	if (toolName === "ast_edit")
		return pick("file_path", "filePath", "path", "file").slice(0, 200);
	if (toolName === "notebook")
		return pick("notebook_path", "notebookPath", "path").slice(0, 200);
	if (toolName === "ask")
		return pick("question", "message", "q").slice(0, 200);
	if (toolName === "todo_write") return "Updating task list";
	return "";
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
// Noteworthy filter
// ---------------------------------------------------------------------------

function isNoteworthyMessage(message: string): boolean {
	const lower = message.toLowerCase();

	if (message.includes("?")) return true;

	const approvalPhrases = [
		"should i", "shall i", "may i", "can i", "do you want me to",
		"would you like", "is it okay", "is that okay", "are you okay",
		"approve", "confirmation", "confirm", "let me know if",
		"what do you think", "your thoughts", "your preference",
		"want me to proceed", "okay to", "alright to", "proceed with",
		"go ahead", "need your input", "need your approval",
		"how would you like", "which would you prefer",
	];
	if (approvalPhrases.some((p) => lower.includes(p))) return true;

	const noticePhrases = [
		"error", "failed", "failure", "critical", "warning", "issue",
		"problem", "blocked", "stuck", "unable to", "could not",
		"did not", "unexpected", "exception", "timeout", "refused",
		"not found", "missing", "requires attention", "needs attention",
		"important notice", "breaking change", "incident",
	];
	if (noticePhrases.some((p) => lower.includes(p))) return true;

	return false;
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
		// tmux not available or command failed
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

function buildCompletionMessage(state: SessionState, contextPercent?: number): string {
	const parts: string[] = [];

	if (state.lastMessage) {
		parts.push(truncate(state.lastMessage, 200));
	}

	if (state.lastToolName) {
		const detail = state.lastToolSummary || "";
		const verb =
			state.lastToolName === "edit" || state.lastToolName === "write" || state.lastToolName === "ast_edit"
				? "Updated"
				: state.lastToolName === "read"
					? "Read"
					: state.lastToolName === "bash"
						? "Ran"
						: state.lastToolName === "search" || state.lastToolName === "grep" || state.lastToolName === "find" || state.lastToolName === "glob"
							? "Searched"
							: state.lastToolName === "web_fetch"
								? "Fetched"
								: state.lastToolName === "web_search"
									? "Searched"
									: state.lastToolName === "task"
										? "Delegated"
										: "Used";
		const target = detail ? ` ${detail}` : "";
		parts.push(`${verb}${target}`);
	}

	if (!parts.length) {
		parts.push(`Turn ${state.turnCount} complete`);
	}

	if (contextPercent != null && contextPercent >= 80) {
		parts.push(`Context at ${contextPercent}%`);
	}

	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function moshiNotify(pi: ExtensionAPI) {
	let token: string | null = null;
	let lastStopTime = 0;

	const sessionStates = new Map<string, SessionState>();

	function getState(sessionId: string): SessionState {
		let state = sessionStates.get(sessionId);
		if (!state) {
			state = { turnCount: 0 };
			sessionStates.set(sessionId, state);
		}
		return state;
	}

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

	// --- Agent start → visible push with model info --------------------------

	pi.on("agent_start", async (_event, ctx) => {
		const state = getState(ctx.sessionManager.getSessionId());
		state.turnCount = 0;
		state.lastToolName = undefined;
		state.lastToolSummary = undefined;
		state.lastMessage = undefined;

		const model = typeof ctx.model === "string" ? ctx.model : ctx.model?.id ?? ctx.model?.name;
		if (model) state.modelName = model;

		await dispatch(
			ctx,
			"notification",
			"info",
			buildTitle("Agent Started", getTmuxContext()),
			`Working in ${basename(ctx.cwd)}`,
		);
	});

	// --- Capture assistant messages for richer completion messages -----------

	pi.on("message_end", async (event, ctx) => {
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

		if (text.trim()) {
			const state = getState(ctx.sessionManager.getSessionId());
			state.lastMessage = text.trim();
		}
	});

	// --- Turn end → visible push notification (filtered) ---------------------

	pi.on("turn_end", async (_event, ctx) => {
		const now = Date.now();
		if (now - lastStopTime < STOP_COOLDOWN_MS) return;
		lastStopTime = now;

		const sessionId = ctx.sessionManager.getSessionId();
		const state = getState(sessionId);
		const contextPercent = ctx.getContextUsage?.()?.percent ?? undefined;

		// Only notify on turn end when something needs attention:
		// the assistant asked a question, requested approval, or flagged an issue.
		if (!state.lastMessage || !isNoteworthyMessage(state.lastMessage)) {
			state.lastToolName = undefined;
			state.lastToolSummary = undefined;
			state.lastMessage = undefined;
			return;
		}

		let titleBase: string;
		if (state.lastToolName) {
			titleBase = `Done · ${state.lastToolName}`;
		} else if (state.lastMessage) {
			titleBase = "Reply Ready";
		} else {
			titleBase = `Turn ${state.turnCount} done`;
		}

		await dispatch(
			ctx,
			"stop",
			"task_complete",
			buildTitle(titleBase, getTmuxContext()),
			buildCompletionMessage(state, contextPercent ?? undefined),
		);

		state.lastToolName = undefined;
		state.lastToolSummary = undefined;
		state.lastMessage = undefined;
	});

	// --- Tool call → silent Live Activity (todo only) -----------------------

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "todo_write") return;

		const summary = summarizeToolInput(event.toolName, event.input);
		const state = getState(ctx.sessionManager.getSessionId());
		state.lastToolName = event.toolName;
		state.lastToolSummary = summary;

		await dispatch(
			ctx,
			"pre_tool",
			"tool_running",
			buildTitle("Updating tasks", getTmuxContext()),
			summary,
			event.toolName,
		);
	});

	// --- Tool result → silent Live Activity (todo only) ---------------------

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "todo_write") return;

		const state = getState(ctx.sessionManager.getSessionId());

		if (event.isError) {
			const result = event.result as { content?: Array<{ type: string; text?: string }>; details?: unknown } | undefined;
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
		const state = getState(ctx.sessionManager.getSessionId());
		const attemptMsg = event.attempt > 1 ? ` (attempt ${event.attempt}/${event.maxAttempts})` : "";
		await dispatch(
			ctx,
			"notification",
			"error",
			buildTitle("Retrying", getTmuxContext()),
			`The agent is retrying after an error${attemptMsg}`,
		);
	});

	// --- Agent end → visible push with summary ------------------------------

	pi.on("agent_end", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const state = getState(sessionId);
		const contextPercent = ctx.getContextUsage?.()?.percent ?? undefined;

		let titleBase: string;
		if (state.lastToolName) {
			titleBase = `Finished · ${state.lastToolName}`;
		} else if (state.lastMessage) {
			titleBase = "All Done";
		} else {
			titleBase = "Finished";
		}

		await dispatch(
			ctx,
			"stop",
			"task_complete",
			buildTitle(titleBase, getTmuxContext()),
			buildCompletionMessage(state, contextPercent ?? undefined),
		);

		sessionStates.delete(sessionId);
	});
}
