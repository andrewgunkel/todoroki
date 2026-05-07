import { Project } from "./projects.js";
import { Todo } from "./todo.js";
import { createTodoForm } from "./todo-form.js";
import { supabase, signOut } from "./auth.js";

const todoContainer = document.querySelector("#app");
const formContainer = document.querySelector("#form-container");
const addTodoBtn = document.querySelector("#add-todo-btn");
const sidebar = document.querySelector("#sidebar");
const projectTitle = document.querySelector("#project-title");
const projectCodeBadge = document.querySelector("#project-code-badge");
// themeToggleBtn removed — dark mode now lives in the settings popup
const sortBarContainer = document.querySelector("#sort-bar-container");
const sidebarToggleBtn = document.querySelector("#sidebar-toggle-btn");
const sidebarBackdrop = document.querySelector("#sidebar-backdrop");
const selectionBarContainer = document.querySelector("#selection-bar-container");
const projectTabsContainer = document.querySelector("#project-tabs-container");

sidebarToggleBtn.addEventListener("click", () => {
	sidebar.classList.toggle("open");
	sidebarBackdrop.classList.toggle("visible");
});

sidebarBackdrop.addEventListener("click", () => {
	sidebar.classList.remove("open");
	sidebarBackdrop.classList.remove("visible");
});

/* ======================
   STATE
====================== */

const projects = [];
let currentProjectId = null;
let currentView = "project"; // "project" | "inbox"
let currentProjectTab = "board"; // "board" | "resources"
let inbox = [];

window.projects = projects;

let sortBy = "default"; // default | priority | createdAt | updatedAt | dueDate
let sortDir = "asc"; // asc | desc

let currentUser = null;

let selectedTodos = new Set(); // set of todo IDs currently selected
let dragState = null; // { todoIds, source: "project"|"inbox", projectId }
let touchDrag = null;

let undoTimer = null;
let undoToastEl = null;
let selectionOverlay = null;

let epicFilterIds = new Set(); // empty = show all
let lastEpicFilterProjectId = null;
let stackToolFilter = null; // null = show all, string = tool ID to filter by
let todoTagFilter = null; // null = show all, string = tag to filter by
let searchQuery = ""; // global search across todos and notes
let dragHoverTimer = null;
let syncTimer = null;
let overviewTab = "dashboard"; // "dashboard" | "notes"
let lastRemoteSync = 0; // timestamp of the last successful pull from Supabase

// Cross-device user preferences — loaded from Supabase after auth
let userPrefs = { theme: "light", avatarColor: null, displayName: "", generalNotes: [] };

function showColumnDeleteModal(col) {
	const others = columns.filter(c => c.id !== col.id);

	const overlay = document.createElement("div");
	overlay.classList.add("modal-overlay");

	const modal = document.createElement("div");
	modal.classList.add("modal-card");

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("modal-close-btn");
	closeBtn.title = "Cancel";
	closeBtn.addEventListener("click", () => overlay.remove());

	const title = document.createElement("h2");
	title.classList.add("modal-title");
	title.textContent = `You are deleting "${col.label}"`;

	const body = document.createElement("p");
	body.classList.add("modal-body");
	body.textContent = "Do you want to move related todos to another column?";

	const select = document.createElement("select");
	select.classList.add("modal-select");
	others.forEach(c => {
		const opt = document.createElement("option");
		opt.value = c.id;
		opt.textContent = c.label;
		select.appendChild(opt);
	});

	const moveBtn = document.createElement("button");
	moveBtn.classList.add("modal-btn-primary");
	moveBtn.textContent = "Move todos and delete column";
	moveBtn.addEventListener("click", () => {
		const targetId = select.value;
		const target = columns.find(c => c.id === targetId);
		const colIndex = columns.findIndex(c => c.id === col.id);
		const affected = [];
		projects.forEach(p => p.todos.forEach(t => {
			if (t.status === col.label) affected.push({ todo: t, project: p });
		}));
		projects.forEach(p => p.todos.forEach(t => {
			if (t.status === col.label) t.status = target.label;
		}));
		columns = columns.filter(c => c.id !== col.id);
		saveColumns();
		saveProjects();
		renderTodos();
		overlay.remove();
		showUndoToast("Column deleted", () => {
			columns.splice(colIndex, 0, col);
			affected.forEach(({ todo }) => { todo.status = col.label; });
			saveColumns();
			saveProjects();
			renderTodos();
		});
	});

	const deleteAllBtn = document.createElement("button");
	deleteAllBtn.classList.add("modal-btn-secondary");
	deleteAllBtn.textContent = `Delete "${col.label}" and cards`;
	deleteAllBtn.addEventListener("click", () => {
		const colIndex = columns.findIndex(c => c.id === col.id);
		const removed = [];
		projects.forEach(p => {
			const before = [...p.todos];
			p.todos = p.todos.filter(t => t.status !== col.label);
			before.forEach((t, i) => {
				if (t.status === col.label) removed.push({ todo: t, project: p, index: i });
			});
		});
		columns = columns.filter(c => c.id !== col.id);
		saveColumns();
		saveProjects();
		renderTodos();
		overlay.remove();
		showUndoToast("Column deleted", () => {
			columns.splice(colIndex, 0, col);
			removed.forEach(({ todo, project, index }) => project.todos.splice(index, 0, todo));
			saveColumns();
			saveProjects();
			renderTodos();
		});
	});

	const btnRow = document.createElement("div");
	btnRow.classList.add("modal-btn-row");
	btnRow.appendChild(moveBtn);
	btnRow.appendChild(deleteAllBtn);

	modal.appendChild(closeBtn);
	modal.appendChild(title);
	modal.appendChild(body);
	modal.appendChild(select);
	modal.appendChild(btnRow);
	overlay.appendChild(modal);
	document.body.appendChild(overlay);
}

function showEpicDeleteModal(epicId, project) {
	const epic = project.epics.find(e => e.id === epicId);
	if (!epic) return;
	const otherEpics = project.epics.filter(e => e.id !== epicId);
	const epicCards = project.todos.filter(t => t.epicId === epicId);

	const overlay = document.createElement("div");
	overlay.classList.add("modal-overlay");

	const modal = document.createElement("div");
	modal.classList.add("modal-card");

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("modal-close-btn");
	closeBtn.addEventListener("click", () => overlay.remove());

	const title = document.createElement("h2");
	title.classList.add("modal-title");
	title.textContent = `You are deleting "${epic.title}"`;

	const body = document.createElement("p");
	body.classList.add("modal-body");
	body.textContent = epicCards.length
		? "What should happen to the cards in this epic?"
		: "This epic has no cards.";

	// Destination select (only shown if there are cards)
	const select = document.createElement("select");
	select.classList.add("modal-select");

	const noEpicOpt = document.createElement("option");
	noEpicOpt.value = "";
	noEpicOpt.textContent = "No Epic";
	select.appendChild(noEpicOpt);

	otherEpics.forEach(e => {
		const opt = document.createElement("option");
		opt.value = e.id;
		opt.textContent = e.title;
		select.appendChild(opt);
	});

	// Move + delete
	const moveBtn = document.createElement("button");
	moveBtn.classList.add("modal-btn-primary");
	moveBtn.textContent = epicCards.length ? "Move cards and delete epic" : "Delete epic";
	moveBtn.addEventListener("click", () => {
		const targetEpicId = select.value || null;
		const epicIndex = project.epics.findIndex(e => e.id === epicId);
		const savedCards = epicCards.map(t => ({ todo: t, prev: t.epicId }));

		epicCards.forEach(t => { t.epicId = targetEpicId; });
		project.epics = project.epics.filter(e => e.id !== epicId);
		saveProjects();
		renderTodos();
		overlay.remove();

		showUndoToast("Epic deleted", () => {
			savedCards.forEach(({ todo, prev }) => { todo.epicId = prev; });
			project.epics.splice(epicIndex, 0, epic);
			saveProjects();
			renderTodos();
		});
	});

	// Delete all cards + epic
	const deleteAllBtn = document.createElement("button");
	deleteAllBtn.classList.add("modal-btn-secondary");
	deleteAllBtn.textContent = `Delete epic and its ${epicCards.length} card${epicCards.length !== 1 ? "s" : ""}`;
	deleteAllBtn.addEventListener("click", () => {
		const epicIndex = project.epics.findIndex(e => e.id === epicId);
		const removedCards = epicCards.map(t => ({ todo: t, index: project.todos.indexOf(t) }));

		project.todos = project.todos.filter(t => t.epicId !== epicId);
		project.epics = project.epics.filter(e => e.id !== epicId);
		saveProjects();
		renderTodos();
		overlay.remove();

		showUndoToast("Epic and cards deleted", () => {
			removedCards.sort((a, b) => a.index - b.index)
				.forEach(({ todo, index }) => project.todos.splice(index, 0, todo));
			project.epics.splice(epicIndex, 0, epic);
			saveProjects();
			renderTodos();
		});
	});

	const btnRow = document.createElement("div");
	btnRow.classList.add("modal-btn-row");
	btnRow.appendChild(moveBtn);
	if (epicCards.length > 0) btnRow.appendChild(deleteAllBtn);

	modal.appendChild(closeBtn);
	modal.appendChild(title);
	modal.appendChild(body);
	if (epicCards.length > 0) modal.appendChild(select);
	modal.appendChild(btnRow);
	overlay.appendChild(modal);
	document.body.appendChild(overlay);
}

function showUndoToast(titleText, onUndo) {
	if (undoTimer) clearTimeout(undoTimer);
	if (undoToastEl) undoToastEl.remove();

	const toast = document.createElement("div");
	toast.classList.add("undo-toast");
	undoToastEl = toast;

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("undo-toast-close");
	closeBtn.title = "Dismiss";

	const title = document.createElement("h2");
	title.classList.add("undo-toast-title");
	title.textContent = titleText;

	const undoBtn = document.createElement("button");
	undoBtn.classList.add("undo-toast-btn");
	undoBtn.textContent = "Undo";

	function dismiss() {
		clearTimeout(undoTimer);
		toast.classList.remove("visible");
		toast.addEventListener("transitionend", () => toast.remove(), { once: true });
		undoToastEl = null;
	}

	closeBtn.addEventListener("click", dismiss);

	undoBtn.addEventListener("click", () => {
		onUndo();
		dismiss();
	});

	toast.appendChild(closeBtn);
	toast.appendChild(title);
	toast.appendChild(undoBtn);
	document.body.appendChild(toast);

	requestAnimationFrame(() => {
		requestAnimationFrame(() => toast.classList.add("visible"));
	});

	undoTimer = setTimeout(dismiss, 10000);
}

let columns = [
	{ id: "col-1", label: "Not Started", isCompleted: false, color: "#6b7280" },
	{ id: "col-2", label: "In Progress", isCompleted: false, color: "#1a73e8" },
	{ id: "col-3", label: "Completed",   isCompleted: true,  color: "#188038" },
];

/* ======================
   STORAGE  (Supabase-backed, fire-and-forget)
====================== */

// Debounced entry points — all 80+ call sites remain unchanged
function saveProjects() {
	if (!currentUser) return;
	clearTimeout(syncTimer);
	syncTimer = setTimeout(syncAllToSupabase, 400);
}

function saveInbox() {
	if (!currentUser) return;
	clearTimeout(syncTimer);
	syncTimer = setTimeout(syncAllToSupabase, 400);
}

function saveColumns() {
	if (!currentUser) return;
	syncColumnsToSupabase();
}

// ── User preferences (theme / avatarColor / displayName) ──

async function loadUserPrefs() {
	const { data } = await supabase
		.from("user_preferences")
		.select("*")
		.eq("user_id", currentUser.id)
		.maybeSingle();

	if (data) {
		userPrefs.theme = data.theme || "light";
		userPrefs.avatarColor = data.avatar_color || null;
		userPrefs.displayName = data.display_name || "";
		userPrefs.generalNotes = data.general_notes || [];
	} else {
		// First login on this device — migrate from localStorage then save
		const localTheme = localStorage.getItem("theme");
		const localColor = localStorage.getItem("userAvatarColor");
		const localName  = localStorage.getItem("userDisplayName");
		if (localTheme) userPrefs.theme = localTheme;
		if (localColor) userPrefs.avatarColor = localColor;
		if (localName)  userPrefs.displayName = localName;
		await saveUserPrefs();
	}
}

async function saveUserPrefs() {
	if (!currentUser) return;
	try {
		let { error } = await supabase.from("user_preferences").upsert(
			{
				user_id:       currentUser.id,
				theme:         userPrefs.theme,
				avatar_color:  userPrefs.avatarColor,
				display_name:  userPrefs.displayName,
				general_notes: userPrefs.generalNotes,
				updated_at:    new Date().toISOString(),
			},
			{ onConflict: "user_id" }
		);
		if (error && error.code === "42703") {
			// general_notes column not yet migrated — retry without it
			({ error } = await supabase.from("user_preferences").upsert(
				{
					user_id:      currentUser.id,
					theme:        userPrefs.theme,
					avatar_color: userPrefs.avatarColor,
					display_name: userPrefs.displayName,
					updated_at:   new Date().toISOString(),
				},
				{ onConflict: "user_id" }
			));
		}
		if (error) throw error;
	} catch (err) {
		console.error("Supabase prefs sync error:", err);
	}
}

// ── Helpers ────────────────────────────────────────────────

function renumberProjectTodos(project) {
	const sorted = [...project.todos].sort((a, b) => (a.number || 0) - (b.number || 0));
	sorted.forEach((t, i) => { t.number = i + 1; });
	project.todoCounter = sorted.length;
}

function generateProjectCode(title) {
	const clean = title.replace(/[^a-zA-Z0-9 ]/g, "").toUpperCase();
	const words = clean.split(/\s+/).filter(Boolean);
	if (words.length >= 2) {
		return words.slice(0, 3).map(w => w[0]).join("").padEnd(3, "X").slice(0, 3);
	}
	return (words[0] || "PRJ").slice(0, 3).padEnd(3, "X");
}

function defaultProjectTabs() {
	return [
		{ id: "board",     type: "board",     label: "Board" },
		{ id: "resources", type: "resources", label: "Resources" },
	];
}

function buildProjectRow(project, index) {
	return {
		id:               project.id,
		user_id:          currentUser.id,
		title:            project.title,
		description:      project.description || "",
		sort_order:       index,
		epics:            project.epics || [],
		resources:        project.resources || { notes: "" },
		no_epic_collapsed: project.noEpicCollapsed || false,
		code:             project.code || "",
		todo_counter:     project.todoCounter || 0,
		tabs:             project.tabs || defaultProjectTabs(),
		notes:            project.notes || [],
		tools:            project.tools || [],
	};
}

function buildTodoRow(todo, projectId, index) {
	return {
		id:             todo.id,
		user_id:        currentUser.id,
		project_id:     projectId,
		title:          todo.title,
		description:    todo.description || "",
		due_date:       todo.dueDate || "",
		priority:       todo.priority || "Low",
		notes:          todo.notes || "",
		checklist:      todo.checklist || [],
		reference_link: todo.referenceLink || "",
		status:         todo.status || "",
		epic_id:        todo.epicId || null,
		sort_order:     index,
		created_at:     todo.createdAt || Date.now(),
		updated_at:     todo.updatedAt || Date.now(),
		number:         todo.number || 0,
		tool_ids:       todo.toolIds || [],
		tags:           todo.tags || [],
	};
}

// ── Sync status indicator ─────────────────────────────────
let syncDot = null;

function getSyncDot() {
	if (!syncDot) {
		syncDot = document.createElement("span");
		syncDot.id = "sync-dot";
		syncDot.title = "Sync status";
		document.querySelector("#header-actions")?.prepend(syncDot);
	}
	return syncDot;
}

function setSyncStatus(status) { // "syncing" | "ok" | "error"
	const dot = getSyncDot();
	dot.className = `sync-dot sync-dot--${status}`;
	dot.title = status === "syncing" ? "Saving…" : status === "error" ? "Sync error — check console" : "Saved";
}

function isMissingColumnError(err) {
	return (
		err?.code === "42703"     ||   // PostgreSQL: undefined_column
		err?.code === "PGRST204"  ||   // PostgREST: column not found on table
		err?.message?.toLowerCase().includes("does not exist")
	);
}

// ── Full sync (projects + all todos + inbox) ───────────────

async function syncAllToSupabase() {
	if (!currentUser) return;
	const uid = currentUser.id;
	setSyncStatus("syncing");
	let hadError = false;

	// 1. Upsert all projects (with fallback for un-migrated columns)
	try {
		const projectRows = projects.map((p, i) => buildProjectRow(p, i));
		if (projectRows.length > 0) {
			let { error } = await supabase.from("projects").upsert(projectRows, { onConflict: "id" });
			if (error && isMissingColumnError(error)) {
				// Strip columns that require migrations and retry with base columns only
				const safeRows = projectRows.map(({ code, todo_counter, tabs, notes, tools, ...rest }) => rest);
				({ error } = await supabase.from("projects").upsert(safeRows, { onConflict: "id" }));
			}
			if (error) throw error;
		}
		// Remove deleted projects
		const keepProjectIds = projectRows.map(p => p.id);
		if (keepProjectIds.length > 0) {
			await supabase.from("projects").delete()
				.eq("user_id", uid)
				.not("id", "in", `(${keepProjectIds.join(",")})`);
		} else {
			await supabase.from("projects").delete().eq("user_id", uid);
		}
	} catch (err) {
		console.error("Supabase projects sync error:", err);
		hadError = true;
	}

	// 2. Upsert all project todos (with graceful fallback for un-migrated columns)
	try {
		const todoRows = projects.flatMap((p) =>
			p.todos.map((t, i) => buildTodoRow(t, p.id, i))
		);
		if (todoRows.length > 0) {
			let { error } = await supabase.from("todos").upsert(todoRows, { onConflict: "id" });
			if (error && isMissingColumnError(error)) {
				// tags column not yet migrated — retry without it
				const safeRows = todoRows.map(({ tags, ...rest }) => rest);
				({ error } = await supabase.from("todos").upsert(safeRows, { onConflict: "id" }));
			}
			if (error) throw error;
		}
		// Remove deleted project todos
		const keepTodoIds = projects.flatMap(p => p.todos.map(t => t.id));
		if (keepTodoIds.length > 0) {
			await supabase.from("todos").delete()
				.eq("user_id", uid)
				.not("project_id", "is", null)
				.not("id", "in", `(${keepTodoIds.join(",")})`);
		} else {
			await supabase.from("todos").delete()
				.eq("user_id", uid)
				.not("project_id", "is", null);
		}
	} catch (err) {
		console.error("Supabase todos sync error:", err);
		hadError = true;
	}

	// 3. Upsert inbox todos
	try {
		const inboxRows = inbox.map((t, i) => buildTodoRow(t, null, i));
		if (inboxRows.length > 0) {
			let { error } = await supabase.from("todos").upsert(inboxRows, { onConflict: "id" });
			if (error && isMissingColumnError(error)) {
				const safeRows = inboxRows.map(({ tags, ...rest }) => rest);
				({ error } = await supabase.from("todos").upsert(safeRows, { onConflict: "id" }));
			}
			if (error) throw error;
		}
		// Remove deleted inbox todos
		const keepInboxIds = inbox.map(t => t.id);
		if (keepInboxIds.length > 0) {
			await supabase.from("todos").delete()
				.eq("user_id", uid)
				.is("project_id", null)
				.not("id", "in", `(${keepInboxIds.join(",")})`);
		} else {
			await supabase.from("todos").delete()
				.eq("user_id", uid)
				.is("project_id", null);
		}
	} catch (err) {
		console.error("Supabase inbox sync error:", err);
		hadError = true;
	}

	setSyncStatus(hadError ? "error" : "ok");
}

// ── Column config sync ─────────────────────────────────────

async function syncColumnsToSupabase() {
	if (!currentUser) return;
	try {
		const { error } = await supabase.from("user_columns").upsert(
			{ user_id: currentUser.id, data: columns, updated_at: new Date().toISOString() },
			{ onConflict: "user_id" }
		);
		if (error) throw error;
	} catch (err) {
		console.error("Supabase columns sync error:", err);
	}
}

// ── Load all data for the signed-in user ──────────────────

async function loadFromSupabase() {
	const uid = currentUser.id;

	// Columns
	const { data: colRow } = await supabase
		.from("user_columns")
		.select("data")
		.eq("user_id", uid)
		.maybeSingle();
	if (colRow?.data?.length) columns = colRow.data;

	// Projects (ordered)
	const { data: projectRows, error: pe } = await supabase
		.from("projects")
		.select("*")
		.eq("user_id", uid)
		.order("sort_order");
	if (pe) throw pe;

	// All todos for this user (ordered)
	const { data: todoRows, error: te } = await supabase
		.from("todos")
		.select("*")
		.eq("user_id", uid)
		.order("sort_order");
	if (te) throw te;

	// Reconstruct in-memory structure
	projects.length = 0;
	inbox.length = 0;

	(projectRows || []).forEach(row => {
		const project = Object.create(Project.prototype);
		Object.assign(project, {
			id:             row.id,
			title:          row.title,
			description:    row.description,
			sort_order:     row.sort_order,
			epics:          row.epics || [],
			resources:      row.resources || { notes: "" },
			noEpicCollapsed: row.no_epic_collapsed || false,
			code:           row.code || generateProjectCode(row.title),
			todoCounter:    row.todo_counter || 0,
			tabs:           (row.tabs && row.tabs.length) ? row.tabs : defaultProjectTabs(),
			notes:          row.notes || [],
			tools:          row.tools || [],
			todos:          [],
		});
		project.epics.forEach(e => { if (!e.extraColumns) e.extraColumns = []; });
		projects.push(project);
	});

	(todoRows || []).forEach(row => {
		const todo = {
			id:            row.id,
			title:         row.title,
			description:   row.description,
			dueDate:       row.due_date,
			priority:      row.priority,
			notes:         row.notes,
			checklist:     Array.isArray(row.checklist) ? row.checklist : [],
			referenceLink: row.reference_link,
			status:        row.status,
			epicId:        row.epic_id || null,
			number:        row.number || 0,
			toolIds:       Array.isArray(row.tool_ids) ? row.tool_ids : [],
			tags:          Array.isArray(row.tags) ? row.tags : [],
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
		if (row.project_id) {
			const project = projects.find(p => p.id === row.project_id);
			if (project) project.todos.push(todo);
		} else {
			inbox.push(todo);
		}
	});

	currentProjectId = projects[0]?.id ?? null;
	lastRemoteSync = Date.now();
}

// Pull fresh data from Supabase and re-render without disrupting the current view.
// Skips if a write is still pending (syncTimer is set) to avoid clobbering unsaved changes.
let reloading = false;
async function reloadFromSupabase() {
	if (!currentUser || reloading || syncTimer) return;
	reloading = true;
	const savedProjectId = currentProjectId;
	const savedView = currentView;
	const savedTab = currentProjectTab;
	try {
		await loadUserPrefs();
		await loadFromSupabase();
		// Restore view — loadFromSupabase resets currentProjectId to projects[0]
		if (savedView === "project" && projects.find(p => p.id === savedProjectId)) {
			currentProjectId = savedProjectId;
			currentProjectTab = savedTab;
		}
		currentView = savedView;
		renderProjects();
		renderTodos();
	} catch (err) {
		console.error("Failed to reload from Supabase:", err);
	} finally {
		reloading = false;
	}
}

// Reload when the tab becomes visible or the window gets focus (covers tab switching & alt-tab)
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible" && currentUser) reloadFromSupabase();
});
window.addEventListener("focus", () => {
	if (currentUser) reloadFromSupabase();
});

// Also poll every 30 seconds while the tab is active — ensures both devices stay in sync
// even when both are open and visible at the same time
setInterval(() => {
	if (document.visibilityState === "visible" && currentUser) reloadFromSupabase();
}, 30_000);

/* ======================
   INIT
====================== */

supabase.auth.getSession().then(async ({ data: { session } }) => {
	currentUser = session?.user ?? null;

	if (currentUser) {
		try {
			await loadUserPrefs();
			applyTheme(userPrefs.theme); // override the localStorage-cached theme
			await loadFromSupabase();
		} catch (err) {
			console.error("Failed to load data from Supabase:", err);
		}

		if (projects.length === 0) {
			const defaultProject = new Project("Default", "");
			defaultProject.epics       = [];
			defaultProject.resources   = { notes: "" };
			defaultProject.code        = "DEF";
			defaultProject.todoCounter = 0;
			defaultProject.tabs        = defaultProjectTabs();
			defaultProject.notes       = [];
			defaultProject.tools       = [];
			projects.push(defaultProject);
			currentProjectId = defaultProject.id;
			saveProjects();
		}
	}

	renderProjects();
	renderTodos();
});

/* ======================
   HELPERS
====================== */

function getCurrentProject() {
	return projects.find(p => p.id === currentProjectId);
}

function getColumnLabels() {
	return columns.map(c => c.label);
}

function formatDate(dateStr) {
	if (!dateStr) return "Set due date";
	const [y, m, d] = dateStr.split("-");
	const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
	return `${months[+m - 1]} ${+d}, ${y}`;
}

/* ======================
   EDITABLE FIELDS
====================== */

function makeEditable(element, todo, field, type = "text", options = null, onSave = null) {

	function activateEdit() {
		let input;

		if (type === "select" && options) {
			input = document.createElement("select");
			options.forEach(opt => {
				const option = document.createElement("option");
				option.value = opt;
				option.textContent = opt;
				if (todo[field] === opt) option.selected = true;
				input.appendChild(option);
			});
		} else {
			input = document.createElement("input");
			input.type = type;
			input.value = todo[field] ?? "";
		}

		element.replaceWith(input);
		input.focus();

		function saveEdit() {
			if (onSave) {
				todo[field] = input.value;
				todo.updatedAt = Date.now();
				onSave();
			} else {
				getCurrentProject().editTodo(todo.id, { [field]: input.value });
				saveProjects();
				renderTodos();
			}
		}

		input.addEventListener("blur", saveEdit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") input.blur();
		});
		if (type === "select") {
			input.addEventListener("change", saveEdit);
		}
	}

	// Double-click always edits; single-click edits when card is already selected
	element.addEventListener("click", (e) => {
		const isDoubleClick = e.detail >= 2;
		if (!isDoubleClick && !selectedTodos.has(todo.id)) return;
		e.stopPropagation();
		activateEdit();
	});
}

/* ======================
   PROJECT MANAGEMENT
====================== */

function addProject(title) {
	const project = new Project(title.trim(), "");
	project.epics       = [];
	project.resources   = { notes: "" };
	project.code        = generateProjectCode(title.trim());
	project.todoCounter = 0;
	project.tabs        = defaultProjectTabs();
	project.notes       = [];
	project.tools       = [];
	projects.push(project);
	currentProjectId  = project.id;
	currentProjectTab = "board";
	saveProjects();
	renderProjects();
	renderTodos();
}

function deleteProject(id) {
	if (projects.length === 1) return;
	showProjectDeleteModal(id);
}

function showProjectDeleteModal(id) {
	const project = projects.find(p => p.id === id);
	if (!project) return;
	const others = projects.filter(p => p.id !== id);

	const overlay = document.createElement("div");
	overlay.classList.add("modal-overlay");

	const modal = document.createElement("div");
	modal.classList.add("modal-card");

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("modal-close-btn");
	closeBtn.addEventListener("click", () => overlay.remove());

	const title = document.createElement("h2");
	title.classList.add("modal-title");
	title.textContent = `You are deleting "${project.title}"`;

	const body = document.createElement("p");
	body.classList.add("modal-body");
	body.textContent = project.todos.length
		? "What should happen to the cards in this project?"
		: "This project has no cards.";

	const select = document.createElement("select");
	select.classList.add("modal-select");
	others.forEach(p => {
		const opt = document.createElement("option");
		opt.value = p.id;
		opt.textContent = p.title;
		select.appendChild(opt);
	});

	// Move cards + delete project
	const moveBtn = document.createElement("button");
	moveBtn.classList.add("modal-btn-primary");
	moveBtn.textContent = project.todos.length ? "Move cards and delete project" : "Delete project";
	moveBtn.addEventListener("click", () => {
		const targetId = select.value;
		const target = projects.find(p => p.id === targetId);
		const index = projects.findIndex(p => p.id === id);
		const prevCurrentId = currentProjectId;
		const movedTodos = [...project.todos];

		if (target) {
			movedTodos.forEach(t => {
				t.epicId = null;
				target.addTodo(t);
			});
		}
		projects.splice(index, 1);
		if (currentProjectId === id) {
			currentProjectId = projects[0].id;
			currentProjectTab = "board";
		}
		saveProjects();
		renderProjects();
		renderTodos();
		overlay.remove();

		showUndoToast("Project deleted", () => {
			if (target) movedTodos.forEach(t => target.removeTodo(t.id));
			project.todos = movedTodos;
			projects.splice(index, 0, project);
			currentProjectId = prevCurrentId;
			currentProjectTab = "board";
			saveProjects();
			renderProjects();
			renderTodos();
		});
	});

	// Delete project and all cards
	const deleteAllBtn = document.createElement("button");
	deleteAllBtn.classList.add("modal-btn-secondary");
	deleteAllBtn.textContent = `Delete project and its ${project.todos.length} card${project.todos.length !== 1 ? "s" : ""}`;
	deleteAllBtn.addEventListener("click", () => {
		const index = projects.findIndex(p => p.id === id);
		const prevCurrentId = currentProjectId;
		projects.splice(index, 1);
		if (currentProjectId === id) {
			currentProjectId = projects[0].id;
			currentProjectTab = "board";
		}
		saveProjects();
		renderProjects();
		renderTodos();
		overlay.remove();

		showUndoToast("Project deleted", () => {
			projects.splice(index, 0, project);
			currentProjectId = prevCurrentId;
			currentProjectTab = "board";
			saveProjects();
			renderProjects();
			renderTodos();
		});
	});

	const btnRow = document.createElement("div");
	btnRow.classList.add("modal-btn-row");
	btnRow.appendChild(moveBtn);
	if (project.todos.length > 0) btnRow.appendChild(deleteAllBtn);

	modal.appendChild(closeBtn);
	modal.appendChild(title);
	modal.appendChild(body);
	if (project.todos.length > 0 && others.length > 0) modal.appendChild(select);
	modal.appendChild(btnRow);
	overlay.appendChild(modal);
	document.body.appendChild(overlay);
}

/* ======================
   SHARED HELPERS
====================== */

function makeField(labelText, inputEl) {
	const group = document.createElement("div");
	group.classList.add("modal-form-group");
	const lbl = document.createElement("label");
	lbl.textContent = labelText;
	lbl.classList.add("modal-form-label");
	group.appendChild(lbl);
	group.appendChild(inputEl);
	return group;
}

/* ======================
   CARD BUILDER
====================== */

function buildTodoCard(todo, ctx) {
	// ctx: { save(), delete(), isInbox }

	const todoCard = document.createElement("div");
	todoCard.classList.add("todo-card");
	todoCard.dataset.priority = (todo.priority || "").toLowerCase();
	todoCard.dataset.status = (todo.status || "").toLowerCase().replace(/ /g, "-");
	if (selectedTodos.has(todo.id)) todoCard.classList.add("selected");

	const todoTitle       = document.createElement("h1"); todoTitle.classList.add("todo-title");
	const todoDescription = document.createElement("p");  todoDescription.classList.add("todo-description");
	const todoDueDate     = document.createElement("span"); todoDueDate.classList.add("todo-due-date");
	const todoPriority    = document.createElement("span"); todoPriority.classList.add("todo-priority");
	const todoNotes       = document.createElement("p");  todoNotes.classList.add("todo-notes");
	const todoChecklist   = document.createElement("ul"); todoChecklist.classList.add("todo-checklist");
	const todoLink        = document.createElement("p");  todoLink.classList.add("todo-link");
	const todoStatus      = document.createElement("span"); todoStatus.classList.add("todo-status");

	todoTitle.textContent       = todo.title || "Untitled";
	todoDescription.textContent = todo.description;
	todoDueDate.textContent     = formatDate(todo.dueDate);
	todoPriority.textContent    = todo.priority || "Priority";
	todoNotes.textContent       = todo.notes;
	todoLink.textContent        = todo.referenceLink;
	todoStatus.textContent      = todo.status || "Status";

	makeEditable(todoTitle,       todo, "title",          "text",   null,                     ctx.save);
	makeEditable(todoDescription, todo, "description",    "text",   null,                     ctx.save);
	makeEditable(todoNotes,       todo, "notes",          "text",   null,                     ctx.save);
	makeEditable(todoPriority,    todo, "priority",       "select", ["Low", "Medium", "High"], ctx.save);
	makeEditable(todoDueDate,     todo, "dueDate",        "date",   null,                     ctx.save);
	makeEditable(todoLink,        todo, "referenceLink",  "text",   null,                     ctx.save);
	makeEditable(todoStatus,      todo, "status",         "select", getColumnLabels(),         ctx.save);

	// CHECKLIST
	if (!Array.isArray(todo.checklist)) todo.checklist = [];

	todo.checklist.forEach((item, index) => {
		const li = document.createElement("li");

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = item.completed;

		const label = document.createElement("span");
		label.textContent = item.text;

		checkbox.addEventListener("change", () => {
			item.completed = checkbox.checked;
			ctx.save();
		});

		label.addEventListener("click", () => {
			const input = document.createElement("input");
			input.value = item.text;
			label.replaceWith(input);
			input.focus();
			function saveChecklistEdit() { item.text = input.value; ctx.save(); }
			input.addEventListener("blur", saveChecklistEdit);
			input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
		});

		const deleteItemBtn = document.createElement("button");
		deleteItemBtn.textContent = "✕";
		deleteItemBtn.classList.add("checklist-delete");
		deleteItemBtn.addEventListener("click", () => {
			todo.checklist.splice(index, 1);
			ctx.save();
		});

		li.appendChild(checkbox);
		li.appendChild(label);
		li.appendChild(deleteItemBtn);
		todoChecklist.appendChild(li);
	});

	const addChecklistInput = document.createElement("input");
	addChecklistInput.placeholder = "+ add checklist item";
	addChecklistInput.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" || !addChecklistInput.value.trim()) return;
		e.preventDefault();
		todo.checklist.push({ text: addChecklistInput.value.trim(), completed: false });
		ctx.save();
	});
	todoChecklist.appendChild(addChecklistInput);

	// DELETE BUTTON
	const btnDelete = document.createElement("button");
	btnDelete.classList.add("delete-btn");
	btnDelete.textContent = "✕";
	btnDelete.title = "Delete todo";
	btnDelete.addEventListener("click", ctx.delete);

	// MOVE TO EPIC
	const epicBtn = document.createElement("button");
	epicBtn.classList.add("move-epic-btn");
	epicBtn.title = "Assign to epic";

	if (!ctx.isInbox) {
		const proj = getCurrentProject();
		if (proj && proj.epics && proj.epics.length > 0) {
			epicBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const select = document.createElement("select");
				select.classList.add("move-epic-select");

				const noEpicOpt = document.createElement("option");
				noEpicOpt.value = "";
				noEpicOpt.textContent = "No Epic";
				if (!todo.epicId) noEpicOpt.selected = true;
				select.appendChild(noEpicOpt);

				proj.epics.forEach(epic => {
					const opt = document.createElement("option");
					opt.value = epic.id;
					opt.textContent = epic.title;
					if (todo.epicId === epic.id) opt.selected = true;
					select.appendChild(opt);
				});

				epicBtn.replaceWith(select);
				select.focus();

				function commitEpicMove() {
					todo.epicId = select.value || null;
					ctx.save();
				}

				select.addEventListener("change", commitEpicMove);
				select.addEventListener("blur", () => {
					select.replaceWith(epicBtn);
				});
			});
		}
	}

	// MOVE TO PROJECT
	const moveBtn = document.createElement("button");
	moveBtn.classList.add("move-project-btn");
	moveBtn.title = "Move to project";

	moveBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const select = document.createElement("select");
		select.classList.add("move-project-select");
		projects.forEach(p => {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = p.title;
			if (!ctx.isInbox && p.id === currentProjectId) opt.selected = true;
			select.appendChild(opt);
		});
		moveBtn.replaceWith(select);
		select.focus();

		function commitMove() {
			const targetProjectId = select.value;
			const targetProject = projects.find(p => p.id === targetProjectId);
			const validStatuses = getColumnLabels();
			if (!validStatuses.includes(todo.status)) {
				todo.status = validStatuses.find(l => l.toLowerCase().includes("progress")) || validStatuses[0];
			}
			todo.epicId = null; // reset epic when moving projects
			if (ctx.isInbox) {
				const idx = inbox.indexOf(todo);
				if (idx !== -1) inbox.splice(idx, 1);
				todo.number = 0; // inbox todos get fresh number in project
				targetProject.addTodo(todo);
				saveInbox();
				saveProjects();
				renderInbox();
			} else {
				if (targetProjectId !== currentProjectId) {
					const srcProject = getCurrentProject();
					srcProject.removeTodo(todo.id);
					renumberProjectTodos(srcProject);
					todo.number = 0;
					targetProject.addTodo(todo);
					saveProjects();
					renderTodos();
				} else {
					select.replaceWith(moveBtn);
				}
			}
		}

		select.addEventListener("change", commitMove);
		select.addEventListener("blur", () => select.replaceWith(moveBtn));
	});

	// SELECTION — single click on card body
	todoCard.addEventListener("click", (e) => {
		if (e.target.closest("button, input, select, a")) return;
		e.stopPropagation();
		if (selectedTodos.has(todo.id)) {
			selectedTodos.delete(todo.id);
			todoCard.classList.remove("selected");
		} else {
			selectedTodos.add(todo.id);
			todoCard.classList.add("selected");
		}
		renderSelectionBar();
	});

	// DRAG
	todoCard.draggable = true;

	todoCard.addEventListener("dragstart", (e) => {
		if (!selectedTodos.has(todo.id)) {
			selectedTodos.clear();
			document.querySelectorAll(".todo-card.selected").forEach(c => c.classList.remove("selected"));
			selectedTodos.add(todo.id);
			todoCard.classList.add("selected");
		}
		dragState = {
			todoIds: [...selectedTodos],
			source: ctx.isInbox ? "inbox" : "project",
			projectId: ctx.isInbox ? null : currentProjectId,
		};
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", "card");
		// Dim all selected cards so the user sees all of them moving
		requestAnimationFrame(() => {
			document.querySelectorAll(".todo-card.selected").forEach(c => c.classList.add("dragging"));
		});
	});

	todoCard.addEventListener("dragend", () => {
		document.querySelectorAll(".todo-card.dragging").forEach(c => c.classList.remove("dragging"));
		if (dragState) dragState = null;
		if (dragHoverTimer) { clearTimeout(dragHoverTimer); dragHoverTimer = null; }
	});

	// ASSEMBLE
	const todoHeader = document.createElement("div");
	todoHeader.classList.add("todo-header");

	// Number badge (DEF-1)
	if (!ctx.isInbox && todo.number) {
		const proj = ctx.project || getCurrentProject();
		if (proj && proj.code) {
			const numBadge = document.createElement("span");
			numBadge.classList.add("todo-number-badge");
			numBadge.textContent = `${proj.code}-${todo.number}`;
			todoHeader.appendChild(numBadge);
		}
	}

	todoHeader.appendChild(todoTitle);
	if (!ctx.isInbox) {
		const proj = getCurrentProject();
		if (proj && proj.epics && proj.epics.length > 0) todoHeader.appendChild(epicBtn);
	}
	todoHeader.appendChild(moveBtn);
	todoHeader.appendChild(btnDelete);

	const todoMeta = document.createElement("div");
	todoMeta.classList.add("todo-meta");
	todoMeta.appendChild(todoDueDate);
	todoMeta.appendChild(todoPriority);
	todoMeta.appendChild(todoStatus);

	// Tool assignment row (when Stack tab has tools)
	const proj = ctx.project || getCurrentProject();
	const hasStackTab = !ctx.isInbox && proj?.tabs?.some(t => t.type === "stack");
	const toolBadgesRow = document.createElement("div");
	toolBadgesRow.classList.add("todo-tools-row");
	if (hasStackTab && proj?.tools?.length) {
		if (!Array.isArray(todo.toolIds)) todo.toolIds = [];

		function renderCardTools() {
			toolBadgesRow.innerHTML = "";

			// Selected tools as removable capsule badges
			todo.toolIds.forEach(tid => {
				const tool = proj.tools.find(t => t.id === tid);
				if (!tool) return;
				const badge = document.createElement("span");
				badge.classList.add("tool-badge");
				badge.title = "Click to remove";
				const dot = document.createElement("span");
				dot.classList.add("tool-badge-dot");
				dot.style.background = tool.color || "#888";
				badge.appendChild(dot);
				badge.appendChild(document.createTextNode(tool.name));
				badge.addEventListener("click", (e) => {
					e.stopPropagation();
					todo.toolIds = todo.toolIds.filter(id => id !== tool.id);
					ctx.save();
					renderCardTools();
				});
				toolBadgesRow.appendChild(badge);
			});

			// "+ Tool" button to open picker
			const addToolBtn = document.createElement("button");
			addToolBtn.classList.add("todo-add-tool-btn");
			addToolBtn.textContent = "+ Tool";
			addToolBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const existing = document.querySelector(".todo-tool-picker");
				if (existing) { existing.remove(); return; }

				const picker = document.createElement("div");
				picker.classList.add("todo-tool-picker");

				proj.tools.forEach(tool => {
					const opt = document.createElement("button");
					opt.classList.add("todo-tool-picker-opt");
					const isSelected = todo.toolIds.includes(tool.id);
					if (isSelected) opt.classList.add("selected");

					const dot = document.createElement("span");
					dot.classList.add("tool-badge-dot");
					dot.style.background = tool.color || "#888";
					opt.appendChild(dot);
					opt.appendChild(document.createTextNode(tool.name));

					opt.addEventListener("click", (ev) => {
						ev.stopPropagation();
						if (todo.toolIds.includes(tool.id)) {
							todo.toolIds = todo.toolIds.filter(id => id !== tool.id);
						} else {
							todo.toolIds.push(tool.id);
						}
						ctx.save();
						picker.remove();
						renderCardTools();
					});
					picker.appendChild(opt);
				});

				document.body.appendChild(picker);
				const rect = addToolBtn.getBoundingClientRect();
				picker.style.top  = `${rect.bottom + 4}px`;
				picker.style.left = `${rect.left}px`;

				function onOutside(ev) {
					if (!picker.contains(ev.target) && ev.target !== addToolBtn) {
						picker.remove();
						document.removeEventListener("click", onOutside, true);
					}
				}
				setTimeout(() => document.addEventListener("click", onOutside, true), 0);
			});
			toolBadgesRow.appendChild(addToolBtn);
		}
		renderCardTools();
	}

	// TAGS
	if (!Array.isArray(todo.tags)) todo.tags = [];
	const todoTagsRow = document.createElement("div");
	todoTagsRow.classList.add("todo-tags-row");

	function renderTodoTags() {
		todoTagsRow.innerHTML = "";
		todo.tags.forEach((tag, i) => {
			const chip = document.createElement("span");
			chip.classList.add("todo-tag-chip");
			chip.textContent = `#${tag}`;
			chip.title = "Click to remove";
			chip.addEventListener("click", (e) => {
				e.stopPropagation();
				todo.tags.splice(i, 1);
				ctx.save();
				renderTodoTags();
			});
			todoTagsRow.appendChild(chip);
		});
		const tagIn = document.createElement("input");
		tagIn.placeholder = "+ tag";
		tagIn.classList.add("todo-tag-input");
		tagIn.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === ",") {
				e.preventDefault();
				const val = tagIn.value.trim().replace(/^#/, "").toLowerCase().replace(/,$/, "");
				if (val && !todo.tags.includes(val)) {
					todo.tags.push(val);
					ctx.save();
					renderTodoTags();
				} else {
					tagIn.value = "";
				}
			}
		});
		todoTagsRow.appendChild(tagIn);
	}
	renderTodoTags();

	todoCard.appendChild(todoHeader);
	todoCard.appendChild(todoDescription);
	todoCard.appendChild(todoMeta);
	if (hasStackTab && proj?.tools?.length) todoCard.appendChild(toolBadgesRow);
	todoCard.appendChild(todoNotes);
	todoCard.appendChild(todoChecklist);
	todoCard.appendChild(todoLink);
	todoCard.appendChild(todoTagsRow);

	addCardTouchDrag(todoCard, todo, ctx);

	return todoCard;
}

/* ======================
   INBOX ADD FORM
====================== */

function showInboxAddForm() {
	const overlay = document.createElement("div");
	overlay.classList.add("modal-overlay");
	overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

	const modal = document.createElement("div");
	modal.classList.add("modal-card");

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("modal-close-btn");
	closeBtn.addEventListener("click", () => overlay.remove());

	const heading = document.createElement("h2");
	heading.classList.add("modal-title");
	heading.textContent = "Add to Inbox";

	const titleInput = document.createElement("input");
	titleInput.type = "text";
	titleInput.placeholder = "Title";
	titleInput.classList.add("modal-form-input");

	const descInput = document.createElement("textarea");
	descInput.placeholder = "Description (optional)";
	descInput.classList.add("modal-form-input");
	descInput.rows = 2;

	const prioritySelect = document.createElement("select");
	prioritySelect.classList.add("modal-form-input");
	["Low", "Medium", "High"].forEach(p => {
		const opt = document.createElement("option");
		opt.value = p; opt.textContent = p;
		prioritySelect.appendChild(opt);
	});

	const dueDateInput = document.createElement("input");
	dueDateInput.type = "date";
	dueDateInput.classList.add("modal-form-input");

	// Tags input for inbox add
	const inboxTagsInput = document.createElement("input");
	inboxTagsInput.type = "text";
	inboxTagsInput.placeholder = "Tags (comma-separated, e.g. urgent, bug)";
	inboxTagsInput.classList.add("modal-form-input");

	const addBtn = document.createElement("button");
	addBtn.classList.add("modal-btn-primary");
	addBtn.textContent = "Add to Inbox";

	addBtn.addEventListener("click", () => {
		const title = titleInput.value.trim();
		if (!title) { titleInput.focus(); return; }
		const todo = new Todo(
			title,
			descInput.value,
			dueDateInput.value,
			prioritySelect.value,
			"", [], "", getColumnLabels()[0] || ""
		);
		todo.epicId = null;
		todo.tags = inboxTagsInput.value.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
		inbox.push(todo);
		saveInbox();
		if (currentView === "inbox") renderInbox();
		overlay.remove();
	});

	modal.appendChild(closeBtn);
	modal.appendChild(heading);
	modal.appendChild(makeField("Title", titleInput));
	modal.appendChild(makeField("Description", descInput));
	modal.appendChild(makeField("Priority", prioritySelect));
	modal.appendChild(makeField("Due Date", dueDateInput));
	modal.appendChild(makeField("Tags", inboxTagsInput));
	modal.appendChild(addBtn);
	overlay.appendChild(modal);
	document.body.appendChild(overlay);

	requestAnimationFrame(() => titleInput.focus());
}

/* ======================
   EPIC ADD FORM
====================== */

function showEpicAddForm(epicId) {
	const overlay = document.createElement("div");
	overlay.classList.add("modal-overlay");
	overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

	const modal = document.createElement("div");
	modal.classList.add("modal-card");

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("modal-close-btn");
	closeBtn.addEventListener("click", () => overlay.remove());

	const heading = document.createElement("h2");
	heading.classList.add("modal-title");
	const project = getCurrentProject();
	const epicName = epicId === null ? "No Epic" : project?.epics.find(e => e.id === epicId)?.title || "Epic";
	heading.textContent = `Add card to ${epicName}`;

	const titleInput = document.createElement("input");
	titleInput.type = "text";
	titleInput.placeholder = "Card title";
	titleInput.classList.add("modal-form-input");

	const statusSelect = document.createElement("select");
	statusSelect.classList.add("modal-form-input");
	getColumnLabels().forEach(l => {
		const opt = document.createElement("option");
		opt.value = l; opt.textContent = l;
		statusSelect.appendChild(opt);
	});

	const addBtn = document.createElement("button");
	addBtn.classList.add("modal-btn-primary");
	addBtn.textContent = "Add card";

	addBtn.addEventListener("click", () => {
		const title = titleInput.value.trim();
		if (!title) { titleInput.focus(); return; }
		const proj = getCurrentProject();
		const todo = new Todo(title, "", "", "Low", "", [], "", statusSelect.value);
		todo.epicId = epicId;
		proj.addTodo(todo);
		saveProjects();
		overlay.remove();
		renderTodos();
	});

	modal.appendChild(closeBtn);
	modal.appendChild(heading);
	modal.appendChild(makeField("Title", titleInput));
	modal.appendChild(makeField("Status", statusSelect));
	modal.appendChild(addBtn);
	overlay.appendChild(modal);
	document.body.appendChild(overlay);

	requestAnimationFrame(() => titleInput.focus());
}

/* ======================
   PROJECT TABS
====================== */

const TAB_TYPE_OPTIONS = [
	{ type: "notes", label: "Notes" },
	{ type: "stack", label: "Stack" },
];

function buildProjectTabBar(project) {
	const bar = document.createElement("div");
	bar.classList.add("project-tab-bar");
	bar.style.position = "relative";

	const tabs = project.tabs && project.tabs.length ? project.tabs : defaultProjectTabs();

	tabs.forEach(tab => {
		const item = document.createElement("div");
		item.classList.add("project-tab-item");

		const btn = document.createElement("button");
		btn.classList.add("project-tab");
		btn.textContent = tab.label;
		if (currentProjectTab === tab.id) btn.classList.add("active");
		btn.addEventListener("click", () => {
			currentProjectTab = tab.id;
			renderTodos();
		});
		item.appendChild(btn);

		// Removable tabs (not board)
		if (tab.type !== "board") {
			const removeBtn = document.createElement("button");
			removeBtn.classList.add("project-tab-remove-btn");
			removeBtn.title = `Remove ${tab.label} tab`;
			removeBtn.textContent = "×";
			removeBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				project.tabs = project.tabs.filter(t => t.id !== tab.id);
				if (currentProjectTab === tab.id) currentProjectTab = "board";
				saveProjects();
				renderTodos();
			});
			item.appendChild(removeBtn);
		}

		bar.appendChild(item);
	});

	// "+" add tab button
	const addBtn = document.createElement("button");
	addBtn.classList.add("project-tab-add-btn");
	addBtn.title = "Add tab";
	addBtn.textContent = "+";
	bar.appendChild(addBtn);

	addBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const existing = document.querySelector(".tab-add-dropdown");
		if (existing) { existing.remove(); return; }

		const dropdown = document.createElement("div");
		dropdown.classList.add("tab-add-dropdown");

		const available = TAB_TYPE_OPTIONS.filter(opt =>
			!tabs.some(t => t.type === opt.type)
		);

		if (available.length === 0) {
			const msg = document.createElement("div");
			msg.style.cssText = "padding:10px;font-size:0.8rem;color:var(--md-label-color);";
			msg.textContent = "All tabs added";
			dropdown.appendChild(msg);
		} else {
			available.forEach(opt => {
				const optBtn = document.createElement("button");
				optBtn.classList.add("tab-add-option");
				optBtn.textContent = opt.label;
				optBtn.addEventListener("click", () => {
					if (!project.tabs) project.tabs = defaultProjectTabs();
					project.tabs.push({ id: self.crypto.randomUUID(), type: opt.type, label: opt.label });
					currentProjectTab = project.tabs[project.tabs.length - 1].id;
					saveProjects();
					renderTodos();
					dropdown.remove();
				});
				dropdown.appendChild(optBtn);
			});
		}

		document.body.appendChild(dropdown);
		const rect = addBtn.getBoundingClientRect();
		dropdown.style.top  = `${rect.bottom + 6}px`;
		dropdown.style.left = `${rect.left}px`;

		function onOutside(ev) {
			if (!dropdown.contains(ev.target) && ev.target !== addBtn) {
				dropdown.remove();
				document.removeEventListener("click", onOutside, true);
			}
		}
		setTimeout(() => document.addEventListener("click", onOutside, true), 0);
	});

	return bar;
}

function renderResourcesPanel(project) {
	if (!project.resources) project.resources = { notes: "", html: "" };

	const panel = document.createElement("div");
	panel.classList.add("resources-panel");

	const wrap = document.createElement("div");
	wrap.classList.add("resources-editor-wrap");

	// Header row: label + format toggle
	const header = document.createElement("div");
	header.classList.add("resources-editor-header");

	const lbl = document.createElement("span");
	lbl.classList.add("resources-label");
	lbl.textContent = "Notes";

	const formatToggle = document.createElement("button");
	formatToggle.classList.add("resources-format-toggle");
	formatToggle.title = "Formatting options";
	formatToggle.innerHTML = "<strong>A</strong>";

	header.appendChild(lbl);
	header.appendChild(formatToggle);

	// Toolbar (hidden by default)
	const toolbar = document.createElement("div");
	toolbar.classList.add("resources-toolbar");
	toolbar.style.display = "none";

	const fmtDefs = [
		{ cmd: "bold",                label: "<strong>B</strong>", title: "Bold" },
		{ cmd: "italic",              label: "<em>I</em>",          title: "Italic" },
		{ cmd: "bulletList",          label: "• List",              title: "Bullet list" },
		{ cmd: "heading",             label: "H",                   title: "Heading" },
		{ cmd: "blockquote",          label: "❝",                  title: "Blockquote" },
		{ cmd: "link",                label: "🔗",                 title: "Insert link" },
	];

	const content = document.createElement("div");
	content.classList.add("resources-content");
	content.contentEditable = "true";
	content.dataset.placeholder = "Add notes for this project…";

	// Load content
	if (project.resources.html) {
		content.innerHTML = project.resources.html;
	} else if (project.resources.notes) {
		content.textContent = project.resources.notes;
		project.resources.html = content.innerHTML;
	}

	function save() {
		project.resources.html = content.innerHTML;
		saveProjects();
	}

	fmtDefs.forEach(({ cmd, label, title }) => {
		const btn = document.createElement("button");
		btn.classList.add("res-fmt-btn");
		btn.innerHTML = label;
		btn.title = title;
		btn.addEventListener("mousedown", (e) => e.preventDefault());
		btn.addEventListener("click", () => {
			content.focus();
			if (cmd === "bold") document.execCommand("bold");
			else if (cmd === "italic") document.execCommand("italic");
			else if (cmd === "bulletList") document.execCommand("insertUnorderedList");
			else if (cmd === "heading") document.execCommand("formatBlock", false, "h3");
			else if (cmd === "blockquote") document.execCommand("formatBlock", false, "blockquote");
			else if (cmd === "link") {
				const url = prompt("Enter URL:", "https://");
				if (url) document.execCommand("createLink", false, url);
			}
			save();
		});
		toolbar.appendChild(btn);
	});

	formatToggle.addEventListener("click", () => {
		const open = toolbar.style.display !== "none";
		toolbar.style.display = open ? "none" : "flex";
		formatToggle.classList.toggle("active", !open);
	});

	content.addEventListener("input", save);
	content.addEventListener("click", (e) => { if (e.target.tagName === "A") e.preventDefault(); });

	wrap.appendChild(header);
	wrap.appendChild(toolbar);
	wrap.appendChild(content);
	panel.appendChild(wrap);
	todoContainer.appendChild(panel);
}

/* ======================
   SORT
====================== */

function buildSortBar(sourceArray, renderFn) {
	const sortBar = document.createElement("div");
	sortBar.classList.add("sort-bar");

	const sortLabel = document.createElement("span");
	sortLabel.classList.add("sort-label");
	sortLabel.textContent = "Sort:";

	const sortOptions = [
		{ value: "default",   label: "Default" },
		{ value: "priority",  label: "Priority" },
		{ value: "createdAt", label: "Date Added" },
		{ value: "updatedAt", label: "Date Updated" },
		{ value: "dueDate",   label: "Due Date" },
	];

	sortBar.appendChild(sortLabel);
	sortOptions.forEach(opt => {
		const btn = document.createElement("button");
		btn.classList.add("sort-btn");
		if (sortBy === opt.value) btn.classList.add("active");
		btn.textContent = opt.label;
		btn.addEventListener("click", () => { sortBy = opt.value; renderFn(); });
		sortBar.appendChild(btn);
	});

	const dirBtn = document.createElement("button");
	dirBtn.classList.add("sort-dir-btn");
	dirBtn.title = sortDir === "asc" ? "Sort ascending" : "Sort descending";
	dirBtn.textContent = sortDir === "asc" ? "↑" : "↓";
	dirBtn.addEventListener("click", () => { sortDir = sortDir === "asc" ? "desc" : "asc"; renderFn(); });
	sortBar.appendChild(dirBtn);

	const searchInput = document.createElement("input");
	searchInput.type = "search";
	searchInput.classList.add("sort-search-input");
	searchInput.placeholder = "Search…";
	searchInput.value = searchQuery;
	searchInput.addEventListener("input", () => { searchQuery = searchInput.value; renderFn(); });
	sortBar.appendChild(searchInput);

	return sortBar;
}

function todoMatchesSearch(todo, projectCode) {
	if (!searchQuery) return true;
	const q = searchQuery.toLowerCase();
	return [
		todo.title,
		todo.description,
		todo.notes,
		todo.status,
		todo.priority,
		projectCode,
		...(todo.tags || []),
		...(todo.checklist || []).map(c => (typeof c === "string" ? c : c.text) || ""),
	].some(s => s?.toLowerCase().includes(q));
}

function sortedArray(arr) {
	const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
	return [...arr].sort((a, b) => {
		let result = 0;
		if (sortBy === "priority") {
			result = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
		} else if (sortBy === "createdAt") {
			result = (a.createdAt ?? 0) - (b.createdAt ?? 0);
		} else if (sortBy === "updatedAt") {
			result = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
		} else if (sortBy === "dueDate") {
			const da = a.dueDate ? new Date(a.dueDate) : new Date("9999-12-31");
			const db = b.dueDate ? new Date(b.dueDate) : new Date("9999-12-31");
			result = da - db;
		}
		return sortDir === "desc" ? -result : result;
	});
}

/* ======================
   SELECTION BAR
====================== */

function sizeSelectToContent(el) {
	const text = el.options[el.selectedIndex]?.text ?? "";
	const probe = document.createElement("span");
	probe.style.cssText = "position:fixed;visibility:hidden;white-space:nowrap;font-size:0.75rem;font-family:inherit;padding:0 28px 0 12px;";
	probe.textContent = text;
	document.body.appendChild(probe);
	el.style.width = Math.ceil(probe.getBoundingClientRect().width) + 4 + "px"; // +4 for borders + subpixel
	probe.remove();
}

function renderSelectionBar() {
	if (selectedTodos.size === 0) {
		// Animate out and remove
		if (selectionOverlay) {
			selectionOverlay.classList.remove("visible");
			selectionOverlay.addEventListener("transitionend", () => {
				if (selectionOverlay) { selectionOverlay.remove(); selectionOverlay = null; }
			}, { once: true });
		}
		return;
	}

	const isNew = !selectionOverlay;

	if (!selectionOverlay) {
		selectionOverlay = document.createElement("div");
		selectionOverlay.classList.add("selection-bar-overlay");
		document.body.appendChild(selectionOverlay);
		// Animate in on next frame
		requestAnimationFrame(() => {
			requestAnimationFrame(() => selectionOverlay && selectionOverlay.classList.add("visible"));
		});
	}

	// Clear and rebuild contents
	selectionOverlay.innerHTML = "";

	const count = document.createElement("span");
	count.classList.add("selection-count");
	count.textContent = `${selectedTodos.size} selected`;
	count.addEventListener("click", (e) => e.stopPropagation());

	const divider = document.createElement("span");
	divider.classList.add("selection-bar-divider");

	const deleteAllBtn = document.createElement("button");
	deleteAllBtn.classList.add("selection-btn", "selection-btn-danger");
	deleteAllBtn.textContent = `Delete ${selectedTodos.size}`;
	deleteAllBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const ids = [...selectedTodos];
		if (currentView === "inbox") {
			const removed = ids.map(id => {
				const i = inbox.findIndex(t => t.id === id);
				return i >= 0 ? { todo: inbox[i], index: i } : null;
			}).filter(Boolean).sort((a, b) => b.index - a.index);
			removed.forEach(({ todo }) => inbox.splice(inbox.indexOf(todo), 1));
			selectedTodos.clear();
			saveInbox();
			renderInbox();
			showUndoToast(`${removed.length} cards deleted`, () => {
				removed.sort((a, b) => a.index - b.index).forEach(({ todo, index }) => inbox.splice(index, 0, todo));
				saveInbox();
				renderInbox();
			});
		} else {
			const proj = getCurrentProject();
			const removed = ids.map(id => {
				const i = proj.todos.findIndex(t => t.id === id);
				return i >= 0 ? { todo: proj.todos[i], index: i } : null;
			}).filter(Boolean).sort((a, b) => b.index - a.index);
			removed.forEach(({ todo }) => proj.removeTodo(todo.id));
			selectedTodos.clear();
			saveProjects();
			renderTodos();
			showUndoToast(`${removed.length} cards deleted`, () => {
				removed.sort((a, b) => a.index - b.index).forEach(({ todo, index }) => proj.todos.splice(index, 0, todo));
				saveProjects();
				renderTodos();
			});
		}
	});

	// Move to project
	const moveSelect = document.createElement("select");
	moveSelect.classList.add("selection-select");
	const moveDefault = document.createElement("option");
	moveDefault.value = "";
	moveDefault.textContent = "Move to";
	moveSelect.appendChild(moveDefault);
	projects.forEach(p => {
		if (currentView === "project" && p.id === currentProjectId) return;
		const opt = document.createElement("option");
		opt.value = p.id;
		opt.textContent = p.title;
		moveSelect.appendChild(opt);
	});
	sizeSelectToContent(moveSelect);
	moveSelect.addEventListener("click", (e) => e.stopPropagation());
	moveSelect.addEventListener("change", (e) => {
		e.stopPropagation();
		sizeSelectToContent(moveSelect);
		if (!moveSelect.value) return;
		const target = projects.find(p => p.id === moveSelect.value);
		const ids = [...selectedTodos];
		ids.forEach(id => {
			let todo;
			if (currentView === "inbox") {
				todo = inbox.find(t => t.id === id);
				if (todo) inbox.splice(inbox.indexOf(todo), 1);
			} else {
				todo = getCurrentProject()?.todos.find(t => t.id === id);
				if (todo) getCurrentProject().removeTodo(id);
			}
			if (todo) {
				const valid = getColumnLabels();
				if (!valid.includes(todo.status)) {
					todo.status = valid.find(l => l.toLowerCase().includes("progress")) || valid[0];
				}
				todo.epicId = null;
				target.addTodo(todo);
			}
		});
		selectedTodos.clear();
		saveInbox();
		saveProjects();
		renderProjects();
		if (currentView === "inbox") renderInbox(); else renderTodos();
	});

	// Batch priority
	const prioritySelect = document.createElement("select");
	prioritySelect.classList.add("selection-select");
	const priDefault = document.createElement("option");
	priDefault.value = "";
	priDefault.textContent = "Priority";
	prioritySelect.appendChild(priDefault);
	["Low", "Medium", "High"].forEach(p => {
		const opt = document.createElement("option");
		opt.value = p; opt.textContent = p;
		prioritySelect.appendChild(opt);
	});
	sizeSelectToContent(prioritySelect);
	prioritySelect.addEventListener("click", (e) => e.stopPropagation());
	prioritySelect.addEventListener("change", (e) => {
		e.stopPropagation();
		sizeSelectToContent(prioritySelect);
		if (!prioritySelect.value) return;
		batchUpdate("priority", prioritySelect.value);
	});

	// Batch status
	const statusSelect = document.createElement("select");
	statusSelect.classList.add("selection-select");
	const statDefault = document.createElement("option");
	statDefault.value = "";
	statDefault.textContent = "Status";
	statusSelect.appendChild(statDefault);
	getColumnLabels().forEach(l => {
		const opt = document.createElement("option");
		opt.value = l; opt.textContent = l;
		statusSelect.appendChild(opt);
	});
	sizeSelectToContent(statusSelect);
	statusSelect.addEventListener("click", (e) => e.stopPropagation());
	statusSelect.addEventListener("change", (e) => {
		e.stopPropagation();
		sizeSelectToContent(statusSelect);
		if (!statusSelect.value) return;
		batchUpdate("status", statusSelect.value);
	});

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("selection-close-btn");
	closeBtn.title = "Clear selection";
	closeBtn.textContent = "✕";
	closeBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		selectedTodos.clear();
		document.querySelectorAll(".todo-card.selected").forEach(c => c.classList.remove("selected"));
		renderSelectionBar();
	});

	selectionOverlay.appendChild(count);
	selectionOverlay.appendChild(divider);
	selectionOverlay.appendChild(deleteAllBtn);
	selectionOverlay.appendChild(moveSelect);
	selectionOverlay.appendChild(prioritySelect);
	selectionOverlay.appendChild(statusSelect);
	selectionOverlay.appendChild(closeBtn);
}

function batchUpdate(field, value) {
	const ids = [...selectedTodos];
	if (currentView === "inbox") {
		ids.forEach(id => {
			const todo = inbox.find(t => t.id === id);
			if (todo) { todo[field] = value; todo.updatedAt = Date.now(); }
		});
		saveInbox();
		renderInbox();
	} else {
		const proj = getCurrentProject();
		ids.forEach(id => {
			const todo = proj?.todos.find(t => t.id === id);
			if (todo) { todo[field] = value; todo.updatedAt = Date.now(); }
		});
		saveProjects();
		renderTodos();
	}
}

/* ======================
   NOTES TAB
====================== */

const NOTE_COLORS = ["#FCFF4B","#1a73e8","#188038","#e91e8c","#f59e0b","#9c27b0","#ef4444","#06b6d4"];

function renderNotesTab(project) {
	if (!project.notes) project.notes = [];

	const container = document.createElement("div");
	container.classList.add("notes-tab");

	// Header
	const header = document.createElement("div");
	header.classList.add("notes-header");

	// Filter bar
	const filterBar = document.createElement("div");
	filterBar.classList.add("notes-filter-bar");

	const searchInput = document.createElement("input");
	searchInput.classList.add("notes-filter-input");
	searchInput.placeholder = "Search notes…";
	searchInput.type = "search";

	const categoryFilterWrap = document.createElement("div");
	categoryFilterWrap.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";

	const tagFilterWrap = document.createElement("div");
	tagFilterWrap.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";

	let activeCategory = null;
	let activeTag = null;

	function getCategories() {
		return [...new Set(project.notes.map(n => n.category).filter(Boolean))];
	}

	function getAllTags() {
		return [...new Set(project.notes.flatMap(n => n.tags || []).filter(Boolean))];
	}

	function rebuildFilterPills() {
		// Categories
		categoryFilterWrap.innerHTML = "";
		const catLabel = document.createElement("span");
		catLabel.style.cssText = "font-size:0.72rem;color:var(--md-label-color);";
		catLabel.textContent = "Category:";
		categoryFilterWrap.appendChild(catLabel);

		const allCatP = document.createElement("button");
		allCatP.classList.add("notes-filter-pill");
		if (!activeCategory) allCatP.classList.add("active");
		allCatP.textContent = "All";
		allCatP.addEventListener("click", () => { activeCategory = null; renderGrid(); rebuildFilterPills(); });
		categoryFilterWrap.appendChild(allCatP);

		getCategories().forEach(cat => {
			const pill = document.createElement("button");
			pill.classList.add("notes-filter-pill");
			if (cat === activeCategory) pill.classList.add("active");
			pill.textContent = cat;
			pill.addEventListener("click", () => {
				activeCategory = cat === activeCategory ? null : cat;
				renderGrid(); rebuildFilterPills();
			});
			categoryFilterWrap.appendChild(pill);
		});

		// Tags
		tagFilterWrap.innerHTML = "";
		const tags = getAllTags();
		if (tags.length) {
			const tagLabel = document.createElement("span");
			tagLabel.style.cssText = "font-size:0.72rem;color:var(--md-label-color);";
			tagLabel.textContent = "Tag:";
			tagFilterWrap.appendChild(tagLabel);

			const allTagP = document.createElement("button");
			allTagP.classList.add("notes-filter-pill");
			if (!activeTag) allTagP.classList.add("active");
			allTagP.textContent = "All";
			allTagP.addEventListener("click", () => { activeTag = null; renderGrid(); rebuildFilterPills(); });
			tagFilterWrap.appendChild(allTagP);

			tags.forEach(tag => {
				const pill = document.createElement("button");
				pill.classList.add("notes-filter-pill");
				if (tag === activeTag) pill.classList.add("active");
				pill.textContent = tag;
				pill.addEventListener("click", () => {
					activeTag = tag === activeTag ? null : tag;
					renderGrid(); rebuildFilterPills();
				});
				tagFilterWrap.appendChild(pill);
			});
		}
	}

	filterBar.appendChild(searchInput);
	filterBar.appendChild(categoryFilterWrap);
	filterBar.appendChild(tagFilterWrap);

	const addBtn = document.createElement("button");
	addBtn.classList.add("notes-add-btn");
	addBtn.textContent = "+ Add Note";
	addBtn.addEventListener("click", () => {
		const note = {
			id: self.crypto.randomUUID(),
			content: "",
			html: "",
			tags: [],
			category: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		project.notes.unshift(note);
		saveProjects();
		renderGrid();
		rebuildFilterPills();
		requestAnimationFrame(() => {
			const firstContent = grid.querySelector(".note-card-content");
			if (firstContent) firstContent.focus();
		});
	});

	header.appendChild(filterBar);
	header.appendChild(addBtn);
	container.appendChild(header);

	// Grid
	const grid = document.createElement("div");
	grid.classList.add("notes-grid");
	container.appendChild(grid);

	function renderGrid() {
		grid.innerHTML = "";
		const query = searchInput.value.toLowerCase();
		const visible = project.notes.filter(note => {
			if (activeCategory && note.category !== activeCategory) return false;
			if (activeTag && !(note.tags || []).includes(activeTag)) return false;
			if (query && !note.content?.toLowerCase().includes(query) &&
				!note.html?.toLowerCase().includes(query) &&
				!note.tags?.some(t => t.toLowerCase().includes(query)) &&
				!note.category?.toLowerCase().includes(query)) return false;
			return true;
		});

		if (visible.length === 0) {
			const empty = document.createElement("div");
			empty.classList.add("notes-empty");
			empty.textContent = query || activeCategory || activeTag ? "No notes match" : "No notes yet — click + Add Note to start.";
			grid.appendChild(empty);
			return;
		}

		visible.forEach(note => grid.appendChild(buildNoteCard(note, project, renderGrid, rebuildFilterPills)));
	}

	searchInput.addEventListener("input", renderGrid);

	renderGrid();
	rebuildFilterPills();

	todoContainer.innerHTML = "";
	todoContainer.appendChild(container);
}

function buildNoteCard(note, project, refresh, refreshPills) {
	const card = document.createElement("div");
	card.classList.add("note-card");

	// Header
	const cardHeader = document.createElement("div");
	cardHeader.classList.add("note-card-header");

	const meta = document.createElement("div");
	meta.classList.add("note-card-meta");

	const catInput = document.createElement("input");
	catInput.classList.add("note-category-input");
	catInput.value = note.category || "";
	catInput.placeholder = "Category";
	catInput.addEventListener("blur", () => {
		note.category = catInput.value.trim().toUpperCase();
		catInput.value = note.category;
		note.updatedAt = Date.now();
		saveProjects();
		if (refreshPills) refreshPills();
	});
	catInput.addEventListener("keydown", e => { if (e.key === "Enter") catInput.blur(); });

	const dateEl = document.createElement("div");
	dateEl.classList.add("note-card-date");
	const d = new Date(note.updatedAt || note.createdAt);
	dateEl.textContent = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

	meta.appendChild(catInput);
	meta.appendChild(dateEl);

	const deleteBtn = document.createElement("button");
	deleteBtn.classList.add("note-card-delete");
	deleteBtn.title = "Delete note";
	deleteBtn.textContent = "✕";
	deleteBtn.addEventListener("click", () => {
		const idx = project.notes.findIndex(n => n.id === note.id);
		if (idx !== -1) project.notes.splice(idx, 1);
		saveProjects();
		refresh();
		if (refreshPills) refreshPills();
	});

	cardHeader.appendChild(meta);
	cardHeader.appendChild(deleteBtn);

	// Format toolbar
	const toolbar = document.createElement("div");
	toolbar.classList.add("note-card-toolbar");

	const fmts = [
		{ cmd: "bold",          label: "<strong>B</strong>", title: "Bold" },
		{ cmd: "italic",        label: "<em>I</em>",          title: "Italic" },
		{ cmd: "insertUnorderedList", label: "• List",        title: "Bullet list" },
	];

	fmts.forEach(({ cmd, label, title }) => {
		const btn = document.createElement("button");
		btn.classList.add("note-fmt-btn");
		btn.innerHTML = label;
		btn.title = title;
		btn.type = "button";
		btn.addEventListener("mousedown", e => {
			e.preventDefault();
			document.execCommand(cmd, false, null);
		});
		toolbar.appendChild(btn);
	});

	// Content
	const content = document.createElement("div");
	content.classList.add("note-card-content");
	content.contentEditable = "true";
	content.innerHTML = note.html || note.content || "";

	let saveTimeout;
	content.addEventListener("input", () => {
		clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => {
			note.html = content.innerHTML;
			note.content = content.innerText;
			note.updatedAt = Date.now();
			saveProjects();
		}, 500);
	});

	// Tags
	const tagsRow = document.createElement("div");
	tagsRow.classList.add("note-card-tags");

	function renderTags() {
		tagsRow.innerHTML = "";
		(note.tags || []).forEach((tag, i) => {
			const tagEl = document.createElement("span");
			tagEl.classList.add("note-tag");
			tagEl.textContent = tag;
			const removeBtn = document.createElement("button");
			removeBtn.classList.add("note-tag-remove");
			removeBtn.textContent = "×";
			removeBtn.addEventListener("click", () => {
				note.tags.splice(i, 1);
				saveProjects();
				renderTags();
				if (refreshPills) refreshPills();
			});
			tagEl.appendChild(removeBtn);
			tagsRow.appendChild(tagEl);
		});

		const tagInput = document.createElement("input");
		tagInput.classList.add("note-tag-input");
		tagInput.placeholder = "+ tag";
		tagInput.addEventListener("keydown", e => {
			if (e.key === "Enter" || e.key === ",") {
				e.preventDefault();
				const val = tagInput.value.trim().replace(/,$/, "");
				if (val && !(note.tags || []).includes(val)) {
					if (!note.tags) note.tags = [];
					note.tags.push(val);
					saveProjects();
					renderTags();
					if (refreshPills) refreshPills();
				} else {
					tagInput.value = "";
				}
			}
		});
		tagsRow.appendChild(tagInput);
	}

	renderTags();

	// Tool chips (when project has a Stack tab)
	const hasStack = project?.tabs?.some(t => t.type === "stack");
	let noteToolsRow = null;
	if (hasStack && project.tools?.length) {
		if (!Array.isArray(note.toolIds)) note.toolIds = [];
		noteToolsRow = document.createElement("div");
		noteToolsRow.classList.add("note-tools-row");

		function renderNoteTools() {
			noteToolsRow.innerHTML = "";
			project.tools.forEach(tool => {
				const chip = document.createElement("button");
				chip.classList.add("note-tool-chip");
				if (note.toolIds.includes(tool.id)) chip.classList.add("active");
				const dot = document.createElement("span");
				dot.classList.add("tool-badge-dot");
				dot.style.background = tool.color || "#888";
				chip.appendChild(dot);
				chip.appendChild(document.createTextNode(tool.name));
				chip.addEventListener("click", (e) => {
					e.stopPropagation();
					if (note.toolIds.includes(tool.id)) {
						note.toolIds = note.toolIds.filter(id => id !== tool.id);
					} else {
						note.toolIds.push(tool.id);
					}
					note.updatedAt = Date.now();
					saveProjects();
					renderNoteTools();
				});
				noteToolsRow.appendChild(chip);
			});
		}
		renderNoteTools();
	}

	card.appendChild(cardHeader);
	card.appendChild(toolbar);
	card.appendChild(content);
	card.appendChild(tagsRow);
	if (noteToolsRow) card.appendChild(noteToolsRow);

	return card;
}

/* ======================
   STACK TAB
====================== */

const TOOL_COLORS = ["#1a73e8","#188038","#e91e8c","#f59e0b","#9c27b0","#ef4444","#06b6d4","#FCFF4B"];

function renderStackTab(project) {
	if (!project.tools) project.tools = [];

	const container = document.createElement("div");
	container.classList.add("stack-tab");

	const header = document.createElement("div");
	header.classList.add("stack-header");

	const title = document.createElement("h3");
	title.style.cssText = "font-size:1rem;font-weight:700;color:var(--palette-dark);margin:0;";
	title.textContent = "Stack";

	const addBtn = document.createElement("button");
	addBtn.classList.add("stack-add-btn");
	addBtn.textContent = "+ Add Tool";

	header.appendChild(title);
	header.appendChild(addBtn);
	container.appendChild(header);

	// Add-tool form (shown on click)
	const addForm = document.createElement("div");
	addForm.classList.add("stack-tool-edit-form");
	addForm.style.display = "none";
	addForm.style.borderTop = "none";
	addForm.style.borderRadius = "10px";
	addForm.style.border = "1px solid var(--md-field-border)";

	const nameInput = document.createElement("input");
	nameInput.classList.add("stack-tool-input");
	nameInput.placeholder = "Tool name (e.g. React)";

	const descInput = document.createElement("input");
	descInput.classList.add("stack-tool-input");
	descInput.placeholder = "Short description (optional)";

	const urlInput = document.createElement("input");
	urlInput.classList.add("stack-tool-input");
	urlInput.placeholder = "URL (optional)";

	const colorRow = document.createElement("div");
	colorRow.classList.add("stack-tool-edit-row");
	let selectedColor = TOOL_COLORS[0];

	TOOL_COLORS.forEach(hex => {
		const btn = document.createElement("button");
		btn.classList.add("stack-tool-color-btn");
		btn.style.background = hex;
		if (hex === selectedColor) btn.classList.add("active");
		btn.addEventListener("click", () => {
			selectedColor = hex;
			colorRow.querySelectorAll(".stack-tool-color-btn").forEach(b => b.classList.remove("active"));
			btn.classList.add("active");
		});
		colorRow.appendChild(btn);
	});

	const saveBtn = document.createElement("button");
	saveBtn.classList.add("stack-tool-save-btn");
	saveBtn.textContent = "Add Tool";

	saveBtn.addEventListener("click", () => {
		const name = nameInput.value.trim();
		if (!name) { nameInput.focus(); return; }
		project.tools.push({
			id: self.crypto.randomUUID(),
			name,
			description: descInput.value.trim(),
			url: urlInput.value.trim(),
			color: selectedColor,
		});
		saveProjects();
		nameInput.value = ""; descInput.value = ""; urlInput.value = "";
		addForm.style.display = "none";
		renderTools();
	});

	addBtn.addEventListener("click", () => {
		addForm.style.display = addForm.style.display === "none" ? "flex" : "none";
		if (addForm.style.display === "flex") nameInput.focus();
	});

	addForm.appendChild(nameInput);
	addForm.appendChild(descInput);
	addForm.appendChild(urlInput);
	addForm.appendChild(colorRow);
	addForm.appendChild(saveBtn);
	container.appendChild(addForm);

	const toolsList = document.createElement("div");
	toolsList.classList.add("stack-tools-list");
	container.appendChild(toolsList);

	function renderTools() {
		toolsList.innerHTML = "";

		if (project.tools.length === 0) {
			const empty = document.createElement("div");
			empty.classList.add("stack-empty-tools");
			empty.textContent = "No tools yet — click + Add Tool to start.";
			toolsList.appendChild(empty);
			return;
		}

		project.tools.forEach((tool, toolIdx) => {
			const row = document.createElement("div");
			row.classList.add("stack-tool-row");

			// Count todos using this tool
			const relatedTodos = project.todos.filter(t =>
				Array.isArray(t.toolIds) && t.toolIds.includes(tool.id)
			);

			const hdr = document.createElement("div");
			hdr.classList.add("stack-tool-header");

			const dot = document.createElement("span");
			dot.classList.add("stack-tool-color-dot");
			dot.style.background = tool.color || "#888";

			const name = document.createElement("span");
			name.classList.add("stack-tool-name");
			name.textContent = tool.name;

			const desc = document.createElement("span");
			desc.classList.add("stack-tool-desc");
			desc.textContent = tool.description || (tool.url || "");

			const count = document.createElement("span");
			count.classList.add("stack-tool-count");
			count.textContent = `${relatedTodos.length} card${relatedTodos.length !== 1 ? "s" : ""}`;

			const actions = document.createElement("div");
			actions.classList.add("stack-tool-actions");

			const delBtn = document.createElement("button");
			delBtn.classList.add("stack-tool-delete-btn");
			delBtn.title = "Delete tool";
			delBtn.textContent = "✕";
			delBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				// Remove this tool from all todos
				project.todos.forEach(t => {
					if (Array.isArray(t.toolIds)) t.toolIds = t.toolIds.filter(id => id !== tool.id);
				});
				project.tools.splice(toolIdx, 1);
				saveProjects();
				renderTools();
			});

			const chevron = document.createElement("span");
			chevron.classList.add("stack-tool-chevron");
			chevron.textContent = "▾";

			actions.appendChild(delBtn);
			hdr.appendChild(dot);
			hdr.appendChild(name);
			hdr.appendChild(desc);
			hdr.appendChild(count);
			hdr.appendChild(actions);
			hdr.appendChild(chevron);

			// Expanded body (todos using this tool)
			const body = document.createElement("div");
			body.classList.add("stack-tool-expanded-body");

			hdr.addEventListener("click", (e) => {
				if (e.target.closest(".stack-tool-actions")) return;
				row.classList.toggle("expanded");
				if (row.classList.contains("expanded") && body.children.length === 0) {
					buildExpandedBody();
				}
			});

			function buildExpandedBody() {
				body.innerHTML = "";
				if (relatedTodos.length === 0) {
					const msg = document.createElement("div");
					msg.style.cssText = "font-size:0.8rem;color:var(--md-label-color);padding:8px 0;";
					msg.textContent = "No cards assigned to this tool yet.";
					body.appendChild(msg);
					return;
				}
				relatedTodos.forEach(todo => {
					const item = document.createElement("div");
					item.classList.add("stack-todo-item");
					const t = document.createElement("span");
					t.classList.add("stack-todo-title");
					t.textContent = todo.title || "Untitled";
					const s = document.createElement("span");
					s.classList.add("stack-todo-status");
					s.textContent = todo.status || "";
					item.appendChild(t);
					item.appendChild(s);
					body.appendChild(item);
				});
			}

			row.appendChild(hdr);
			row.appendChild(body);
			toolsList.appendChild(row);
		});
	}

	renderTools();
	todoContainer.innerHTML = "";
	todoContainer.appendChild(container);
}

/* ======================
   KANBAN COLUMN BUILDER (shared)
====================== */

function buildKanbanColumn(col, project, epicId, filterByEpic) {
	const accent = col.isCompleted ? "#9e9e9e" : col.color;

	const column = document.createElement("div");
	column.classList.add("kanban-column");
	if (col.isCompleted) column.classList.add("is-completed");
	column.style.setProperty("--col-color", accent);
	column.dataset.colId = col.id;

	const colHeader = document.createElement("div");
	colHeader.classList.add("kanban-header");

	const colLabel = document.createElement("span");
	colLabel.classList.add("kanban-label");
	colLabel.textContent = col.label;

	const colCount = document.createElement("span");
	colCount.classList.add("kanban-count");

	colHeader.appendChild(colLabel);
	colHeader.appendChild(colCount);

	const cardArea = document.createElement("div");
	cardArea.classList.add("kanban-cards");

	cardArea.addEventListener("dragover", (e) => {
		if (!dragState?.todoIds) return;
		e.preventDefault();
		e.stopPropagation();
		cardArea.classList.add("drag-over");
	});
	cardArea.addEventListener("dragleave", () => cardArea.classList.remove("drag-over"));
	cardArea.addEventListener("drop", (e) => {
		e.preventDefault();
		e.stopPropagation();
		cardArea.classList.remove("drag-over");
		if (!dragState?.todoIds) return;
		dragState.todoIds.forEach(todoId => {
			let todo;
			if (dragState.source === "inbox") {
				todo = inbox.find(t => t.id === todoId);
				if (todo) inbox.splice(inbox.indexOf(todo), 1);
			} else {
				const src = projects.find(p => p.id === dragState.projectId);
				todo = src?.todos.find(t => t.id === todoId);
				if (todo) src.removeTodo(todoId);
			}
			if (todo) {
				todo.status = col.label;
				if (filterByEpic) todo.epicId = epicId;
				getCurrentProject().addTodo(todo);
			}
		});
		selectedTodos.clear();
		dragState = null;
		saveInbox();
		saveProjects();
		renderProjects();
		renderTodos();
	});

	const todos = filterByEpic
		? sortedArray(project.todos.filter(t => {
			if (epicId === null) return !t.epicId || !project.epics.some(e => e.id === t.epicId);
			return t.epicId === epicId;
		}).filter(t => t.status === col.label)
		  .filter(t => !stackToolFilter || (Array.isArray(t.toolIds) && t.toolIds.includes(stackToolFilter)))
		  .filter(t => !todoTagFilter || (Array.isArray(t.tags) && t.tags.includes(todoTagFilter)))
		  .filter(t => todoMatchesSearch(t, project.code)))
		: [];

	todos.forEach(todo => {
		const card = buildTodoCard(todo, {
			save: () => { saveProjects(); renderTodos(); },
			delete: () => {
				const index = project.todos.findIndex(t => t.id === todo.id);
				project.removeTodo(todo.id);
				saveProjects();
				renderTodos();
				showUndoToast("Card deleted", () => {
					project.todos.splice(index, 0, todo);
					saveProjects();
					renderTodos();
				});
			},
			isInbox: false,
			project,
		});
		cardArea.appendChild(card);
	});

	colCount.textContent = cardArea.children.length;

	column.appendChild(colHeader);
	column.appendChild(cardArea);
	return { column, cardArea, colCount };
}

/* ======================
   SWIMLANES
====================== */

function renderSwimlaneTodos(project) {
	todoContainer.classList.add("swimlane-mode");

	const renderSwimlane = (epicId, epicTitle, isNoEpic, collapsed) => {
		// Apply epic filter (no-epic is always shown)
		if (!isNoEpic && epicFilterIds.size > 0 && !epicFilterIds.has(epicId)) return;

		const swimlane = document.createElement("div");
		swimlane.classList.add("swimlane");
		if (isNoEpic) swimlane.classList.add("swimlane-no-epic");
		if (collapsed) swimlane.classList.add("collapsed");

		// Header
		const header = document.createElement("div");
		header.classList.add("swimlane-header");

		// Collapse button (both No Epic and regular epics)
		const collapseBtn = document.createElement("button");
		collapseBtn.classList.add("swimlane-collapse-btn");
		collapseBtn.textContent = collapsed ? "▶" : "▼";
		collapseBtn.addEventListener("click", () => {
			if (isNoEpic) {
				project.noEpicCollapsed = !project.noEpicCollapsed;
			} else {
				const epic = project.epics.find(e => e.id === epicId);
				if (epic) epic.collapsed = !epic.collapsed;
			}
			saveProjects();
			const isNowCollapsed = isNoEpic ? project.noEpicCollapsed : (project.epics.find(e => e.id === epicId)?.collapsed ?? false);
			collapseBtn.textContent = isNowCollapsed ? "▶" : "▼";
			swimlane.classList.toggle("collapsed", isNowCollapsed);
			const board = swimlane.querySelector(".swimlane-board");
			if (board) board.style.display = isNowCollapsed ? "none" : "";
		});
		header.appendChild(collapseBtn);

		const titleEl = document.createElement("span");
		titleEl.classList.add("swimlane-title");
		titleEl.textContent = epicTitle;

		if (!isNoEpic) {
			titleEl.title = "Double-click to rename";
			titleEl.addEventListener("dblclick", () => {
				const input = document.createElement("input");
				input.classList.add("swimlane-title-input");
				input.value = epicTitle;
				titleEl.replaceWith(input);
				input.focus();
				input.select();
				function save() {
					const epic = project.epics.find(e => e.id === epicId);
					if (epic) { epic.title = input.value.trim() || epic.title; saveProjects(); }
					renderTodos();
				}
				input.addEventListener("blur", save);
				input.addEventListener("keydown", e => {
					if (e.key === "Enter") input.blur();
					if (e.key === "Escape") renderTodos();
				});
			});
		}

		// Count todos for this epic
		const epicTodos = isNoEpic
			? project.todos.filter(t => !t.epicId || !project.epics.some(e => e.id === t.epicId))
			: project.todos.filter(t => t.epicId === epicId);

		const countEl = document.createElement("span");
		countEl.classList.add("swimlane-count");
		countEl.textContent = epicTodos.length;

		const addCardBtn = document.createElement("button");
		addCardBtn.classList.add("swimlane-add-btn");
		addCardBtn.textContent = "+ Add card";
		addCardBtn.addEventListener("click", () => showEpicAddForm(isNoEpic ? null : epicId));

		header.appendChild(titleEl);
		header.appendChild(countEl);
		header.appendChild(addCardBtn);

		if (!isNoEpic) {
			const deleteBtn = document.createElement("button");
			deleteBtn.classList.add("swimlane-delete-btn");
			deleteBtn.textContent = "✕";
			deleteBtn.title = "Delete epic";
			deleteBtn.addEventListener("click", () => showEpicDeleteModal(epicId, project));
			header.appendChild(deleteBtn);
		}

		swimlane.appendChild(header);

		const board = document.createElement("div");
		board.classList.add("swimlane-board");
		if (collapsed) board.style.display = "none";

		// Project-wide columns + epic-specific extra columns
		const epic = isNoEpic ? null : project.epics.find(e => e.id === epicId);
		const epicCols = epic?.extraColumns || [];
		const allCols = [...columns, ...epicCols];

		allCols.forEach(col => {
			const { column } = buildKanbanColumn(col, project, isNoEpic ? null : epicId, true);
			// Epic-specific columns get a delete button in their header
			if (!isNoEpic && epicCols.includes(col)) {
				const colHeader = column.querySelector(".kanban-header");
				const delColBtn = document.createElement("button");
				delColBtn.classList.add("swimlane-delete-col-btn");
				delColBtn.textContent = "✕";
				delColBtn.title = "Remove this column";
				delColBtn.addEventListener("click", () => {
					epic.extraColumns = epic.extraColumns.filter(c => c.id !== col.id);
					saveProjects();
					renderTodos();
				});
				colHeader.appendChild(delColBtn);
			}
			board.appendChild(column);
		});

		if (!isNoEpic) {
			const addColBtn = document.createElement("button");
			addColBtn.classList.add("swimlane-add-col-btn");
			addColBtn.textContent = "+ Column";
			addColBtn.addEventListener("click", () => {
				const name = prompt("Column name:");
				if (!name?.trim()) return;
				if (!epic.extraColumns) epic.extraColumns = [];
				const COL_PALETTE = ["#9c27b0","#e91e63","#00bcd4","#ff5722","#3f51b5","#009688"];
				const color = COL_PALETTE[epic.extraColumns.length % COL_PALETTE.length];
				epic.extraColumns.push({ id: self.crypto.randomUUID(), label: name.trim(), color, isCompleted: false });
				saveProjects();
				renderTodos();
			});
			board.appendChild(addColBtn);
		}

		swimlane.appendChild(board);
		todoContainer.appendChild(swimlane);
	};

	// "No Epic" swimlane first
	renderSwimlane(null, "No Epic", true, project.noEpicCollapsed || false);

	// Each defined epic
	project.epics.forEach(epic => {
		renderSwimlane(epic.id, epic.title, false, epic.collapsed || false);
	});

	// Add Epic button
	const addEpicBtn = document.createElement("button");
	addEpicBtn.classList.add("add-epic-btn");
	addEpicBtn.textContent = "+ Add Epic";
	addEpicBtn.addEventListener("click", () => {
		const newEpic = { id: self.crypto.randomUUID(), title: "New Epic", collapsed: false, extraColumns: [] };
		project.epics.push(newEpic);
		saveProjects();
		renderTodos();
	});
	todoContainer.appendChild(addEpicBtn);
}

/* ======================
   FLAT KANBAN
====================== */

function renderFlatKanban(project) {
	const COL_PALETTE = ["#6b7280","#1a73e8","#188038","#f59e0b","#9c27b0","#e91e63","#00bcd4","#ff5722"];

	const columnCards = {};

	columns.forEach((col) => {
		const accent = col.isCompleted ? "#9e9e9e" : col.color;

		const column = document.createElement("div");
		column.classList.add("kanban-column");
		if (col.isCompleted) column.classList.add("is-completed");
		column.style.setProperty("--col-color", accent);
		column.dataset.colId = col.id;

		column.addEventListener("dragover", (e) => {
			if (!e.dataTransfer.types.includes("text/col-id")) return;
			e.preventDefault();
			column.classList.add("drag-over");
		});
		column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
		column.addEventListener("drop", (e) => {
			e.preventDefault();
			column.classList.remove("drag-over");
			const draggedId = e.dataTransfer.getData("text/col-id");
			if (!draggedId || draggedId === col.id) return;
			const fromIndex = columns.findIndex(c => c.id === draggedId);
			const toIndex = columns.findIndex(c => c.id === col.id);
			const [moved] = columns.splice(fromIndex, 1);
			columns.splice(toIndex, 0, moved);
			saveColumns();
			renderTodos();
		});

		// ── Column header ──
		const colHeader = document.createElement("div");
		colHeader.classList.add("kanban-header");

		const colLabel = document.createElement("span");
		colLabel.classList.add("kanban-label");
		colLabel.textContent = col.label;
		colLabel.title = "Click to rename";

		colLabel.addEventListener("click", () => {
			const input = document.createElement("input");
			input.classList.add("kanban-label-input");
			input.value = col.label;
			colLabel.replaceWith(input);
			input.focus();
			input.select();

			function commitRename() {
				const newLabel = input.value.trim() || col.label;
				if (newLabel !== col.label) {
					projects.forEach(p => p.todos.forEach(t => {
						if (t.status === col.label) t.status = newLabel;
					}));
					col.label = newLabel;
					saveColumns();
					saveProjects();
				}
				renderTodos();
			}

			input.addEventListener("blur", commitRename);
			input.addEventListener("keydown", e => {
				if (e.key === "Enter") input.blur();
				if (e.key === "Escape") renderTodos();
			});
		});

		const colCount = document.createElement("span");
		colCount.classList.add("kanban-count");

		const colControls = document.createElement("div");
		colControls.classList.add("kanban-controls");

		const completedToggle = document.createElement("button");
		completedToggle.classList.add("kanban-completed-toggle");
		if (col.isCompleted) completedToggle.classList.add("active");
		completedToggle.title = col.isCompleted ? "Unmark as completed column" : "Mark as completed column";

		completedToggle.addEventListener("click", () => {
			col.isCompleted = !col.isCompleted;
			saveColumns();
			renderTodos();
		});

		colControls.appendChild(completedToggle);

		if (columns.length > 1) {
			const deleteColBtn = document.createElement("button");
			deleteColBtn.classList.add("kanban-delete-col");
			deleteColBtn.title = "Delete column";
			deleteColBtn.addEventListener("click", () => showColumnDeleteModal(col));
			colControls.appendChild(deleteColBtn);
		}

		const dragHandle = document.createElement("span");
		dragHandle.classList.add("kanban-drag-handle");
		dragHandle.title = "Drag to reorder";
		dragHandle.draggable = true;
		dragHandle.addEventListener("dragstart", (e) => {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/col-id", col.id);
			column.classList.add("dragging");
		});
		dragHandle.addEventListener("dragend", () => column.classList.remove("dragging"));

		colHeader.appendChild(dragHandle);
		colHeader.appendChild(colLabel);
		colHeader.appendChild(colCount);
		colHeader.appendChild(colControls);

		const cardArea = document.createElement("div");
		cardArea.classList.add("kanban-cards");

		cardArea.addEventListener("dragover", (e) => {
			if (!dragState?.todoIds) return;
			e.preventDefault();
			e.stopPropagation();
			cardArea.classList.add("drag-over");
		});
		cardArea.addEventListener("dragleave", () => cardArea.classList.remove("drag-over"));
		cardArea.addEventListener("drop", (e) => {
			e.preventDefault();
			e.stopPropagation();
			cardArea.classList.remove("drag-over");
			if (!dragState?.todoIds) return;
			dragState.todoIds.forEach(todoId => {
				let todo;
				if (dragState.source === "inbox") {
					todo = inbox.find(t => t.id === todoId);
					if (todo) { inbox.splice(inbox.indexOf(todo), 1); }
				} else {
					const src = projects.find(p => p.id === dragState.projectId);
					todo = src?.todos.find(t => t.id === todoId);
					if (todo) src.removeTodo(todoId);
				}
				if (todo) {
					todo.status = col.label;
					getCurrentProject().addTodo(todo);
				}
			});
			selectedTodos.clear();
			dragState = null;
			saveInbox();
			saveProjects();
			renderProjects();
			renderTodos();
		});

		column.appendChild(colHeader);
		column.appendChild(cardArea);
		todoContainer.appendChild(column);

		columnCards[col.id] = { cardArea, colCount };
	});

	// Add-column button
	const addColBtn = document.createElement("button");
	addColBtn.classList.add("kanban-add-col");
	addColBtn.textContent = "+ Add column";

	addColBtn.addEventListener("click", () => {
		const used = columns.map(c => c.color);
		const nextColor = COL_PALETTE.find(c => !used.includes(c)) || COL_PALETTE[columns.length % COL_PALETTE.length];
		const newCol = { id: self.crypto.randomUUID(), label: "New Column", isCompleted: false, color: nextColor };
		columns.push(newCol);
		saveColumns();
		renderTodos();
	});

	todoContainer.appendChild(addColBtn);

	sortedArray(project.todos)
		.filter(t => !stackToolFilter || (Array.isArray(t.toolIds) && t.toolIds.includes(stackToolFilter)))
		.filter(t => !todoTagFilter || (Array.isArray(t.tags) && t.tags.includes(todoTagFilter)))
		.filter(t => todoMatchesSearch(t, project.code))
		.forEach((todo) => {
		const card = buildTodoCard(todo, {
			save: () => { saveProjects(); renderTodos(); },
			delete: () => {
				const index = project.todos.findIndex(t => t.id === todo.id);
				project.removeTodo(todo.id);
				saveProjects();
				renderTodos();
				showUndoToast("Card deleted", () => {
					project.todos.splice(index, 0, todo);
					saveProjects();
					renderTodos();
				});
			},
			isInbox: false,
			project,
		});

		const matchedCol = columns.find(c => c.label === todo.status);
		const targetCol = matchedCol ? columnCards[matchedCol.id] : Object.values(columnCards)[0];
		targetCol.cardArea.appendChild(card);
	});

	Object.values(columnCards).forEach(({ cardArea, colCount }) => {
		colCount.textContent = cardArea.children.length;
	});
}

/* ======================
   TOUCH DRAG
====================== */

function addCardTouchDrag(todoCard, todo, ctx) {
	let pressTimer = null;
	let startTouch = null;
	let isDragging = false;

	todoCard.addEventListener("touchstart", (e) => {
		if (e.touches.length > 1) return;
		startTouch = e.touches[0];
		isDragging = false;
		pressTimer = setTimeout(() => {
			pressTimer = null;
			isDragging = true;
			if (!selectedTodos.has(todo.id)) {
				selectedTodos.clear();
				document.querySelectorAll(".todo-card.selected").forEach(c => c.classList.remove("selected"));
				selectedTodos.add(todo.id);
				todoCard.classList.add("selected");
				renderSelectionBar();
			}
			dragState = {
				todoIds: [...selectedTodos],
				source: ctx.isInbox ? "inbox" : "project",
				projectId: ctx.isInbox ? null : currentProjectId,
			};
			const rect = todoCard.getBoundingClientRect();
			const ghost = todoCard.cloneNode(true);
			ghost.classList.add("touch-drag-ghost");
			ghost.style.width = rect.width + "px";
			ghost.style.left = rect.left + "px";
			ghost.style.top = rect.top + "px";
			document.body.appendChild(ghost);
			touchDrag = { ghost, offsetX: startTouch.clientX - rect.left, offsetY: startTouch.clientY - rect.top };
			todoCard.style.opacity = "0.35";
		}, 400);
	}, { passive: true });

	todoCard.addEventListener("touchmove", (e) => {
		if (pressTimer) {
			const t = e.touches[0];
			if (Math.abs(t.clientX - startTouch.clientX) > 8 || Math.abs(t.clientY - startTouch.clientY) > 8) {
				clearTimeout(pressTimer); pressTimer = null;
			}
		}
		if (!isDragging || !touchDrag) return;
		e.preventDefault();
		const t = e.touches[0];
		touchDrag.ghost.style.left = (t.clientX - touchDrag.offsetX) + "px";
		touchDrag.ghost.style.top = (t.clientY - touchDrag.offsetY) + "px";
		// highlight drop targets
		document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
		touchDrag.ghost.style.pointerEvents = "none";
		const el = document.elementFromPoint(t.clientX, t.clientY);
		touchDrag.ghost.style.pointerEvents = "";
		if (el) {
			const ca = el.closest(".kanban-cards"); const pi = el.closest(".project-item[data-project-id]"); const ii = el.closest(".inbox-sidebar-item"); const ic = el.closest(".inbox-col");
			if (ca) ca.classList.add("drag-over");
			else if (pi) pi.classList.add("drag-over");
			else if (ii) ii.classList.add("drag-over");
			else if (ic) ic.classList.add("drag-over");
		}
	}, { passive: false });

	const endDrag = (e) => {
		if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
		if (!isDragging || !touchDrag) { isDragging = false; return; }
		isDragging = false;
		const t = (e.changedTouches || e.touches)[0];
		touchDrag.ghost.style.pointerEvents = "none";
		const el = t ? document.elementFromPoint(t.clientX, t.clientY) : null;
		touchDrag.ghost.remove(); touchDrag = null;
		todoCard.style.opacity = "";
		document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
		if (!el || !dragState?.todoIds) { dragState = null; return; }

		const ca = el.closest(".kanban-cards"); const pi = el.closest(".project-item[data-project-id]"); const ii = el.closest(".inbox-sidebar-item"); const ic = el.closest(".inbox-col");
		if (ca) {
			const col = columns.find(c => c.id === ca.closest(".kanban-column")?.dataset.colId);
			if (col) {
				dragState.todoIds.forEach(id => {
					let t2;
					if (dragState.source === "inbox") { t2 = inbox.find(x => x.id === id); if (t2) inbox.splice(inbox.indexOf(t2), 1); }
					else { const src = projects.find(p => p.id === dragState.projectId); t2 = src?.todos.find(x => x.id === id); if (t2) src.removeTodo(id); }
					if (t2) { t2.status = col.label; getCurrentProject().addTodo(t2); }
				});
				selectedTodos.clear(); dragState = null; saveInbox(); saveProjects(); renderProjects(); renderTodos(); return;
			}
		}
		if (pi) {
			const tp = projects.find(p => p.id === pi.dataset.projectId);
			if (tp) {
				dragState.todoIds.forEach(id => {
					let t2;
					if (dragState.source === "inbox") { t2 = inbox.find(x => x.id === id); if (t2) inbox.splice(inbox.indexOf(t2), 1); }
					else { if (dragState.projectId === tp.id) return; const src = projects.find(p => p.id === dragState.projectId); t2 = src?.todos.find(x => x.id === id); if (t2) src.removeTodo(id); }
					if (t2) { const v = getColumnLabels(); if (!v.includes(t2.status)) t2.status = v.find(l => l.toLowerCase().includes("progress")) || v[0]; t2.epicId = null; tp.addTodo(t2); }
				});
				selectedTodos.clear(); dragState = null; saveInbox(); saveProjects(); renderProjects(); renderTodos(); return;
			}
		}
		if (ii || ic) {
			if (dragState.source !== "inbox") {
				dragState.todoIds.forEach(id => { const src = projects.find(p => p.id === dragState.projectId); const t2 = src?.todos.find(x => x.id === id); if (t2) { src.removeTodo(id); inbox.push(t2); } });
				selectedTodos.clear(); dragState = null; saveInbox(); saveProjects(); renderProjects();
				if (currentView === "inbox") renderInbox(); else renderTodos(); return;
			}
		}
		dragState = null;
	};

	todoCard.addEventListener("touchend", endDrag);
	todoCard.addEventListener("touchcancel", endDrag);
}

/* ======================
   RENDER
====================== */

function renderInbox() {
	currentView = "inbox";
	searchQuery = "";
	addTodoBtn.style.display = "none";
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.remove("overview-view");
	projectTitle.textContent = "Inbox";
	projectCodeBadge.style.display = "none";

	projectTabsContainer.innerHTML = "";

	sortBarContainer.innerHTML = "";
	sortBarContainer.appendChild(buildSortBar(inbox, renderInbox));

	const grid = document.createElement("div");
	grid.classList.add("inbox-grid");

	const COL_WIDTH = 300;
	const COL_GAP = 16;
	const available = todoContainer.offsetWidth - 48;
	const NUM_COLS = Math.max(1, Math.floor((available + COL_GAP) / (COL_WIDTH + COL_GAP)));
	const cols = Array.from({ length: NUM_COLS }, () => {
		const col = document.createElement("div");
		col.classList.add("inbox-col");

		col.addEventListener("dragover", (e) => {
			if (!dragState?.todoIds) return;
			e.preventDefault();
			col.classList.add("drag-over");
		});
		col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
		col.addEventListener("drop", (e) => {
			e.preventDefault();
			col.classList.remove("drag-over");
			if (!dragState?.todoIds) return;
			dragState.todoIds.forEach(todoId => {
				if (dragState.source === "inbox") return;
				const src = projects.find(p => p.id === dragState.projectId);
				const todo = src?.todos.find(t => t.id === todoId);
				if (todo) { src.removeTodo(todoId); inbox.push(todo); }
			});
			selectedTodos.clear();
			dragState = null;
			saveInbox();
			saveProjects();
			renderProjects();
			renderInbox();
		});

		grid.appendChild(col);
		return col;
	});

	const inboxSorted = (sortBy === "default" ? [...inbox].reverse() : sortedArray(inbox))
		.filter(t => todoMatchesSearch(t, ""));

	inboxSorted.forEach((todo, i) => {
		const card = buildTodoCard(todo, {
			save: () => { saveInbox(); renderInbox(); },
			delete: () => {
				const index = inbox.indexOf(todo);
				inbox.splice(index, 1);
				saveInbox();
				renderInbox();
				showUndoToast("Card deleted", () => {
					inbox.splice(index, 0, todo);
					saveInbox();
					renderInbox();
				});
			},
			isInbox: true,
		});
		cols[i % NUM_COLS].appendChild(card);
	});

	todoContainer.appendChild(grid);
	renderSelectionBar();
}

/* ======================
   OVERVIEW
====================== */

function renderOverview() {
	addTodoBtn.style.display = "none";
	searchQuery = "";
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.add("overview-view");
	projectTitle.textContent = "Overview";
	projectCodeBadge.style.display = "none";
	sortBarContainer.innerHTML = "";

	// Tab bar: Dashboard | Notes (uses same project-tab-bar style)
	projectTabsContainer.innerHTML = "";
	const tabBar = document.createElement("div");
	tabBar.classList.add("project-tab-bar");

	[{ id: "dashboard", label: "Dashboard" }, { id: "notes", label: "Notes" }].forEach(({ id, label }) => {
		const btn = document.createElement("button");
		btn.classList.add("project-tab");
		if (overviewTab === id) btn.classList.add("active");
		btn.textContent = label;
		btn.addEventListener("click", () => {
			overviewTab = id;
			renderOverview();
		});
		tabBar.appendChild(btn);
	});
	projectTabsContainer.appendChild(tabBar);

	if (overviewTab === "notes") {
		renderOverviewNotes();
		return;
	}

	const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
	const now = Date.now();
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

	const allProjectTodos = projects.flatMap(p => p.todos);
	const allTodos = [...allProjectTodos, ...inbox];

	const totalCount = allTodos.length;
	const completedCount = allTodos.filter(t => completedLabels.includes(t.status)).length;
	const highPriorityCount = allTodos.filter(t => (t.priority || "").toLowerCase() === "high").length;
	const overdueCount = allTodos.filter(t => {
		if (!t.dueDate || completedLabels.includes(t.status)) return false;
		return new Date(t.dueDate).getTime() < now;
	}).length;

	// Stats row
	const statsRow = document.createElement("div");
	statsRow.classList.add("overview-stats-row");

	[
		{ label: "Total", value: totalCount },
		{ label: "Completed", value: completedCount },
		{ label: "High Priority", value: highPriorityCount },
		{ label: "Overdue", value: overdueCount },
		{ label: "In Inbox", value: inbox.length },
	].forEach(stat => {
		const card = document.createElement("div");
		card.classList.add("overview-stat-card");
		if (stat.label === "Overdue" && overdueCount > 0) card.classList.add("is-overdue");
		const val = document.createElement("div");
		val.classList.add("overview-stat-value");
		val.textContent = stat.value;
		const lbl = document.createElement("div");
		lbl.classList.add("overview-stat-label");
		lbl.textContent = stat.label;
		card.append(val, lbl);
		statsRow.appendChild(card);
	});

	todoContainer.appendChild(statsRow);

	// Per-project section
	if (projects.length > 0) {
		const projSection = document.createElement("div");
		projSection.classList.add("overview-section");
		const projHeading = document.createElement("h3");
		projHeading.classList.add("overview-section-title");
		projHeading.textContent = "Projects";
		projSection.appendChild(projHeading);

		const projGrid = document.createElement("div");
		projGrid.classList.add("overview-projects-grid");

		projects.forEach(project => {
			const todos = project.todos;
			const total = todos.length;
			const done = todos.filter(t => completedLabels.includes(t.status)).length;
			const pct = total > 0 ? Math.round((done / total) * 100) : 0;

			const projCard = document.createElement("div");
			projCard.classList.add("overview-project-card");
			projCard.addEventListener("click", () => {
				currentProjectId = project.id;
				currentView = "project";
				currentProjectTab = "board";
				selectedTodos.clear();
				renderTodos();
				renderProjects();
			});

			const projName = document.createElement("div");
			projName.classList.add("overview-project-name");
			projName.textContent = project.title;

			const progressRow = document.createElement("div");
			progressRow.classList.add("overview-progress-row");

			const bar = document.createElement("div");
			bar.classList.add("overview-progress-bar");
			const fill = document.createElement("div");
			fill.classList.add("overview-progress-fill");
			fill.style.width = `${pct}%`;
			bar.appendChild(fill);

			const pctLabel = document.createElement("span");
			pctLabel.classList.add("overview-progress-label");
			pctLabel.textContent = `${done}/${total}`;

			progressRow.append(bar, pctLabel);

			const statusRow = document.createElement("div");
			statusRow.classList.add("overview-status-row");

			columns.forEach(col => {
				const count = todos.filter(t => t.status === col.label).length;
				if (count === 0) return;
				const chip = document.createElement("span");
				chip.classList.add("overview-status-chip");
				chip.style.setProperty("--chip-color", col.isCompleted ? "#9e9e9e" : col.color);
				chip.textContent = `${col.label} ${count}`;
				statusRow.appendChild(chip);
			});

			projCard.append(projName, progressRow, statusRow);
			projGrid.appendChild(projCard);
		});

		projSection.appendChild(projGrid);
		todoContainer.appendChild(projSection);
	}

	// Due soon section
	const dueSoon = allTodos.filter(t => {
		if (!t.dueDate || completedLabels.includes(t.status)) return false;
		const due = new Date(t.dueDate).getTime();
		return due >= now && due <= now + sevenDaysMs;
	}).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

	if (dueSoon.length > 0) {
		const dueSection = document.createElement("div");
		dueSection.classList.add("overview-section");
		const dueHeading = document.createElement("h3");
		dueHeading.classList.add("overview-section-title");
		dueHeading.textContent = "Due in the next 7 days";
		dueSection.appendChild(dueHeading);

		const dueList = document.createElement("div");
		dueList.classList.add("overview-due-list");

		dueSoon.forEach(todo => {
			const item = document.createElement("div");
			item.classList.add("overview-due-item");

			const titleEl = document.createElement("span");
			titleEl.classList.add("overview-due-title");
			titleEl.textContent = todo.title || "(Untitled)";

			const ownerProject = projects.find(p => p.todos.some(t => t.id === todo.id));
			const contextEl = document.createElement("span");
			contextEl.classList.add("overview-due-context");
			contextEl.textContent = ownerProject ? ownerProject.title : "Inbox";

			const dateEl = document.createElement("span");
			dateEl.classList.add("overview-due-date");
			dateEl.textContent = todo.dueDate;

			item.append(titleEl, contextEl, dateEl);
			dueList.appendChild(item);
		});

		dueSection.appendChild(dueList);
		todoContainer.appendChild(dueSection);
	}

	renderSelectionBar();
}

function renderOverviewNotes() {
	todoContainer.innerHTML = "";
	todoContainer.classList.add("overview-view");

	// Collect all project notes (with source project)
	const allProjectNotes = projects.flatMap(p =>
		(p.notes || []).map(n => ({ note: n, project: p }))
	);
	const generalNotes = userPrefs.generalNotes;

	// Build filter state
	let activeCategory = null;
	let activeTag = null;
	let noteSearchQuery = "";

	// Gather all unique categories and tags
	const allCategories = [...new Set([
		...allProjectNotes.map(({ note }) => note.category).filter(Boolean),
		...generalNotes.map(n => n.category).filter(Boolean),
	])];
	const allTags = [...new Set([
		...allProjectNotes.flatMap(({ note }) => note.tags || []),
		...generalNotes.flatMap(n => n.tags || []),
	])];

	const view = document.createElement("div");
	view.classList.add("overview-notes-view");

	// Search bar
	const searchRow = document.createElement("div");
	searchRow.classList.add("overview-notes-search-row");
	const noteSearchInput = document.createElement("input");
	noteSearchInput.type = "search";
	noteSearchInput.classList.add("notes-filter-input", "overview-notes-search-input");
	noteSearchInput.placeholder = "Search notes…";
	noteSearchInput.addEventListener("input", () => { noteSearchQuery = noteSearchInput.value; rebuildGrid(); });
	searchRow.appendChild(noteSearchInput);

	// Filter bar
	const filterRow = document.createElement("div");
	filterRow.classList.add("overview-notes-filter-row");

	function rebuildFilter() {
		filterRow.innerHTML = "";

		// Category group
		if (allCategories.length > 0) {
			const catGroup = document.createElement("div");
			catGroup.classList.add("overview-notes-filter-group");
			const catLabel = document.createElement("span");
			catLabel.classList.add("overview-notes-filter-label");
			catLabel.textContent = "Category:";
			catGroup.appendChild(catLabel);

			const allCat = document.createElement("button");
			allCat.classList.add("overview-notes-pill");
			if (!activeCategory) allCat.classList.add("active");
			allCat.textContent = "All";
			allCat.addEventListener("click", () => { activeCategory = null; rebuildFilter(); rebuildGrid(); });
			catGroup.appendChild(allCat);

			allCategories.forEach(cat => {
				const pill = document.createElement("button");
				pill.classList.add("overview-notes-pill");
				if (activeCategory === cat) pill.classList.add("active");
				pill.textContent = cat;
				pill.addEventListener("click", () => { activeCategory = cat; rebuildFilter(); rebuildGrid(); });
				catGroup.appendChild(pill);
			});
			filterRow.appendChild(catGroup);
		}

		// Tag group
		if (allTags.length > 0) {
			const tagGroup = document.createElement("div");
			tagGroup.classList.add("overview-notes-filter-group");
			const tagLabel = document.createElement("span");
			tagLabel.classList.add("overview-notes-filter-label");
			tagLabel.textContent = "Tag:";
			tagGroup.appendChild(tagLabel);

			const allTag = document.createElement("button");
			allTag.classList.add("overview-notes-pill");
			if (!activeTag) allTag.classList.add("active");
			allTag.textContent = "All";
			allTag.addEventListener("click", () => { activeTag = null; rebuildFilter(); rebuildGrid(); });
			tagGroup.appendChild(allTag);

			allTags.forEach(tag => {
				const pill = document.createElement("button");
				pill.classList.add("overview-notes-pill");
				if (activeTag === tag) pill.classList.add("active");
				pill.textContent = `#${tag}`;
				pill.addEventListener("click", () => { activeTag = tag; rebuildFilter(); rebuildGrid(); });
				tagGroup.appendChild(pill);
			});
			filterRow.appendChild(tagGroup);
		}
	}

	// Notes grid
	const grid = document.createElement("div");
	grid.classList.add("notes-grid");

	function rebuildGrid() {
		grid.innerHTML = "";

		// "Add General Note" — always first, top-left
		const addCard = document.createElement("div");
		addCard.classList.add("note-add-general-card");
		addCard.innerHTML = `<span class="note-add-general-icon">+</span><span>Add General Note</span>`;
		addCard.addEventListener("click", () => {
			const newNote = {
				id: self.crypto.randomUUID(),
				content: "",
				html: "",
				tags: [],
				category: "",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			userPrefs.generalNotes.unshift(newNote);
			saveUserPrefs();
			rebuildGrid();
		});
		grid.appendChild(addCard);

		const q = noteSearchQuery.toLowerCase();
		function matchesNoteSearch(note) {
			if (!noteSearchQuery) return true;
			return [note.content, note.html, note.category, ...(note.tags || [])].some(s => s?.toLowerCase().includes(q));
		}

		const filteredProjectNotes = allProjectNotes.filter(({ note }) => {
			if (activeCategory && note.category !== activeCategory) return false;
			if (activeTag && !(note.tags || []).includes(activeTag)) return false;
			if (!matchesNoteSearch(note)) return false;
			return true;
		});

		const filteredGeneral = generalNotes.filter(note => {
			if (activeCategory && note.category !== activeCategory) return false;
			if (activeTag && !(note.tags || []).includes(activeTag)) return false;
			if (!matchesNoteSearch(note)) return false;
			return true;
		});

		// General notes (right after add button)
		filteredGeneral.forEach(note => {
			const card = buildOverviewNoteCard(note, null, rebuildGrid, rebuildFilter);
			grid.appendChild(card);
		});

		// Project notes
		filteredProjectNotes.forEach(({ note, project }) => {
			const card = buildOverviewNoteCard(note, project, rebuildGrid, rebuildFilter);
			grid.appendChild(card);
		});
	}

	rebuildFilter();
	rebuildGrid();

	view.append(searchRow, filterRow, grid);
	todoContainer.appendChild(view);
}

function buildOverviewNoteCard(note, project, rebuildGrid, rebuildFilter) {
	const card = document.createElement("div");
	card.classList.add("note-card");

	// Project badge
	if (project && project.code) {
		const badge = document.createElement("span");
		badge.classList.add("note-card-project-badge");
		badge.textContent = project.code;
		card.appendChild(badge);
	} else if (!project) {
		const badge = document.createElement("span");
		badge.classList.add("note-card-project-badge");
		badge.style.background = "rgba(150,150,150,0.15)";
		badge.style.color = "#888";
		badge.textContent = "General";
		card.appendChild(badge);
	}

	// Format toolbar (same as project notes tab)
	const toolbar = document.createElement("div");
	toolbar.classList.add("note-card-toolbar");
	[
		{ cmd: "bold",               label: "<strong>B</strong>", title: "Bold" },
		{ cmd: "italic",             label: "<em>I</em>",          title: "Italic" },
		{ cmd: "insertUnorderedList", label: "• List",             title: "Bullet list" },
	].forEach(({ cmd, label, title }) => {
		const btn = document.createElement("button");
		btn.classList.add("note-fmt-btn");
		btn.innerHTML = label;
		btn.title = title;
		btn.type = "button";
		btn.addEventListener("mousedown", e => { e.preventDefault(); document.execCommand(cmd, false, null); });
		toolbar.appendChild(btn);
	});

	// Content area (rich text)
	const body = document.createElement("div");
	body.classList.add("note-card-content");
	body.contentEditable = "true";
	body.innerHTML = note.html || note.content || "";
	let saveTimeout;
	body.addEventListener("input", () => {
		clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => {
			note.html = body.innerHTML;
			note.content = body.innerText;
			note.updatedAt = Date.now();
			if (project) saveProjects();
			else saveUserPrefs();
		}, 400);
	});

	card.appendChild(toolbar);
	card.appendChild(body);

	// Tags row
	const tagsRow = document.createElement("div");
	tagsRow.classList.add("note-tags-row");

	function rebuildTagsRow() {
		tagsRow.innerHTML = "";
		(note.tags || []).forEach(tag => {
			const chip = document.createElement("span");
			chip.classList.add("note-tag-chip");
			chip.textContent = `#${tag}`;
			chip.addEventListener("click", () => {
				note.tags = note.tags.filter(t => t !== tag);
				note.updatedAt = Date.now();
				if (project) saveProjects(); else saveUserPrefs();
				rebuildTagsRow();
				rebuildFilter();
				rebuildGrid();
			});
			tagsRow.appendChild(chip);
		});

		const tagInput = document.createElement("input");
		tagInput.placeholder = "+ tag";
		tagInput.classList.add("note-tag-input");
		tagInput.addEventListener("keydown", e => {
			if (e.key === "Enter" || e.key === ",") {
				e.preventDefault();
				const val = tagInput.value.trim().replace(/^#/, "").toLowerCase();
				if (val && !(note.tags || []).includes(val)) {
					if (!note.tags) note.tags = [];
					note.tags.push(val);
					note.updatedAt = Date.now();
					if (project) saveProjects(); else saveUserPrefs();
					rebuildTagsRow();
					rebuildFilter();
				}
				tagInput.value = "";
			}
		});
		tagsRow.appendChild(tagInput);
	}

	rebuildTagsRow();
	card.appendChild(tagsRow);

	// Meta: category + delete
	const meta = document.createElement("div");
	meta.classList.add("note-meta");

	const catInput = document.createElement("input");
	catInput.classList.add("note-category-input");
	catInput.value = note.category || "";
	catInput.placeholder = "Category";
	catInput.addEventListener("blur", () => {
		note.category = catInput.value.trim().toUpperCase();
		catInput.value = note.category;
		note.updatedAt = Date.now();
		if (project) saveProjects(); else saveUserPrefs();
		rebuildFilter();
	});
	catInput.addEventListener("keydown", e => { if (e.key === "Enter") catInput.blur(); });

	const delBtn = document.createElement("button");
	delBtn.classList.add("note-delete-btn");
	delBtn.textContent = "×";
	delBtn.title = "Delete note";
	delBtn.addEventListener("click", () => {
		if (project) {
			project.notes = (project.notes || []).filter(n => n.id !== note.id);
			saveProjects();
		} else {
			userPrefs.generalNotes = userPrefs.generalNotes.filter(n => n.id !== note.id);
			saveUserPrefs();
		}
		rebuildGrid();
		rebuildFilter();
	});

	meta.append(catInput, delBtn);
	card.appendChild(meta);

	return card;
}

function buildStackFilterBar(project) {
	if (!project.tools?.length) return null;

	const bar = document.createElement("div");
	bar.classList.add("epic-filter-bar"); // reuse same styles

	const label = document.createElement("span");
	label.classList.add("stack-filter-label");
	label.textContent = "Tool:";
	bar.appendChild(label);

	const allPill = document.createElement("button");
	allPill.classList.add("stack-filter-pill");
	if (!stackToolFilter) allPill.classList.add("active");
	allPill.textContent = "All";
	allPill.addEventListener("click", () => { stackToolFilter = null; renderTodos(); });
	bar.appendChild(allPill);

	project.tools.forEach(tool => {
		const pill = document.createElement("button");
		pill.classList.add("stack-filter-pill");
		if (stackToolFilter === tool.id) pill.classList.add("active");

		const dot = document.createElement("span");
		dot.classList.add("tool-badge-dot");
		dot.style.cssText = `background:${tool.color || "#888"};width:8px;height:8px;display:inline-block;border-radius:50%;margin-right:5px;`;
		pill.appendChild(dot);
		pill.appendChild(document.createTextNode(tool.name));

		pill.addEventListener("click", () => {
			stackToolFilter = stackToolFilter === tool.id ? null : tool.id;
			renderTodos();
		});
		bar.appendChild(pill);
	});

	return bar;
}

function buildEpicFilterBar(project) {
	if (!project.epics.length) return null;

	const bar = document.createElement("div");
	bar.classList.add("epic-filter-bar");

	const allBtn = document.createElement("button");
	allBtn.classList.add("epic-filter-pill", "epic-filter-all");
	allBtn.textContent = "All epics";
	allBtn.classList.toggle("active", epicFilterIds.size === 0);
	allBtn.addEventListener("click", () => {
		epicFilterIds.clear();
		renderTodos();
	});
	bar.appendChild(allBtn);

	project.epics.forEach(epic => {
		const pill = document.createElement("button");
		pill.classList.add("epic-filter-pill");
		pill.textContent = epic.title;
		pill.classList.toggle("active", epicFilterIds.has(epic.id));
		pill.addEventListener("click", () => {
			if (epicFilterIds.has(epic.id)) {
				epicFilterIds.delete(epic.id);
			} else {
				epicFilterIds.add(epic.id);
			}
			renderTodos();
		});
		bar.appendChild(pill);
	});

	return bar;
}

function buildTodoTagFilterBar(tags) {
	const bar = document.createElement("div");
	bar.classList.add("epic-filter-bar");

	const label = document.createElement("span");
	label.classList.add("stack-filter-label");
	label.textContent = "Tag:";
	bar.appendChild(label);

	const allPill = document.createElement("button");
	allPill.classList.add("stack-filter-pill");
	if (!todoTagFilter) allPill.classList.add("active");
	allPill.textContent = "All";
	allPill.addEventListener("click", () => { todoTagFilter = null; renderTodos(); });
	bar.appendChild(allPill);

	tags.forEach(tag => {
		const pill = document.createElement("button");
		pill.classList.add("stack-filter-pill");
		if (todoTagFilter === tag) pill.classList.add("active");
		pill.textContent = `#${tag}`;
		pill.addEventListener("click", () => { todoTagFilter = todoTagFilter === tag ? null : tag; renderTodos(); });
		bar.appendChild(pill);
	});

	return bar;
}

function renderTodos() {
	if (currentView === "overview") { renderOverview(); return; }
	if (currentView === "inbox") { renderInbox(); return; }

	const project = getCurrentProject();
	if (!project) return;

	if (!project.resources) project.resources = { notes: "" };
	if (!project.epics) project.epics = [];

	// Reset filters when switching projects
	if (currentProjectId !== lastEpicFilterProjectId) {
		epicFilterIds.clear();
		stackToolFilter = null;
		todoTagFilter = null;
		lastEpicFilterProjectId = currentProjectId;
	}

	addTodoBtn.style.display = "";
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.remove("overview-view");
	projectTitle.textContent = project.title;

	// Code badge — use onclick (single handler, no accumulation)
	if (!project.code) project.code = generateProjectCode(project.title);
	projectCodeBadge.textContent = project.code;
	projectCodeBadge.style.display = "";
	projectCodeBadge.onclick = () => {
		projectCodeBadge.style.display = "none";
		const input = document.createElement("input");
		input.value = project.code;
		input.maxLength = 5;
		input.classList.add("project-code-input");
		projectCodeBadge.insertAdjacentElement("afterend", input);
		input.focus(); input.select();
		function saveCode() {
			const newCode = input.value.trim().toUpperCase().slice(0, 5) || project.code;
			project.code = newCode;
			projectCodeBadge.textContent = newCode;
			projectCodeBadge.style.display = "";
			input.remove();
			saveProjects();
			renderProjects();
			renderTodos();
		}
		input.addEventListener("blur", saveCode);
		input.addEventListener("keydown", e => {
			if (e.key === "Enter") input.blur();
			if (e.key === "Escape") { projectCodeBadge.style.display = ""; input.remove(); }
		});
	};

	// Ensure new fields exist
	if (!project.tabs || !project.tabs.length) project.tabs = defaultProjectTabs();
	if (!project.notes) project.notes = [];
	if (!project.tools) project.tools = [];

	projectTabsContainer.innerHTML = "";
	projectTabsContainer.appendChild(buildProjectTabBar(project));

	const activeTab = project.tabs.find(t => t.id === currentProjectTab) || project.tabs[0];
	if (!activeTab || activeTab.id !== currentProjectTab) currentProjectTab = project.tabs[0].id;

	if (activeTab?.type === "resources") {
		sortBarContainer.innerHTML = "";
		renderResourcesPanel(project);
		renderSelectionBar();
		return;
	}

	if (activeTab?.type === "notes") {
		sortBarContainer.innerHTML = "";
		addTodoBtn.style.display = "none";
		renderNotesTab(project);
		renderSelectionBar();
		return;
	}

	if (activeTab?.type === "stack") {
		sortBarContainer.innerHTML = "";
		addTodoBtn.style.display = "none";
		renderStackTab(project);
		renderSelectionBar();
		return;
	}

	sortBarContainer.innerHTML = "";
	sortBarContainer.appendChild(buildSortBar(project.todos, renderTodos));

	if (project.epics.length > 0) {
		const filterBar = buildEpicFilterBar(project);
		if (filterBar) sortBarContainer.appendChild(filterBar);
	}

	// Stack tool filter (shown when project has a Stack tab)
	if (project.tabs?.some(t => t.type === "stack") && project.tools?.length) {
		const stackFilterBar = buildStackFilterBar(project);
		if (stackFilterBar) sortBarContainer.appendChild(stackFilterBar);
	}

	// Tag filter bar
	const allTodoTags = [...new Set(project.todos.flatMap(t => t.tags || []).filter(Boolean))];
	if (allTodoTags.length > 0) {
		sortBarContainer.appendChild(buildTodoTagFilterBar(allTodoTags));
	}

	if (project.epics.length === 0) {
		const epicBtn = document.createElement("button");
		epicBtn.classList.add("sort-btn", "add-epic-sort-btn");
		epicBtn.textContent = "+ Add Epic";
		epicBtn.style.marginLeft = "auto";
		epicBtn.addEventListener("click", () => {
			const newEpic = { id: self.crypto.randomUUID(), title: "New Epic", collapsed: false, extraColumns: [] };
			project.epics.push(newEpic);
			saveProjects();
			renderTodos();
		});
		sortBarContainer.querySelector(".sort-bar").appendChild(epicBtn);
	}

	if (project.epics.length > 0) {
		renderSwimlaneTodos(project);
	} else {
		renderFlatKanban(project);
	}

	renderSelectionBar();
}

/* ======================
   PROJECTS SIDEBAR
====================== */

function renderProjects() {
	sidebar.innerHTML = "";

	// Two-region layout: scrollable list on top, pinned bottom strip
	const scrollEl = document.createElement("div");
	scrollEl.classList.add("sidebar-scroll");

	const bottomEl = document.createElement("div");
	bottomEl.classList.add("sidebar-bottom");

	sidebar.appendChild(scrollEl);
	sidebar.appendChild(bottomEl);

	const sidebarHeader = document.createElement("div");
	sidebarHeader.classList.add("sidebar-header");

	const icon = document.createElement("div");
	icon.classList.add("sidebar-app-icon");
	icon.textContent = "✓";

	const appName = document.createElement("span");
	appName.classList.add("sidebar-app-name");
	appName.textContent = "Todoroki";

	const sidebarCloseBtn = document.createElement("button");
	sidebarCloseBtn.classList.add("sidebar-close-btn");
	sidebarCloseBtn.title = "Close menu";
	sidebarCloseBtn.setAttribute("aria-label", "Close sidebar");
	sidebarCloseBtn.addEventListener("click", () => {
		sidebar.classList.remove("open");
		sidebarBackdrop.classList.remove("visible");
	});

	sidebarHeader.appendChild(icon);
	sidebarHeader.appendChild(appName);
	sidebarHeader.appendChild(sidebarCloseBtn);
	scrollEl.appendChild(sidebarHeader);

	// Overview item
	const overviewItem = document.createElement("div");
	overviewItem.classList.add("overview-sidebar-item");
	if (currentView === "overview") overviewItem.classList.add("active");

	const overviewIcon = document.createElement("span");
	overviewIcon.classList.add("overview-sidebar-icon");
	overviewIcon.textContent = "◉";

	const overviewLabel = document.createElement("span");
	overviewLabel.textContent = "Overview";

	overviewItem.appendChild(overviewIcon);
	overviewItem.appendChild(overviewLabel);

	overviewItem.addEventListener("click", () => {
		currentView = "overview";
		currentProjectTab = "board";
		selectedTodos.clear();
		sidebar.classList.remove("open");
		sidebarBackdrop.classList.remove("visible");
		renderProjects();
		renderOverview();
	});

	scrollEl.appendChild(overviewItem);

	// Inbox item
	const inboxItem = document.createElement("div");
	inboxItem.classList.add("inbox-sidebar-item");
	if (currentView === "inbox") inboxItem.classList.add("active");

	const inboxIcon = document.createElement("span");
	inboxIcon.classList.add("inbox-sidebar-icon");
	inboxIcon.textContent = "✉";

	const inboxLabel = document.createElement("span");
	inboxLabel.textContent = "Inbox";

	const inboxCount = document.createElement("span");
	inboxCount.classList.add("inbox-sidebar-count");
	inboxCount.textContent = inbox.length || "";

	inboxItem.appendChild(inboxIcon);
	inboxItem.appendChild(inboxLabel);
	inboxItem.appendChild(inboxCount);

	inboxItem.addEventListener("click", () => {
		currentView = "inbox";
		currentProjectTab = "board";
		selectedTodos.clear();
		sidebar.classList.remove("open");
		sidebarBackdrop.classList.remove("visible");
		renderProjects();
		renderInbox();
	});

	inboxItem.addEventListener("dragover", (e) => {
		if (!dragState?.todoIds || dragState.source === "inbox") return;
		e.preventDefault();
		inboxItem.classList.add("drag-over");
	});
	inboxItem.addEventListener("dragleave", () => inboxItem.classList.remove("drag-over"));
	inboxItem.addEventListener("drop", (e) => {
		e.preventDefault();
		inboxItem.classList.remove("drag-over");
		if (!dragState?.todoIds) return;
		dragState.todoIds.forEach(todoId => {
			if (dragState.source === "inbox") return;
			const src = projects.find(p => p.id === dragState.projectId);
			const todo = src?.todos.find(t => t.id === todoId);
			if (todo) { src.removeTodo(todoId); inbox.push(todo); }
		});
		selectedTodos.clear();
		dragState = null;
		saveInbox();
		saveProjects();
		renderProjects();
		if (currentView === "inbox") renderInbox(); else renderTodos();
	});

	scrollEl.appendChild(inboxItem);

	const sectionLabel = document.createElement("div");
	sectionLabel.classList.add("sidebar-section-label");
	sectionLabel.textContent = "Projects";
	scrollEl.appendChild(sectionLabel);

	projects.forEach(project => {

		const item = document.createElement("div");
		item.classList.add("project-item");
		item.draggable = true;
		item.dataset.projectId = project.id;

		if (project.id === currentProjectId && currentView === "project") {
			item.classList.add("active");
		}

		item.addEventListener("dragstart", (e) => {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/project-id", project.id);
			item.classList.add("dragging");
		});

		item.addEventListener("dragend", () => item.classList.remove("dragging"));

		// Unified dragover: handles both project reorder and card-drop hover
		item.addEventListener("dragover", (e) => {
			const isProjectDrag = e.dataTransfer.types.includes("text/project-id");
			const isCardDrag = !!dragState?.todoIds;
			if (!isProjectDrag && !isCardDrag) return;
			e.preventDefault();
			if (isProjectDrag) e.dataTransfer.dropEffect = "move";
			item.classList.add("drag-over");
			// Hover-to-switch: switch project after holding over it for 700ms
			if (isCardDrag && project.id !== currentProjectId && !dragHoverTimer) {
				dragHoverTimer = setTimeout(() => {
					dragHoverTimer = null;
					currentProjectId = project.id;
					currentView = "project";
					renderTodos();
					renderProjects();
				}, 700);
			}
		});

		item.addEventListener("dragleave", () => {
			item.classList.remove("drag-over");
			if (dragHoverTimer) { clearTimeout(dragHoverTimer); dragHoverTimer = null; }
		});

		// Unified drop: handles both project reorder and card-drop
		item.addEventListener("drop", (e) => {
			e.preventDefault();
			item.classList.remove("drag-over");

			const draggedId = e.dataTransfer.getData("text/project-id");
			if (draggedId && draggedId !== project.id && !dragState?.todoIds) {
				// Project reorder
				const fromIndex = projects.findIndex(p => p.id === draggedId);
				const toIndex = projects.findIndex(p => p.id === project.id);
				if (fromIndex === -1) return;
				const [moved] = projects.splice(fromIndex, 1);
				projects.splice(toIndex, 0, moved);
				saveProjects();
				renderProjects();
				return;
			}

			if (dragState?.todoIds) {
				// Card drop onto project
				const srcProjectDrop = dragState.source !== "inbox"
					? projects.find(p => p.id === dragState.projectId) : null;
				dragState.todoIds.forEach(todoId => {
					let todo;
					if (dragState.source === "inbox") {
						todo = inbox.find(t => t.id === todoId);
						if (todo) inbox.splice(inbox.indexOf(todo), 1);
					} else {
						if (dragState.projectId === project.id) return;
						todo = srcProjectDrop?.todos.find(t => t.id === todoId);
						if (todo) srcProjectDrop.removeTodo(todoId);
					}
					if (todo) {
						const validStatuses = getColumnLabels();
						if (!validStatuses.includes(todo.status)) {
							todo.status = validStatuses.find(l => l.toLowerCase().includes("progress")) || validStatuses[0];
						}
						todo.epicId = null;
						todo.number = 0;
						project.addTodo(todo);
					}
				});
				if (srcProjectDrop) renumberProjectTodos(srcProjectDrop);
				selectedTodos.clear();
				dragState = null;
				saveInbox();
				saveProjects();
				renderProjects();
				renderTodos();
			}
		});

		// Code badge in sidebar
		if (project.code) {
			const sideBadge = document.createElement("span");
			sideBadge.classList.add("sidebar-project-code");
			sideBadge.textContent = project.code;
			item.appendChild(sideBadge);
		}

		const name = document.createElement("span");
		name.textContent = project.title;
		name.classList.add("project-name");
		name.title = "Double-click to rename";

		name.addEventListener("click", (e) => {
			if (e.detail >= 2) {
				const input = document.createElement("input");
				input.classList.add("project-name-input");
				input.value = project.title;
				name.replaceWith(input);
				input.focus();
				input.select();
				function saveRename() {
					const newTitle = input.value.trim() || project.title;
					project.title = newTitle;
					saveProjects();
					renderProjects();
					if (currentProjectId === project.id) projectTitle.textContent = newTitle;
				}
				input.addEventListener("blur", saveRename);
				input.addEventListener("keydown", ev => {
					if (ev.key === "Enter") input.blur();
					if (ev.key === "Escape") renderProjects();
				});
				return;
			}
			currentProjectId = project.id;
			currentView = "project";
			currentProjectTab = "board";
			searchQuery = "";
			selectedTodos.clear();
			renderTodos();
			renderProjects();
			saveProjects();
		});

		const deleteBtn = document.createElement("button");
		deleteBtn.textContent = "✕";
		deleteBtn.classList.add("project-delete-btn");
		deleteBtn.title = "Delete project";

		deleteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			deleteProject(project.id);
		});

		item.appendChild(name);
		if (projects.length > 1) item.appendChild(deleteBtn);

		scrollEl.appendChild(item);
	});

	const addRow = document.createElement("div");
	addRow.classList.add("project-add-row");

	const addInput = document.createElement("input");
	addInput.placeholder = "+ new project";
	addInput.classList.add("project-add-input");

	addInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && addInput.value.trim()) {
			addProject(addInput.value);
		}
	});

	addRow.appendChild(addInput);
	bottomEl.appendChild(addRow);

	if (currentUser) {
		bottomEl.appendChild(buildUserRow(currentUser));
	}
}

/* ======================
   USER ROW + SETTINGS POPUP
====================== */

const AVATAR_COLORS = [
	"#FCFF4B", "#1a73e8", "#188038", "#e91e8c",
	"#f59e0b", "#9c27b0", "#ef4444", "#06b6d4",
];

function getUserDisplayName(user) {
	return userPrefs.displayName ||
		user.user_metadata?.name ||
		user.user_metadata?.full_name ||
		user.email || "User";
}

function getAvatarColor() {
	return userPrefs.avatarColor || "#FCFF4B";
}

function buildUserAvatar(user, sizeClass) {
	const avatar = document.createElement("div");
	avatar.classList.add(sizeClass);
	const color = getAvatarColor();
	const hasCustomColor = userPrefs.avatarColor !== null;

	if (!hasCustomColor && user.user_metadata?.avatar_url) {
		// Show Google photo only when no custom colour chosen
		const img = document.createElement("img");
		img.src = user.user_metadata.avatar_url;
		img.alt = "";
		img.classList.add("sidebar-user-avatar-img");
		avatar.appendChild(img);
	} else {
		avatar.style.background = color;
		avatar.style.color = color === "#FCFF4B" ? "#044389" : "#fff";
		avatar.textContent = (getUserDisplayName(user)[0] || "?").toUpperCase();
	}
	return avatar;
}

function buildUserRow(user) {
	const userRow = document.createElement("div");
	userRow.classList.add("sidebar-user-row");
	userRow.title = "Settings";

	const avatar = buildUserAvatar(user, "sidebar-user-avatar");

	const nameEl = document.createElement("span");
	nameEl.classList.add("sidebar-user-email");
	nameEl.textContent = getUserDisplayName(user);
	nameEl.title = user.email || "";

	const chevron = document.createElement("span");
	chevron.classList.add("sidebar-user-chevron");
	chevron.textContent = "⌃";

	userRow.appendChild(avatar);
	userRow.appendChild(nameEl);
	userRow.appendChild(chevron);

	userRow.addEventListener("click", (e) => {
		e.stopPropagation();
		openUserSettings(userRow, user);
	});

	return userRow;
}

function openUserSettings(anchorEl, user) {
	const existing = document.querySelector(".user-settings-popup");
	if (existing) { existing.remove(); return; }

	const popup = document.createElement("div");
	popup.classList.add("user-settings-popup");

	// ── User info header ──
	const popupHeader = document.createElement("div");
	popupHeader.classList.add("user-settings-header");

	// Use a wrapper so the avatar can be replaced in-place by swatch clicks
	const avatarWrap = document.createElement("div");
	avatarWrap.appendChild(buildUserAvatar(user, "user-settings-avatar"));

	const headerInfo = document.createElement("div");
	headerInfo.classList.add("user-settings-info");
	const headerName = document.createElement("div");
	headerName.classList.add("user-settings-name");
	headerName.textContent = getUserDisplayName(user);
	const headerEmail = document.createElement("div");
	headerEmail.classList.add("user-settings-email");
	headerEmail.textContent = user.email || "";
	headerInfo.appendChild(headerName);
	headerInfo.appendChild(headerEmail);

	popupHeader.appendChild(avatarWrap);
	popupHeader.appendChild(headerInfo);
	popup.appendChild(popupHeader);

	// ── Divider ──
	const div1 = document.createElement("div");
	div1.classList.add("user-settings-divider");
	popup.appendChild(div1);

	// ── Display name ──
	const nameSection = document.createElement("div");
	nameSection.classList.add("user-settings-section");
	const nameLabel = document.createElement("label");
	nameLabel.classList.add("user-settings-label");
	nameLabel.textContent = "Display name";
	const nameInput = document.createElement("input");
	nameInput.classList.add("user-settings-input");
	nameInput.value = getUserDisplayName(user);
	nameInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") nameInput.blur();
	});
	nameInput.addEventListener("blur", () => {
		const val = nameInput.value.trim();
		if (val) {
			userPrefs.displayName = val;
			saveUserPrefs();
			renderProjects();
		}
	});
	nameSection.appendChild(nameLabel);
	nameSection.appendChild(nameInput);
	popup.appendChild(nameSection);

	// ── Icon colour ──
	const colorSection = document.createElement("div");
	colorSection.classList.add("user-settings-section");
	const colorLabel = document.createElement("label");
	colorLabel.classList.add("user-settings-label");
	colorLabel.textContent = "Icon colour";
	const swatches = document.createElement("div");
	swatches.classList.add("user-settings-swatches");

	AVATAR_COLORS.forEach(hex => {
		const swatch = document.createElement("button");
		swatch.classList.add("user-settings-swatch");
		swatch.style.background = hex;
		if (hex === getAvatarColor()) swatch.classList.add("active");
		swatch.addEventListener("click", (e) => {
			e.stopPropagation();
			userPrefs.avatarColor = hex;
			saveUserPrefs();
			swatches.querySelectorAll(".user-settings-swatch").forEach(s => s.classList.remove("active"));
			swatch.classList.add("active");
			// Update the popup header avatar live
			avatarWrap.innerHTML = "";
			avatarWrap.appendChild(buildUserAvatar(user, "user-settings-avatar"));
			renderProjects();
		});
		swatches.appendChild(swatch);
	});

	colorSection.appendChild(colorLabel);
	colorSection.appendChild(swatches);
	popup.appendChild(colorSection);

	// ── Divider ──
	const div2 = document.createElement("div");
	div2.classList.add("user-settings-divider");
	popup.appendChild(div2);

	// ── Dark mode toggle ──
	const themeSection = document.createElement("div");
	themeSection.classList.add("user-settings-section");
	const themeRow = document.createElement("div");
	themeRow.classList.add("user-settings-theme-row");
	const themeLabel = document.createElement("span");
	themeLabel.classList.add("user-settings-theme-label");
	themeLabel.textContent = "Dark mode";

	const themeSwitch = document.createElement("label");
	themeSwitch.classList.add("theme-toggle-switch");
	const themeCheckbox = document.createElement("input");
	themeCheckbox.type = "checkbox";
	themeCheckbox.checked = document.documentElement.dataset.theme === "dark";
	const themeTrack = document.createElement("span");
	themeTrack.classList.add("theme-toggle-track");
	themeSwitch.appendChild(themeCheckbox);
	themeSwitch.appendChild(themeTrack);

	themeCheckbox.addEventListener("change", () => {
		const next = themeCheckbox.checked ? "dark" : "light";
		userPrefs.theme = next;
		saveUserPrefs();
		localStorage.setItem("theme", next);
		applyTheme(next);
	});

	themeRow.appendChild(themeLabel);
	themeRow.appendChild(themeSwitch);
	themeSection.appendChild(themeRow);
	popup.appendChild(themeSection);

	// ── Divider ──
	const div3 = document.createElement("div");
	div3.classList.add("user-settings-divider");
	popup.appendChild(div3);

	// ── Sign out ──
	const signOutBtn = document.createElement("button");
	signOutBtn.classList.add("user-settings-signout");
	signOutBtn.textContent = "Sign out";
	signOutBtn.addEventListener("click", () => signOut());
	popup.appendChild(signOutBtn);

	document.body.appendChild(popup);

	// Position above anchor
	const rect = anchorEl.getBoundingClientRect();
	popup.style.left = `${rect.left}px`;
	popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
	// Clamp to viewport width
	const popupWidth = 220;
	const maxLeft = window.innerWidth - popupWidth - 8;
	popup.style.left = `${Math.min(rect.left, maxLeft)}px`;

	// Close on outside click
	function onOutside(e) {
		if (!popup.contains(e.target) && !anchorEl.contains(e.target)) {
			popup.remove();
			document.removeEventListener("click", onOutside, true);
		}
	}
	setTimeout(() => document.addEventListener("click", onOutside, true), 0);
}

/* ======================
   EVENTS
====================== */

/* ======================
   DARK MODE
====================== */

function applyTheme(theme) {
	if (theme === "dark") {
		document.documentElement.dataset.theme = "dark";
	} else {
		delete document.documentElement.dataset.theme;
	}
}

applyTheme(localStorage.getItem("theme") || "light");

addTodoBtn.addEventListener("click", () => {
	createTodoForm(
		formContainer,
		addTodoBtn,
		getCurrentProject(),
		saveProjects,
		renderTodos,
		getColumnLabels()
	);
});

document.querySelector("#fab-btn").addEventListener("click", () => showInboxAddForm());

document.addEventListener("click", (e) => {
	if (!e.target.closest(".todo-card") && !e.target.closest(".selection-bar-overlay")) {
		selectedTodos.clear();
		document.querySelectorAll(".todo-card.selected").forEach(c => c.classList.remove("selected"));
		renderSelectionBar();
	}
});

projectTitle.addEventListener("dblclick", () => {
	if (currentView !== "project") return;
	const project = getCurrentProject();
	if (!project) return;

	const input = document.createElement("input");
	input.value = project.title;
	input.classList.add("project-title-edit");
	projectTitle.textContent = "";
	projectTitle.appendChild(input);
	input.focus();
	input.select();

	function saveTitle() {
		const newTitle = input.value.trim() || project.title;
		project.title = newTitle;
		saveProjects();
		renderProjects();
		renderTodos();
	}

	input.addEventListener("blur", saveTitle);
	input.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") input.blur();
		if (ev.key === "Escape") renderTodos();
	});
});

window.addEventListener("resize", () => {
	if (currentView === "inbox") renderInbox();
});
