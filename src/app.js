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
let currentView = "overview"; // "project" | "inbox" | "overview"
let currentProjectTab = "board"; // "board" | "resources"
let inbox = [];

window.projects = projects;

let sortBy = "default"; // default | priority | createdAt | updatedAt | dueDate
let sortDir = "asc"; // asc | desc
let listSortBy = "default"; // default | az | za | newest | oldest | updated | progress-hi | progress-lo | size-hi | size-lo

let currentEmailThreadId = null;
let gmailToken = null;       // ephemeral access token
let gmailTokenExpiry = 0;
let gmailThreadCache = {};   // { [threadId]: fullThreadData }

let currentUser = null;
const guestMode = !!(localStorage.getItem("todoroki_guest") === "true");

// ── Multi-account session store ──
function getStoredAccounts() {
	try { return JSON.parse(localStorage.getItem("todoroki_accounts") || "{}"); }
	catch { return {}; }
}
function setStoredAccounts(accs) {
	localStorage.setItem("todoroki_accounts", JSON.stringify(accs));
}
function getActiveAccountId() {
	return localStorage.getItem("todoroki_active_account_id") || null;
}
function setActiveAccountId(id) {
	localStorage.setItem("todoroki_active_account_id", id);
}
function upsertStoredAccount(user, session) {
	if (!user || !session) return;
	const accs = getStoredAccounts();
	accs[user.id] = {
		...(accs[user.id] || {}),
		email: user.email || "",
		name: user.user_metadata?.full_name || user.user_metadata?.name || user.email || "User",
		accessToken: session.access_token,
		refreshToken: session.refresh_token,
		expiresAt: (session.expires_at || 0) * 1000,
	};
	setStoredAccounts(accs);
}
function removeStoredAccount(userId) {
	const accs = getStoredAccounts();
	delete accs[userId];
	setStoredAccounts(accs);
}

async function switchAccount(userId) {
	if (userId === currentUser?.id) return;
	const accs = getStoredAccounts();
	const target = accs[userId];
	if (!target) return;

	// Persist current session tokens before switching
	const { data: { session: curSession } } = await supabase.auth.getSession();
	if (curSession && currentUser) upsertStoredAccount(currentUser, curSession);

	// Restore the target session
	const { data, error } = await supabase.auth.setSession({
		access_token: target.accessToken,
		refresh_token: target.refreshToken,
	});
	if (error || !data.session) {
		removeStoredAccount(userId);
		document.querySelector(".user-settings-popup")?.remove();
		const anchor = document.querySelector(".sidebar-user-row");
		if (anchor) openUserSettings(anchor, currentUser);
		alert("That account session has expired — it has been removed. Please use \"Add account\" to sign in again.");
		return;
	}

	setActiveAccountId(userId);
	currentUser = data.user;

	// Reset per-account state
	currentProjectId = null;
	columns.length = 0;
	userPrefs = { theme: "light", avatarColor: null, displayName: "", generalNotes: [], anthropicApiKey: null, icalToken: null, emailPrefs: { clientId: null, label: "Todoroki", threads: {} } };

	try {
		await loadUserPrefs();
		applyTheme(userPrefs.theme);
		await loadFromSupabase();
	} catch (err) {
		console.error("Failed to load data for switched account:", err);
	}

	if (projects.length === 0) {
		const dp = new Project("Default", "");
		dp.epics = []; dp.resources = { notes: "", html: "", files: [] };
		dp.code = "DEF"; dp.todoCounter = 0;
		dp.tabs = defaultProjectTabs(); dp.notes = []; dp.tools = []; dp.lists = [];
		projects.push(dp);
		currentProjectId = dp.id;
		saveProjects();
	}

	document.querySelector(".user-settings-popup")?.remove();
	currentView = "overview";
	renderProjects();
	renderOverview();
}

async function addAccount() {
	const { data: { session } } = await supabase.auth.getSession();
	if (session && currentUser) {
		upsertStoredAccount(currentUser, session);
		setActiveAccountId(currentUser.id);
	}
	sessionStorage.setItem("todoroki_adding_account", currentUser?.id || "");
	signInWithGoogle();
}

async function signOutAllAccounts() {
	localStorage.removeItem("todoroki_accounts");
	localStorage.removeItem("todoroki_active_account_id");
	signOut();
}

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
let assistantHistory = []; // persists for the session
let lastRemoteSync = 0; // timestamp of the last successful pull from Supabase

// Cross-device user preferences — loaded from Supabase after auth
let userPrefs = { theme: "light", avatarColor: null, displayName: "", generalNotes: [], anthropicApiKey: null, icalToken: null, emailPrefs: { clientId: null, label: "Todoroki", threads: {} } };

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

const MATERIAL_ICONS = [
	"home","star","favorite","check_circle","work","school","person","group","settings","build",
	"code","bug_report","science","rocket_launch","bolt","auto_awesome","lightbulb","local_fire_department",
	"emoji_events","flag","campaign","thumb_up","bookmarks","article","inventory_2","shopping_cart",
	"attach_money","bar_chart","pie_chart","map","travel_explore","flight","directions_car","computer",
	"phone_iphone","headphones","camera_alt","palette","brush","music_note","sports_esports","fitness_center",
	"restaurant","coffee","local_florist","pets","nature","wb_sunny","cloud","lock",
];

function getContrastColor(hex) {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? "#1a1a2e" : "#ffffff";
}

function openIconPicker(project, anchorEl, onPick) {
	const existing = document.querySelector(".icon-picker-popup");
	if (existing) { existing.remove(); return; }

	const popup = document.createElement("div");
	popup.classList.add("icon-picker-popup");

	const rect = anchorEl.getBoundingClientRect();
	popup.style.position = "fixed";
	popup.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 460)}px`;
	popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 270))}px`;

	function pickIcon(name) {
		project.icon = name;
		saveProjects();
		popup.remove();
		document.removeEventListener("click", onOutside, true);
		onPick();
	}

	// ── Custom icon name input ────────────────────────────────
	const customRow = document.createElement("div");
	customRow.classList.add("icon-picker-custom-row");

	const customInput = document.createElement("input");
	customInput.classList.add("icon-picker-search");
	customInput.placeholder = "Type icon name (e.g. rocket_launch)";
	customInput.value = project.icon || "";

	const customPreview = document.createElement("span");
	customPreview.classList.add("material-symbols-rounded", "icon-picker-custom-preview");
	customPreview.textContent = project.icon || "help_outline";

	function toIconName(raw) {
		return raw.trim().toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "");
	}

	customInput.addEventListener("input", () => {
		const name = toIconName(customInput.value);
		customPreview.textContent = name || "help_outline";
	});
	customInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			const name = toIconName(customInput.value);
			if (name) pickIcon(name);
		}
	});

	const customApply = document.createElement("button");
	customApply.classList.add("icon-picker-apply-btn");
	customApply.textContent = "Use";
	customApply.addEventListener("click", () => {
		const name = toIconName(customInput.value);
		if (name) pickIcon(name);
	});

	customRow.appendChild(customPreview);
	customRow.appendChild(customInput);
	customRow.appendChild(customApply);
	popup.appendChild(customRow);

	// ── Search + grid ─────────────────────────────────────────
	const searchInput = document.createElement("input");
	searchInput.classList.add("icon-picker-search");
	searchInput.placeholder = "Search icons…";
	popup.appendChild(searchInput);

	const grid = document.createElement("div");
	grid.classList.add("icon-picker-grid");

	function renderGrid(filter) {
		grid.innerHTML = "";
		const icons = filter ? MATERIAL_ICONS.filter(n => n.includes(filter.toLowerCase())) : MATERIAL_ICONS;
		icons.forEach(name => {
			const btn = document.createElement("button");
			btn.classList.add("icon-picker-btn");
			if (project.icon === name) btn.classList.add("active");
			btn.title = name.replace(/_/g, " ");
			const icon = document.createElement("span");
			icon.classList.add("material-symbols-rounded");
			icon.textContent = name;
			btn.appendChild(icon);
			btn.addEventListener("click", () => pickIcon(name));
			grid.appendChild(btn);
		});
	}
	renderGrid("");
	searchInput.addEventListener("input", () => renderGrid(searchInput.value));
	popup.appendChild(grid);

	// ── Colour picker section ─────────────────────────────────
	const colorSection = document.createElement("div");
	colorSection.classList.add("icon-picker-color-section");

	const colorLabel = document.createElement("div");
	colorLabel.classList.add("icon-picker-color-label");
	colorLabel.textContent = "Icon & tab colour";
	colorSection.appendChild(colorLabel);

	const colorGrid = document.createElement("div");
	colorGrid.classList.add("color-picker-grid");
	PROJECT_COLORS.forEach(hex => {
		const swatch = document.createElement("button");
		swatch.classList.add("color-picker-swatch");
		swatch.style.background = hex;
		if (project.color === hex) swatch.classList.add("active");
		swatch.addEventListener("click", () => {
			project.color = hex;
			saveProjects();
			// update active swatch highlight
			colorGrid.querySelectorAll(".color-picker-swatch").forEach(s => s.classList.remove("active"));
			swatch.classList.add("active");
			onPick(); // live-update sidebar
		});
		colorGrid.appendChild(swatch);
	});
	colorSection.appendChild(colorGrid);

	const noneBtn = document.createElement("button");
	noneBtn.classList.add("color-picker-none");
	noneBtn.textContent = "No colour";
	noneBtn.addEventListener("click", () => {
		project.color = null;
		saveProjects();
		colorGrid.querySelectorAll(".color-picker-swatch").forEach(s => s.classList.remove("active"));
		onPick();
	});
	colorSection.appendChild(noneBtn);
	popup.appendChild(colorSection);

	document.body.appendChild(popup);
	customInput.focus();
	customInput.select();

	function onOutside(e) {
		if (!popup.contains(e.target) && e.target !== anchorEl) {
			popup.remove();
			document.removeEventListener("click", onOutside, true);
		}
	}
	setTimeout(() => document.addEventListener("click", onOutside, true), 0);
}

const PROJECT_COLORS = [
    "#6366f1","#8b5cf6","#ec4899","#ef4444",
    "#f97316","#f59e0b","#22c55e","#14b8a6",
    "#3b82f6","#0ea5e9","#64748b","#d946ef",
];

function openColorPicker(project, anchorEl, onPick) {
    const existing = document.querySelector(".color-picker-popup");
    if (existing) { existing.remove(); return; }
    const popup = document.createElement("div");
    popup.classList.add("color-picker-popup");
    const rect = anchorEl.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.top  = `${Math.min(rect.bottom + 4, window.innerHeight - 180)}px`;
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;

    const grid = document.createElement("div");
    grid.classList.add("color-picker-grid");
    PROJECT_COLORS.forEach(hex => {
        const btn = document.createElement("button");
        btn.classList.add("color-picker-swatch");
        btn.style.background = hex;
        if (project.color === hex) btn.classList.add("active");
        btn.addEventListener("click", () => {
            project.color = hex;
            saveProjects();
            popup.remove();
            document.removeEventListener("click", onOutside, true);
            onPick();
        });
        grid.appendChild(btn);
    });
    popup.appendChild(grid);

    // None option
    const noneBtn = document.createElement("button");
    noneBtn.classList.add("color-picker-none");
    noneBtn.textContent = "No color";
    noneBtn.addEventListener("click", () => {
        project.color = null;
        saveProjects();
        popup.remove();
        document.removeEventListener("click", onOutside, true);
        onPick();
    });
    popup.appendChild(noneBtn);

    document.body.appendChild(popup);
    function onOutside(e) {
        if (!popup.contains(e.target) && e.target !== anchorEl) {
            popup.remove();
            document.removeEventListener("click", onOutside, true);
        }
    }
    setTimeout(() => document.addEventListener("click", onOutside, true), 0);
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
function saveToLocalStorage() {
	try {
		localStorage.setItem("todoroki_guest_projects", JSON.stringify(projects));
		localStorage.setItem("todoroki_guest_inbox", JSON.stringify(inbox));
		localStorage.setItem("todoroki_guest_columns", JSON.stringify(columns));
	} catch (e) {
		console.error("localStorage save failed:", e);
	}
}

function loadFromLocalStorage() {
	try {
		const rawCols = localStorage.getItem("todoroki_guest_columns");
		if (rawCols) columns = JSON.parse(rawCols);

		const rawProjects = localStorage.getItem("todoroki_guest_projects");
		if (rawProjects) {
			const parsed = JSON.parse(rawProjects);
			projects.length = 0;
			parsed.forEach(raw => {
				const project = Object.create(Project.prototype);
				Object.assign(project, raw);
				project.todos = (raw.todos || []).slice();
				projects.push(project);
			});
		}

		const rawInbox = localStorage.getItem("todoroki_guest_inbox");
		if (rawInbox) {
			inbox.length = 0;
			inbox.push(...JSON.parse(rawInbox));
		}

		userPrefs.theme        = localStorage.getItem("theme") || "light";
		userPrefs.displayName  = localStorage.getItem("todoroki_guest_name") || "";
		userPrefs.avatarColor  = localStorage.getItem("userAvatarColor") || null;
	} catch (e) {
		console.error("localStorage load failed:", e);
	}
}

function saveProjects() {
	if (!currentUser && !guestMode) return;
	if (guestMode) { saveToLocalStorage(); return; }
	clearTimeout(syncTimer);
	syncTimer = setTimeout(syncAllToSupabase, 400);
}

function saveInbox() {
	if (!currentUser && !guestMode) return;
	if (guestMode) { saveToLocalStorage(); return; }
	clearTimeout(syncTimer);
	syncTimer = setTimeout(syncAllToSupabase, 400);
}

function saveColumns() {
	if (!currentUser && !guestMode) return;
	if (guestMode) { saveToLocalStorage(); return; }
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
		userPrefs.anthropicApiKey = data.anthropic_api_key || null;
		userPrefs.icalToken       = data.ical_token || null;
		userPrefs.emailPrefs = data.email_prefs || { clientId: null, label: "Todoroki", threads: {} };
		if (!userPrefs.emailPrefs.threads) userPrefs.emailPrefs.threads = {};
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
	if (guestMode) {
		localStorage.setItem("todoroki_guest_name", userPrefs.displayName || "");
		localStorage.setItem("theme", userPrefs.theme || "light");
		if (userPrefs.avatarColor) localStorage.setItem("userAvatarColor", userPrefs.avatarColor);
		return;
	}
	if (!currentUser) return;
	try {
		let { error } = await supabase.from("user_preferences").upsert(
			{
				user_id:          currentUser.id,
				theme:            userPrefs.theme,
				avatar_color:     userPrefs.avatarColor,
				display_name:     userPrefs.displayName,
				general_notes:    userPrefs.generalNotes,
				anthropic_api_key: userPrefs.anthropicApiKey || null,
				ical_token:        userPrefs.icalToken || null,
				email_prefs:       userPrefs.emailPrefs,
				updated_at:        new Date().toISOString(),
			},
			{ onConflict: "user_id" }
		);
		if (isMissingColumnError(error)) {
			// column not yet migrated — retry without newer columns
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
		// Keep the accounts store in sync with the latest avatar color
		if (userPrefs.avatarColor) {
			const accs = getStoredAccounts();
			if (accs[currentUser.id]) {
				accs[currentUser.id].avatarColor = userPrefs.avatarColor;
				setStoredAccounts(accs);
			}
		}
	} catch (err) {
		console.error("Supabase prefs sync error:", err);
	}
}

// ── Helpers ────────────────────────────────────────────────

function inlineMarkdown(text) {
	return text
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/`(.+?)`/g, "<code>$1</code>");
}

/* ======================
   ICAL EXPORT
====================== */

function escICS(str) {
	return (str || "").replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function generateICS() {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Todoroki//TodoList//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"X-WR-CALNAME:Todoroki Schedule",
	];

	projects.forEach(project => {
		project.todos.forEach(todo => {
			if (!todo.schedule || typeof todo.schedule !== "object") return;
			Object.entries(todo.schedule).forEach(([dateStr, sched]) => {
				if (!sched || sched.startHour === undefined || sched.endHour === undefined) return;
				const [y, m, d] = dateStr.split("-");
				const sh = String(sched.startHour).padStart(2, "0");
				const eh = String(sched.endHour).padStart(2, "0");
				const dtstart = `${y}${m}${d}T${sh}0000`;
				const dtend   = `${y}${m}${d}T${eh}0000`;
				const uid     = `${todo.id}-${dateStr}@todoroki`;
				const now     = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
				const descParts = [todo.description, `Project: ${project.title}`, `Priority: ${todo.priority || "Low"}`].filter(Boolean);
				lines.push("BEGIN:VEVENT");
				lines.push(`DTSTART:${dtstart}`);
				lines.push(`DTEND:${dtend}`);
				lines.push(`DTSTAMP:${now}`);
				lines.push(`UID:${uid}`);
				lines.push(`SUMMARY:${escICS(todo.title || "Untitled")}`);
				if (descParts.length) lines.push(`DESCRIPTION:${escICS(descParts.join("\\n"))}`);
				lines.push(`CATEGORIES:${escICS(project.title)}`);
				lines.push("END:VEVENT");
			});
		});
	});

	lines.push("END:VCALENDAR");
	return lines.join("\r\n");
}

function downloadICS() {
	const blob = new Blob([generateICS()], { type: "text/calendar;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = "todoroki-schedule.ics";
	a.click();
	URL.revokeObjectURL(url);
}

async function getOrCreateIcalToken() {
	if (userPrefs.icalToken) return userPrefs.icalToken;
	// Generate a random 32-char hex token
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const token = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
	userPrefs.icalToken = token;
	await saveUserPrefs();
	return token;
}

function parseMarkdown(text) {
	const lines = text.split("\n");
	let html = "";
	let inList = false;
	for (const raw of lines) {
		const line = raw.trimEnd();
		if (/^[-*] /.test(line)) {
			if (!inList) { html += "<ul>"; inList = true; }
			html += `<li>${inlineMarkdown(line.slice(2).trimStart())}</li>`;
		} else {
			if (inList) { html += "</ul>"; inList = false; }
			if (!line.trim()) {
				/* blank line — paragraph break, skip */
			} else if (/^#{1,3} /.test(line)) {
				const level = line.match(/^(#+)/)[1].length;
				html += `<h${level}>${inlineMarkdown(line.replace(/^#+\s*/, ""))}</h${level}>`;
			} else {
				html += `<p>${inlineMarkdown(line)}</p>`;
			}
		}
	}
	if (inList) html += "</ul>";
	return html;
}

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
		lists:            project.lists || [],
		color:            project.color || null,
		icon:             project.icon  || null,
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
		comments:       todo.comments    || [],
		completed_at:   todo.completedAt || null,
		schedule:       todo.schedule    || null,
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
				const safeRows = projectRows.map(({ code, todo_counter, tabs, notes, tools, lists, color, icon, ...rest }) => rest);
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
				const safeRows = todoRows.map(({ tags, comments, completed_at, schedule, ...rest }) => rest);
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
			resources:      { files: [], ...(row.resources || { notes: "" }) },
			noEpicCollapsed: row.no_epic_collapsed || false,
			code:           row.code || generateProjectCode(row.title),
			todoCounter:    row.todo_counter || 0,
			tabs:           (row.tabs && row.tabs.length) ? row.tabs : defaultProjectTabs(),
			notes:          row.notes || [],
			tools:          row.tools || [],
			lists:          row.lists || [],
			color:          row.color || null,
			icon:           row.icon  || null,
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
			createdAt:     row.created_at,
			updatedAt:     row.updated_at,
			comments:      Array.isArray(row.comments) ? row.comments : [],
			completedAt:   row.completed_at || null,
			schedule:      row.schedule     || null,
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
	const savedOverviewTab = overviewTab;
	try {
		await loadUserPrefs();
		await loadFromSupabase();
		// Restore view — loadFromSupabase resets currentProjectId to projects[0]
		if (savedView === "project" && projects.find(p => p.id === savedProjectId)) {
			currentProjectId = savedProjectId;
			currentProjectTab = savedTab;
		}
		currentView = savedView;
		overviewTab = savedOverviewTab;
		renderProjects();
		if (currentView === "inbox") renderInbox();
		else if (currentView === "overview") renderOverview();
		else if (currentView === "shuffle") renderShuffle();
		else if (currentView === "email") renderEmailTab();
		else renderTodos();
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
   URL ROUTING
====================== */

function getProjectSlug(project) {
	return (project.code || "").toLowerCase().replace(/[^a-z0-9]/g, "-") ||
		project.id.slice(0, 8);
}

function getTabSlug(project) {
	if (!project || currentProjectTab === "board") return null;
	const tab = project.tabs?.find(t => t.id === currentProjectTab);
	if (!tab) return null;
	return tab.type === "stack" ? "tools" : tab.type;
}

function pushViewUrl() {
	let path;
	if (currentView === "overview") {
		if (overviewTab === "assistant") path = "/assistant";
		else if (overviewTab === "dashboard") path = "/overview";
		else path = `/overview/${overviewTab}`;
	} else if (currentView === "inbox") {
		path = "/inbox";
	} else if (currentView === "shuffle") {
		path = "/shuffle";
	} else if (currentView === "email") {
		path = "/email";
	} else {
		const project = getCurrentProject();
		if (!project) {
			path = "/overview";
		} else {
			const slug = getProjectSlug(project);
			const tabSlug = getTabSlug(project);
			path = tabSlug ? `/${slug}/${tabSlug}` : `/${slug}`;
		}
	}
	if (window.location.pathname !== path) history.pushState({}, "", path);
}

function navigateToPath(pathname) {
	const parts = pathname.replace(/^\//, "").split("/").filter(Boolean);
	if (!parts.length || parts[0] === "overview") {
		currentView = "overview";
		overviewTab = parts[1] || "dashboard";
	} else if (parts[0] === "assistant") {
		currentView = "overview";
		overviewTab = "assistant";
	} else if (parts[0] === "inbox") {
		currentView = "inbox";
	} else if (parts[0] === "shuffle") {
		currentView = "shuffle";
	} else if (parts[0] === "email") {
		currentView = "email";
	} else {
		const project = projects.find(p => getProjectSlug(p) === parts[0]);
		if (project) {
			currentProjectId = project.id;
			currentView = "project";
			if (parts[1] && parts[1] !== "board") {
				const tabType = parts[1] === "tools" ? "stack" : parts[1];
				const tab = project.tabs?.find(t => t.type === tabType);
				currentProjectTab = tab ? tab.id : "board";
			} else {
				currentProjectTab = "board";
			}
		} else {
			currentView = "overview";
			overviewTab = "dashboard";
		}
	}
}

window.addEventListener("popstate", () => {
	// Close any open detail modals first
	document.querySelectorAll(".detail-overlay").forEach(el => el.remove());
	navigateToPath(window.location.pathname);
	renderProjects();
	if (currentView === "inbox") renderInbox();
	else if (currentView === "overview") renderOverview();
	else if (currentView === "shuffle") renderShuffle();
	else if (currentView === "email") renderEmailTab();
	else renderTodos();
	checkDetailQuery();
});

/* ======================
   INIT
====================== */

supabase.auth.getSession().then(async ({ data: { session } }) => {
	currentUser = session?.user ?? null;

	if (currentUser) {
		// Register this session in the multi-account store
		upsertStoredAccount(currentUser, session);
		setActiveAccountId(currentUser.id);
		sessionStorage.removeItem("todoroki_adding_account");

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
			defaultProject.resources   = { notes: "", html: "", files: [] };
			defaultProject.code        = "DEF";
			defaultProject.todoCounter = 0;
			defaultProject.tabs        = defaultProjectTabs();
			defaultProject.notes       = [];
			defaultProject.tools       = [];
			defaultProject.lists       = [];
			projects.push(defaultProject);
			currentProjectId = defaultProject.id;
			saveProjects();
		}
	} else if (guestMode) {
		loadFromLocalStorage();
		applyTheme(userPrefs.theme);

		if (projects.length === 0) {
			const defaultProject = new Project("My Project", "");
			defaultProject.epics       = [];
			defaultProject.resources   = { notes: "", html: "", files: [] };
			defaultProject.code        = "PRJ";
			defaultProject.todoCounter = 0;
			defaultProject.tabs        = defaultProjectTabs();
			defaultProject.notes       = [];
			defaultProject.tools       = [];
			defaultProject.lists       = [];
			projects.push(defaultProject);
			currentProjectId = defaultProject.id;
			saveToLocalStorage();
		}
	}

	// Navigate to URL path, defaulting to overview
	navigateToPath(window.location.pathname);
	renderProjects();
	if (currentView === "inbox") renderInbox();
	else if (currentView === "overview") renderOverview();
	else if (currentView === "shuffle") renderShuffle();
	else if (currentView === "email") renderEmailTab();
	else renderTodos();
	checkDetailQuery();
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
    return `${d}/${m}/${y}`;
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
	project.icon        = "";
	project.color       = null;
	project.resources   = { notes: "", html: "", files: [] };
	project.code        = generateProjectCode(title.trim());
	project.todoCounter = 0;
	project.tabs        = defaultProjectTabs();
	project.notes       = [];
	project.tools       = [];
	project.lists       = [];
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

	const todoTitle       = document.createElement("h1");   todoTitle.classList.add("todo-title");
	const todoDescription = document.createElement("p");    todoDescription.classList.add("todo-description");
	const todoDueDate     = document.createElement("span"); todoDueDate.classList.add("todo-due-date");
	const todoPriority    = document.createElement("span"); todoPriority.classList.add("todo-priority");
	const todoChecklist   = document.createElement("ul");   todoChecklist.classList.add("todo-checklist");
	const todoStatus      = document.createElement("span"); todoStatus.classList.add("todo-status");

	todoTitle.textContent       = todo.title || "Untitled";
	todoDescription.textContent = todo.description;
	todoDueDate.textContent     = formatDate(todo.dueDate);
	todoPriority.textContent    = todo.priority || "Priority";
	todoStatus.textContent      = todo.status || "Status";

	// Migrate legacy notes string to comments array on first access
	if (!Array.isArray(todo.comments)) todo.comments = [];
	if (todo.notes && !todo.comments.length) {
		todo.comments = [{ id: self.crypto.randomUUID(), text: todo.notes, createdAt: todo.updatedAt || todo.createdAt || Date.now() }];
		todo.notes = "";
		ctx.save();
	}

	makeEditable(todoTitle,       todo, "title",          "text",   null,                     ctx.save);
	makeEditable(todoDescription, todo, "description",    "text",   null,                     ctx.save);
	makeEditable(todoPriority,    todo, "priority",       "select", ["Low", "Medium", "High"], ctx.save);
	makeEditable(todoDueDate,     todo, "dueDate",        "date",   null,                     ctx.save);
	makeEditable(todoStatus,      todo, "status",         "select", getColumnLabels(),         () => {
		const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
		if (completedLabels.includes(todo.status)) {
			if (!todo.completedAt) todo.completedAt = Date.now();
		} else {
			todo.completedAt = null;
		}
		ctx.save();
	});

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
		const proj = ctx.project || getCurrentProject();
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
		if (todoCard.querySelector(".move-project-row")) return;

		const selectRow = document.createElement("div");
		selectRow.classList.add("move-project-row");

		const label = document.createElement("span");
		label.classList.add("move-project-label");
		label.textContent = "Move to:";

		const select = document.createElement("select");
		select.classList.add("move-project-select");
		projects.forEach(p => {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = p.title;
			if (!ctx.isInbox && p.id === currentProjectId) opt.selected = true;
			select.appendChild(opt);
		});

		selectRow.appendChild(label);
		selectRow.appendChild(select);
		todoHeader.insertAdjacentElement("afterend", selectRow);
		select.focus();

		function cleanup() { selectRow.remove(); }

		function commitMove() {
			const targetProjectId = select.value;
			const targetProject = projects.find(p => p.id === targetProjectId);
			const validStatuses = getColumnLabels();
			if (!validStatuses.includes(todo.status)) {
				todo.status = validStatuses.find(l => l.toLowerCase().includes("progress")) || validStatuses[0];
			}
			todo.epicId = null; // reset epic when moving projects
			cleanup();
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
				}
			}
		}

		select.addEventListener("change", commitMove);
		select.addEventListener("blur", cleanup);
	});

	// COMMENT BUTTON
	const commentBtn = document.createElement("button");
	commentBtn.classList.add("comment-btn");
	commentBtn.title = "Comments";
	commentBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

	function updateCommentBadge() {
		const count = (todo.comments || []).length;
		let badge = commentBtn.querySelector(".comment-count");
		if (count > 0) {
			if (!badge) { badge = document.createElement("span"); badge.classList.add("comment-count"); commentBtn.appendChild(badge); }
			badge.textContent = count;
		} else if (badge) {
			badge.remove();
		}
	}
	updateCommentBadge();

	commentBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const existing = document.querySelector(".comments-popup");
		if (existing) { existing.remove(); return; }

		const popup = document.createElement("div");
		popup.classList.add("comments-popup");

		const rect = commentBtn.getBoundingClientRect();
		popup.style.top  = `${Math.min(rect.bottom + 6, window.innerHeight - 320)}px`;
		popup.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;

		const hdr = document.createElement("div");
		hdr.classList.add("comments-popup-header");
		const hdrTitle = document.createElement("span");
		hdrTitle.textContent = "Comments";
		const closeX = document.createElement("button");
		closeX.classList.add("comments-popup-close");
		closeX.textContent = "×";
		closeX.addEventListener("click", () => popup.remove());
		hdr.appendChild(hdrTitle);
		hdr.appendChild(closeX);
		popup.appendChild(hdr);

		const list = document.createElement("div");
		list.classList.add("comments-list");

		function fmtCommentTime(ts) {
			if (!ts) return "";
			const d = new Date(ts);
			return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
		}

		function renderCommentList() {
			list.innerHTML = "";
			const sorted = [...(todo.comments || [])].reverse();
			if (!sorted.length) {
				const empty = document.createElement("div");
				empty.classList.add("comments-empty");
				empty.textContent = "No comments yet";
				list.appendChild(empty);
			}
			sorted.forEach(comment => {
				const item = document.createElement("div");
				item.classList.add("comment-item");
				const text = document.createElement("div");
				text.classList.add("comment-text");
				text.textContent = comment.text;
				const time = document.createElement("div");
				time.classList.add("comment-time");
				time.textContent = fmtCommentTime(comment.createdAt);
				item.appendChild(text);
				item.appendChild(time);
				list.appendChild(item);
			});
		}
		renderCommentList();
		popup.appendChild(list);

		const inputRow = document.createElement("div");
		inputRow.classList.add("comment-input-row");
		const textarea = document.createElement("textarea");
		textarea.classList.add("comment-textarea");
		textarea.placeholder = "Add a comment…";
		textarea.rows = 2;
		const sendBtn = document.createElement("button");
		sendBtn.classList.add("comment-send-btn");
		sendBtn.textContent = "Add";
		sendBtn.addEventListener("click", () => {
			const text = textarea.value.trim();
			if (!text) return;
			if (!Array.isArray(todo.comments)) todo.comments = [];
			todo.comments.push({ id: self.crypto.randomUUID(), text, createdAt: Date.now() });
			ctx.save();
			textarea.value = "";
			renderCommentList();
			updateCommentBadge();
		});
		textarea.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); } });
		inputRow.appendChild(textarea);
		inputRow.appendChild(sendBtn);
		popup.appendChild(inputRow);

		document.body.appendChild(popup);
		textarea.focus();

		function onOutside(ev) {
			if (!popup.contains(ev.target) && ev.target !== commentBtn) {
				popup.remove();
				document.removeEventListener("click", onOutside, true);
			}
		}
		setTimeout(() => document.addEventListener("click", onOutside, true), 0);
		popup.addEventListener("keydown", (e) => { if (e.key === "Escape") popup.remove(); });
	});

	// INFO BUTTON
	const infoBtn = document.createElement("button");
	infoBtn.classList.add("todo-info-btn");
	infoBtn.title = "Info";
	infoBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
	infoBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const existing = document.querySelector(".todo-info-popup");
		if (existing) { existing.remove(); return; }
		const popup = document.createElement("div");
		popup.classList.add("todo-info-popup");
		const rect = infoBtn.getBoundingClientRect();
		popup.style.top   = `${rect.bottom + 4}px`;
		popup.style.right = `${window.innerWidth - rect.right}px`;

		function infoRow(label, value) {
			const row = document.createElement("div");
			row.classList.add("todo-info-row");
			const lbl = document.createElement("span");
			lbl.classList.add("todo-info-label");
			lbl.textContent = label;
			const val = document.createElement("span");
			val.classList.add("todo-info-value");
			val.textContent = value;
			row.appendChild(lbl);
			row.appendChild(val);
			return row;
		}

		const created = todo.createdAt
			? new Date(todo.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
			: "Unknown";
		popup.appendChild(infoRow("Created", created));

		const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
		if (completedLabels.includes(todo.status) && todo.completedAt) {
			const completed = new Date(todo.completedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
			popup.appendChild(infoRow("Completed", completed));
		}

		document.body.appendChild(popup);
		function onOutside(ev) {
			if (!popup.contains(ev.target) && ev.target !== infoBtn) {
				popup.remove();
				document.removeEventListener("click", onOutside, true);
			}
		}
		setTimeout(() => document.addEventListener("click", onOutside, true), 0);
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

	// Number badge (DEF-1) — lives in top-bar left
	if (!ctx.isInbox && todo.number) {
		const proj = ctx.project || getCurrentProject();
		if (proj && proj.code) {
			const numBadge = document.createElement("span");
			numBadge.classList.add("todo-number-badge");
			numBadge.textContent = `${proj.code}-${todo.number}`;
			todoHeader.appendChild(numBadge);
		}
	}

	// Pop-out button
	const popoutBtn = document.createElement("button");
	popoutBtn.classList.add("todo-card-popout-btn");
	popoutBtn.title = "Open detail / copy link";
	popoutBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:0.95rem">open_in_new</span>';
	popoutBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const proj = ctx.project || (ctx.isInbox ? null : getCurrentProject());
		showTodoDetail(todo, proj);
	});

	// Action buttons grouped on the right of the header row
	const todoHeaderActions = document.createElement("div");
	todoHeaderActions.classList.add("todo-header-actions");
	if (!ctx.isInbox) {
		const proj = getCurrentProject();
		if (proj && proj.epics && proj.epics.length > 0) todoHeaderActions.appendChild(epicBtn);
	}
	todoHeaderActions.appendChild(commentBtn);
	todoHeaderActions.appendChild(infoBtn);
	todoHeaderActions.appendChild(popoutBtn);
	todoHeaderActions.appendChild(moveBtn);
	todoHeaderActions.appendChild(btnDelete);
	todoHeader.appendChild(todoHeaderActions);

	// Title sits below the header row, spanning full card width

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

	// ACTIONS ROW — checklist add icon + link icon
	const todoActionsRow = document.createElement("div");
	todoActionsRow.classList.add("todo-actions-row");

	// Checklist add icon
	const checklistAddBtn = document.createElement("button");
	checklistAddBtn.classList.add("todo-action-btn");
	checklistAddBtn.title = "Add checklist item";
	checklistAddBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;
	checklistAddBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const input = document.createElement("input");
		input.classList.add("checklist-inline-input");
		input.placeholder = "New item…";
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" && input.value.trim()) {
				todo.checklist.push({ text: input.value.trim(), completed: false });
				ctx.save();
				input.value = "";
			}
			if (ev.key === "Escape") input.blur();
		});
		input.addEventListener("blur", () => input.remove());
		todoActionsRow.insertBefore(input, checklistAddBtn);
		input.focus();
	});

	// Link icon
	const linkBtn = document.createElement("button");
	linkBtn.classList.add("todo-action-btn", "todo-link-btn");
	linkBtn.title = todo.referenceLink ? todo.referenceLink : "Add link";
	if (todo.referenceLink) linkBtn.classList.add("has-link");
	linkBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
	linkBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const existing = todoActionsRow.querySelector(".link-inline-input");
		if (existing) { existing.focus(); return; }
		const input = document.createElement("input");
		input.classList.add("link-inline-input");
		input.type = "url";
		input.placeholder = "https://…";
		input.value = todo.referenceLink || "";
		function saveLink() {
			todo.referenceLink = input.value.trim();
			todo.updatedAt = Date.now();
			ctx.save();
			linkBtn.title = todo.referenceLink || "Add link";
			if (todo.referenceLink) linkBtn.classList.add("has-link");
			else linkBtn.classList.remove("has-link");
			input.remove();
		}
		input.addEventListener("blur", saveLink);
		input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") input.blur(); if (ev.key === "Escape") { input.value = todo.referenceLink || ""; input.blur(); } });
		todoActionsRow.insertBefore(input, linkBtn);
		input.focus();
		input.select();
	});

	// If a link exists, make it also directly openable via right-click / middle-click
	if (todo.referenceLink) {
		linkBtn.addEventListener("auxclick", (e) => {
			if (e.button === 1) { e.preventDefault(); window.open(todo.referenceLink, "_blank", "noopener"); }
		});
		linkBtn.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			window.open(todo.referenceLink, "_blank", "noopener");
		});
	}

	todoActionsRow.appendChild(checklistAddBtn);
	todoActionsRow.appendChild(linkBtn);

	todoCard.appendChild(todoHeader);
	todoCard.appendChild(todoTitle);
	todoCard.appendChild(todoDescription);
	todoCard.appendChild(todoMeta);
	if (hasStackTab && proj?.tools?.length) todoCard.appendChild(toolBadgesRow);
	todoCard.appendChild(todoChecklist);
	todoCard.appendChild(todoActionsRow);
	todoCard.appendChild(todoTagsRow);

	addCardTouchDrag(todoCard, todo, ctx);

	// Apply project color to card border-left
	const cardProject = ctx.project || (ctx.isInbox ? null : getCurrentProject());
	if (cardProject?.color) {
		todoCard.style.setProperty("border-left-color", cardProject.color);
	}

	return todoCard;
}

/* ======================
   INBOX ADD FORM
====================== */

function showContextAddForm() {
	const project = currentView === "project" ? getCurrentProject() : null;
	const activeTab = project?.tabs?.find(t => t.id === currentProjectTab);
	const isNotesTab = (activeTab?.type === "notes") ||
	                   (currentView === "overview" && overviewTab === "notes");

	if (isNotesTab) {
		const note = {
			id: self.crypto.randomUUID(),
			content: "", html: "", tags: [], category: "",
			createdAt: Date.now(), updatedAt: Date.now(),
		};
		if (project) {
			project.notes.unshift(note);
			saveProjects();
		} else {
			userPrefs.generalNotes.unshift(note);
			saveUserPrefs();
		}
		renderTodos();
		showUndoToast("Note created", () => {
			if (project) {
				project.notes = project.notes.filter(n => n.id !== note.id);
				saveProjects();
				if (currentView === "project") renderTodos();
			} else {
				userPrefs.generalNotes = userPrefs.generalNotes.filter(n => n.id !== note.id);
				saveUserPrefs();
				if (currentView === "overview") renderOverview();
			}
		});
		return;
	}

	const btnLabel = project ? `Add to ${project.title}` : "Add to Inbox";

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
	heading.textContent = btnLabel;

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

	const tagsInput = document.createElement("input");
	tagsInput.type = "text";
	tagsInput.placeholder = "Tags (comma-separated, e.g. urgent, bug)";
	tagsInput.classList.add("modal-form-input");

	const addBtn = document.createElement("button");
	addBtn.classList.add("modal-btn-primary");
	addBtn.textContent = btnLabel;

	addBtn.addEventListener("click", () => {
		const title = titleInput.value.trim();
		if (!title) { titleInput.focus(); return; }
		const todo = new Todo(
			title, descInput.value, dueDateInput.value, prioritySelect.value,
			"", [], "", getColumnLabels()[0] || ""
		);
		todo.epicId = null;
		todo.tags = tagsInput.value.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);

		if (project) {
			project.addTodo(todo);
			saveProjects();
			if (currentView === "project") renderTodos();
		} else {
			inbox.push(todo);
			saveInbox();
			if (currentView === "inbox") renderInbox();
		}
		overlay.remove();

		const dest = project ? project.title : "Inbox";
		showUndoToast(`Todo added to ${dest}`, () => {
			if (project) {
				project.todos = project.todos.filter(t => t.id !== todo.id);
				saveProjects();
				if (currentView === "project") renderTodos();
			} else {
				const idx = inbox.indexOf(todo);
				if (idx !== -1) inbox.splice(idx, 1);
				saveInbox();
				if (currentView === "inbox") renderInbox();
			}
		});
	});

	titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

	modal.appendChild(closeBtn);
	modal.appendChild(heading);
	modal.appendChild(makeField("Title", titleInput));
	modal.appendChild(makeField("Description", descInput));
	modal.appendChild(makeField("Priority", prioritySelect));
	modal.appendChild(makeField("Due Date", dueDateInput));
	modal.appendChild(makeField("Tags", tagsInput));
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
	{ type: "notes",  label: "Notes" },
	{ type: "stack",  label: "Tools" },
	{ type: "lists",  label: "Lists" },
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
			pushViewUrl();
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
	if (!project.resources) project.resources = { notes: "", html: "", files: [] };
	if (!project.resources.files) project.resources.files = [];

	const panel = document.createElement("div");
	panel.classList.add("resources-panel");

	// ── File Archive Section ────────────────────────────────
	const archiveSection = document.createElement("div");
	archiveSection.classList.add("resources-archive");

	const archiveHeader = document.createElement("div");
	archiveHeader.classList.add("resources-archive-header");
	const folderIcon = document.createElement("span");
	folderIcon.classList.add("material-symbols-rounded");
	folderIcon.style.fontSize = "0.95rem";
	folderIcon.textContent = "folder";
	archiveHeader.appendChild(folderIcon);
	archiveHeader.appendChild(document.createTextNode(" Files"));
	archiveSection.appendChild(archiveHeader);

	if (!currentUser && !guestMode) {
		// Not logged in, not guest — shouldn't normally happen
		const msg = document.createElement("p");
		msg.classList.add("resources-guest-msg");
		msg.textContent = "Log in to upload files.";
		archiveSection.appendChild(msg);
	} else if (guestMode) {
		const msg = document.createElement("div");
		msg.classList.add("resources-guest-msg");
		msg.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem">lock</span> File uploads require an account.';
		const loginBtn = document.createElement("button");
		loginBtn.classList.add("resources-guest-login");
		loginBtn.textContent = "Log in";
		loginBtn.addEventListener("click", () => {
			localStorage.removeItem("todoroki_guest");
			window.location.reload();
		});
		msg.appendChild(loginBtn);
		archiveSection.appendChild(msg);
	} else {
		// Logged-in: drag-and-drop upload zone
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.multiple = true;
		fileInput.style.display = "none";
		fileInput.accept = "image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.zip";
		panel.appendChild(fileInput);

		const dropZone = document.createElement("div");
		dropZone.classList.add("resources-dropzone");
		const uploadIcon = document.createElement("span");
		uploadIcon.classList.add("material-symbols-rounded");
		uploadIcon.style.fontSize = "1.6rem";
		uploadIcon.textContent = "upload_file";
		dropZone.appendChild(uploadIcon);
		dropZone.appendChild(document.createTextNode("Drag files here or click to upload"));
		dropZone.addEventListener("click", () => fileInput.click());
		dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
		dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
		dropZone.addEventListener("drop", (e) => {
			e.preventDefault();
			dropZone.classList.remove("drag-over");
			handleFiles([...e.dataTransfer.files]);
		});
		fileInput.addEventListener("change", () => {
			handleFiles([...fileInput.files]);
			fileInput.value = "";
		});
		archiveSection.appendChild(dropZone);

		const fileGrid = document.createElement("div");
		fileGrid.classList.add("resources-file-grid");
		archiveSection.appendChild(fileGrid);

		async function handleFiles(files) {
			for (const file of files) {
				await uploadFile(file);
			}
		}

		async function uploadFile(file) {
			const fileId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
			const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
			const path = `${currentUser.id}/${project.id}/${fileId}_${safeName}`;
			dropZone.style.opacity = "0.5";
			const { error } = await supabase.storage.from("resources").upload(path, file);
			dropZone.style.opacity = "";
			if (error) {
				console.error("Upload failed:", error);
				alert("Upload failed: " + (error.message || "unknown error"));
				return;
			}
			project.resources.files.push({
				id: fileId,
				name: file.name,
				type: file.type,
				size: file.size,
				path,
				uploadedAt: new Date().toISOString(),
			});
			saveProjects();
			renderFileGrid();
		}

		async function renderFileGrid() {
			fileGrid.innerHTML = "";
			if (!project.resources.files.length) return;
			for (const file of [...project.resources.files]) {
				const card = document.createElement("div");
				card.classList.add("resources-file-card");

				if (file.type?.startsWith("image/")) {
					const img = document.createElement("img");
					img.classList.add("resources-file-preview");
					img.alt = file.name;
					if (file.path) {
						supabase.storage.from("resources").createSignedUrl(file.path, 3600).then(({ data }) => {
							if (data) img.src = data.signedUrl;
						});
					}
					card.appendChild(img);
					card.addEventListener("click", () => { if (img.src) window.open(img.src, "_blank"); });
				} else {
					const iconEl = document.createElement("span");
					iconEl.classList.add("material-symbols-rounded", "resources-file-icon");
					iconEl.textContent = file.type === "application/pdf" ? "picture_as_pdf" : "description";
					card.appendChild(iconEl);
					card.addEventListener("click", () => {
						supabase.storage.from("resources").createSignedUrl(file.path, 3600).then(({ data }) => {
							if (data) window.open(data.signedUrl, "_blank");
						});
					});
				}

				const nameEl = document.createElement("div");
				nameEl.classList.add("resources-file-name");
				nameEl.textContent = file.name;
				nameEl.title = file.name;

				const delBtn = document.createElement("button");
				delBtn.classList.add("resources-file-delete");
				delBtn.title = "Remove file";
				delBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:0.85rem;line-height:1">close</span>';
				delBtn.addEventListener("click", async (e) => {
					e.stopPropagation();
					if (file.path) await supabase.storage.from("resources").remove([file.path]);
					project.resources.files = project.resources.files.filter(f => f.id !== file.id);
					saveProjects();
					renderFileGrid();
				});

				card.appendChild(nameEl);
				card.appendChild(delBtn);
				fileGrid.appendChild(card);
			}
		}

		renderFileGrid();
	}

	panel.appendChild(archiveSection);

	// ── Notes Section ───────────────────────────────────────
	const wrap = document.createElement("div");
	wrap.classList.add("resources-editor-wrap");

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

	const toolbar = document.createElement("div");
	toolbar.classList.add("resources-toolbar");
	toolbar.style.display = "none";

	const fmtDefs = [
		{ cmd: "bold",      label: "<strong>B</strong>", title: "Bold" },
		{ cmd: "italic",    label: "<em>I</em>",          title: "Italic" },
		{ cmd: "bulletList",label: "• List",              title: "Bullet list" },
		{ cmd: "heading",   label: "H",                   title: "Heading" },
		{ cmd: "blockquote",label: "❝",                  title: "Blockquote" },
		{ cmd: "link",      label: "🔗",                 title: "Insert link" },
	];

	const content = document.createElement("div");
	content.classList.add("resources-content");
	content.contentEditable = "true";
	content.dataset.placeholder = "Add notes for this project…";

	if (project.resources.html) {
		content.innerHTML = project.resources.html;
	} else if (project.resources.notes) {
		content.textContent = project.resources.notes;
		project.resources.html = content.innerHTML;
	}

	function saveNotes() {
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
			saveNotes();
		});
		toolbar.appendChild(btn);
	});

	formatToggle.addEventListener("click", () => {
		const open = toolbar.style.display !== "none";
		toolbar.style.display = open ? "none" : "flex";
		formatToggle.classList.toggle("active", !open);
	});

	content.addEventListener("input", saveNotes);
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
	if (searchQuery) searchInput.style.width = "220px";
	searchInput.addEventListener("input", () => {
		searchQuery = searchInput.value;
		const selStart = searchInput.selectionStart;
		const selEnd = searchInput.selectionEnd;
		renderFn();
		requestAnimationFrame(() => {
			const newInput = document.querySelector(".sort-search-input");
			if (newInput) {
				newInput.style.transition = "none";
				newInput.focus();
				newInput.setSelectionRange(selStart, selEnd);
				requestAnimationFrame(() => { newInput.style.transition = ""; });
			}
		});
	});
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
		projectCode && todo.number ? `${projectCode}-${todo.number}` : null,
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

	const notePopoutBtn = document.createElement("button");
	notePopoutBtn.classList.add("note-card-popout-btn");
	notePopoutBtn.title = "Open detail / copy link";
	notePopoutBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:0.95rem">open_in_new</span>';
	notePopoutBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		showNoteDetail(note, project);
	});

	cardHeader.appendChild(meta);
	cardHeader.appendChild(notePopoutBtn);
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
	title.textContent = "Tools";

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
		}).filter(t => !isKanbanArchived(t))
		  .filter(t => t.status === col.label)
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
		.filter(t => !isKanbanArchived(t))
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

const KANBAN_ARCHIVE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

function isKanbanArchived(todo) {
	if (!columns.find(c => c.label === todo.status)?.isCompleted) return false;
	if (!todo.completedAt) return false;
	return (Date.now() - todo.completedAt) > KANBAN_ARCHIVE_MS;
}

function renderInbox() {
	currentView = "inbox";
	searchQuery = "";
	addTodoBtn.style.display = "none";
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.remove("overview-view");
	document.querySelector("#main").style.removeProperty("--palette-dark");
	document.querySelector("#fab-btn").style.background = "";
	document.querySelector("#fab-btn").style.boxShadow = "";
	projectTitle.style.color = "";
	projectCodeBadge.style.color = "";
	projectCodeBadge.style.background = "";
	projectCodeBadge.style.borderColor = "";
	projectTitle.textContent = "Inbox";
	setViewHeaderIcon("inbox", true);
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

function openStatTodoModal(todo, project) {
	const existing = document.querySelector(".stat-todo-modal-overlay");
	if (existing) existing.remove();
	const overlay = document.createElement("div");
	overlay.classList.add("modal-overlay", "stat-todo-modal-overlay");
	overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
	const wrap = document.createElement("div");
	wrap.classList.add("modal-card");
	wrap.style.maxWidth = "420px";
	wrap.style.padding = "0";
	wrap.style.borderLeft = "none";
	wrap.style.overflow = "hidden";
	const card = buildTodoCard(todo, {
		save: () => { saveProjects(); saveInbox(); renderOverview(); },
		delete: () => {
			if (project) {
				const idx = project.todos.indexOf(todo);
				if (idx !== -1) { project.todos.splice(idx, 1); saveProjects(); }
			} else {
				const idx = inbox.indexOf(todo);
				if (idx !== -1) { inbox.splice(idx, 1); saveInbox(); }
			}
			overlay.remove();
			renderOverview();
		},
		isInbox: !project,
		project: project || null,
	});
	card.style.boxShadow = "none";
	card.style.borderRadius = "0";
	wrap.appendChild(card);
	overlay.appendChild(wrap);
	document.body.appendChild(overlay);
}

function buildStatPopup(todosWithCtx, anchorEl) {
	const popup = document.createElement("div");
	popup.classList.add("stat-todo-popup");
	const rect = anchorEl.getBoundingClientRect();
	popup.style.top  = `${rect.bottom + 6}px`;
	popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 320 - 8))}px`;

	const header = document.createElement("div");
	header.classList.add("stat-popup-header");
	header.textContent = `${todosWithCtx.length} todo${todosWithCtx.length !== 1 ? "s" : ""}`;
	popup.appendChild(header);

	const scrollList = document.createElement("div");
	scrollList.classList.add("stat-todo-list");

	todosWithCtx.forEach(({ todo, project }) => {
		const row = document.createElement("div");
		row.classList.add("stat-todo-row");

		if (project?.code && todo.number) {
			const badge = document.createElement("span");
			badge.classList.add("todo-number-badge");
			badge.textContent = `${project.code}-${todo.number}`;
			row.appendChild(badge);
		}

		const title = document.createElement("span");
		title.classList.add("stat-todo-title");
		title.textContent = todo.title || "Untitled";
		row.appendChild(title);

		if (todo.priority) {
			const pri = document.createElement("span");
			pri.classList.add("todo-priority", "stat-todo-chip");
			pri.textContent = todo.priority;
			row.appendChild(pri);
		}

		if (todo.dueDate) {
			const due = document.createElement("span");
			due.classList.add("stat-todo-due");
			due.textContent = formatDate(todo.dueDate);
			row.appendChild(due);
		}

		row.addEventListener("click", (e) => {
			e.stopPropagation();
			popup.remove();
			openStatTodoModal(todo, project);
		});

		scrollList.appendChild(row);
	});

	popup.appendChild(scrollList);
	return popup;
}

async function callClaudeProxy(messages, { model = "claude-haiku-4-5-20251001", system, max_tokens = 1024 } = {}) {
	const { data: { session } } = await supabase.auth.getSession();
	if (!session) throw new Error("Not authenticated");
	const res = await fetch("/api/claude", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
		body: JSON.stringify({ messages, model, system, max_tokens }),
	});
	const data = await res.json();
	if (!res.ok) {
		const err = new Error(data.message || data.error || "AI request failed");
		err.code = data.error;
		throw err;
	}
	return data;
}

function setViewHeaderIcon(text, isMaterial) {
	const titleWrap = document.querySelector("#project-title-wrap");
	let titleIcon = titleWrap.querySelector(".project-title-icon");
	if (!titleIcon) {
		titleIcon = document.createElement("span");
		titleWrap.insertBefore(titleIcon, projectTitle);
	}
	titleIcon.className = "project-title-icon" + (isMaterial ? " material-symbols-rounded" : " view-title-icon");
	titleIcon.textContent = text;
	titleIcon.style.display = text ? "" : "none";
	titleIcon.onclick = null;
	titleIcon.style.cursor = "default";
}

/* ======================
   LISTS TAB
====================== */

function renderListsTab(project) {
	if (!project.lists) project.lists = [];

	const container = document.createElement("div");
	container.classList.add("lists-tab");

	// ── Header: [+ New List] [sort dropdown] ──────────────
	const header = document.createElement("div");
	header.classList.add("lists-tab-header");

	const addBtn = document.createElement("button");
	addBtn.classList.add("lists-add-btn");
	addBtn.textContent = "+ New List";
	addBtn.addEventListener("click", () => {
		project.lists.push({
			id: self.crypto.randomUUID(),
			title: "New List",
			collapsed: false,
			items: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		saveProjects();
		renderTodos();
	});

	const sortSelect = document.createElement("select");
	sortSelect.classList.add("lists-sort-select");
	[
		{ value: "default",     label: "Manual order" },
		{ value: "az",          label: "A → Z" },
		{ value: "za",          label: "Z → A" },
		{ value: "newest",      label: "Newest first" },
		{ value: "oldest",      label: "Oldest first" },
		{ value: "updated",     label: "Recently updated" },
		{ value: "progress-hi", label: "Most complete" },
		{ value: "progress-lo", label: "Least complete" },
		{ value: "size-hi",     label: "Most items" },
		{ value: "size-lo",     label: "Fewest items" },
	].forEach(({ value, label }) => {
		const opt = document.createElement("option");
		opt.value = value;
		opt.textContent = label;
		if (value === listSortBy) opt.selected = true;
		sortSelect.appendChild(opt);
	});
	sortSelect.addEventListener("change", () => {
		listSortBy = sortSelect.value;
		renderTodos();
	});

	header.appendChild(addBtn);
	header.appendChild(sortSelect);
	container.appendChild(header);

	// ── Sort lists ─────────────────────────────────────────
	const pct = l => l.items.length ? l.items.filter(i => i.checked).length / l.items.length : -1;
	let sortedLists = [...project.lists];
	if      (listSortBy === "az")          sortedLists.sort((a, b) => a.title.localeCompare(b.title));
	else if (listSortBy === "za")          sortedLists.sort((a, b) => b.title.localeCompare(a.title));
	else if (listSortBy === "newest")      sortedLists.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	else if (listSortBy === "oldest")      sortedLists.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
	else if (listSortBy === "updated")     sortedLists.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
	else if (listSortBy === "progress-hi") sortedLists.sort((a, b) => pct(b) - pct(a));
	else if (listSortBy === "progress-lo") sortedLists.sort((a, b) => pct(a) - pct(b));
	else if (listSortBy === "size-hi")     sortedLists.sort((a, b) => b.items.length - a.items.length);
	else if (listSortBy === "size-lo")     sortedLists.sort((a, b) => a.items.length - b.items.length);

	if (project.lists.length === 0) {
		const empty = document.createElement("div");
		empty.classList.add("lists-empty");
		empty.textContent = "No lists yet — click + New List to start.";
		container.appendChild(empty);
	}

	sortedLists.forEach((list) => {
		const card = document.createElement("div");
		card.classList.add("list-card");
		if (list.collapsed) card.classList.add("list-card--collapsed");

		// ── Card header row ────────────────────────────────
		const cardHeader = document.createElement("div");
		cardHeader.classList.add("list-card-header");

		const toggleBtn = document.createElement("button");
		toggleBtn.classList.add("list-card-toggle");
		toggleBtn.textContent = list.collapsed ? "▶" : "▼";
		toggleBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			list.collapsed = !list.collapsed;
			saveProjects();
			renderTodos();
		});

		const titleEl = document.createElement("span");
		titleEl.classList.add("list-card-title");
		titleEl.textContent = list.title;
		titleEl.title = "Double-click to rename";

		function activateRename() {
			const input = document.createElement("input");
			input.classList.add("list-card-title-input");
			input.value = list.title;
			titleEl.replaceWith(input);
			input.focus();
			input.select();
			function saveTitle() {
				const val = input.value.trim();
				if (val) { list.title = val; list.updatedAt = Date.now(); }
				saveProjects();
				renderTodos();
			}
			input.addEventListener("blur", saveTitle);
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") input.blur();
				if (e.key === "Escape") renderTodos();
			});
		}
		titleEl.addEventListener("dblclick", (e) => { e.stopPropagation(); activateRename(); });

		const countBadge = document.createElement("span");
		countBadge.classList.add("list-card-count");
		const done = list.items.filter(i => i.checked).length;
		if (list.items.length) countBadge.textContent = `${done}/${list.items.length}`;

		// Rename button
		const renameBtn = document.createElement("button");
		renameBtn.classList.add("list-card-action-btn");
		renameBtn.title = "Rename list";
		renameBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:0.85rem">edit</span>';
		renameBtn.addEventListener("click", (e) => { e.stopPropagation(); activateRename(); });

		// Move up / down (manual order only)
		const origIdx = project.lists.indexOf(list);
		const moveUpBtn = document.createElement("button");
		moveUpBtn.classList.add("list-card-action-btn", "list-card-move-btn");
		moveUpBtn.title = "Move up";
		moveUpBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:0.85rem">arrow_upward</span>';
		moveUpBtn.disabled = origIdx === 0;
		moveUpBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (origIdx > 0) {
				[project.lists[origIdx], project.lists[origIdx - 1]] = [project.lists[origIdx - 1], project.lists[origIdx]];
				saveProjects();
				renderTodos();
			}
		});

		const moveDownBtn = document.createElement("button");
		moveDownBtn.classList.add("list-card-action-btn", "list-card-move-btn");
		moveDownBtn.title = "Move down";
		moveDownBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:0.85rem">arrow_downward</span>';
		moveDownBtn.disabled = origIdx === project.lists.length - 1;
		moveDownBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (origIdx < project.lists.length - 1) {
				[project.lists[origIdx], project.lists[origIdx + 1]] = [project.lists[origIdx + 1], project.lists[origIdx]];
				saveProjects();
				renderTodos();
			}
		});

		const deleteBtn = document.createElement("button");
		deleteBtn.classList.add("list-card-delete");
		deleteBtn.title = "Delete list";
		deleteBtn.textContent = "✕";
		deleteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			project.lists.splice(origIdx, 1);
			saveProjects();
			renderTodos();
		});

		cardHeader.addEventListener("click", () => {
			list.collapsed = !list.collapsed;
			saveProjects();
			renderTodos();
		});

		cardHeader.appendChild(toggleBtn);
		cardHeader.appendChild(titleEl);
		cardHeader.appendChild(countBadge);
		cardHeader.appendChild(renameBtn);
		if (listSortBy === "default") {
			cardHeader.appendChild(moveUpBtn);
			cardHeader.appendChild(moveDownBtn);
		}
		cardHeader.appendChild(deleteBtn);
		card.appendChild(cardHeader);

		// ── Items ──────────────────────────────────────────
		if (!list.collapsed) {
			const itemsEl = document.createElement("ul");
			itemsEl.classList.add("list-card-items");

			list.items.forEach((item, itemIdx) => {
				const li = document.createElement("li");
				li.classList.add("list-item");
				if (item.checked) li.classList.add("list-item--done");

				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.checked = item.checked;
				checkbox.addEventListener("change", (e) => {
					e.stopPropagation();
					item.checked = checkbox.checked;
					list.updatedAt = Date.now();
					li.classList.toggle("list-item--done", item.checked);
					saveProjects();
					const doneCount = list.items.filter(i => i.checked).length;
					countBadge.textContent = list.items.length ? `${doneCount}/${list.items.length}` : "";
				});

				const textEl = document.createElement("span");
				textEl.classList.add("list-item-text");
				textEl.textContent = item.text;
				textEl.title = "Double-click to edit";
				textEl.addEventListener("dblclick", () => {
					const input = document.createElement("input");
					input.classList.add("list-item-input");
					input.value = item.text;
					textEl.replaceWith(input);
					input.focus();
					function saveItemText() {
						const val = input.value.trim();
						if (val) { item.text = val; list.updatedAt = Date.now(); }
						else { list.items.splice(itemIdx, 1); list.updatedAt = Date.now(); }
						saveProjects();
						renderTodos();
					}
					input.addEventListener("blur", saveItemText);
					input.addEventListener("keydown", (e) => {
						if (e.key === "Enter") input.blur();
						if (e.key === "Escape") renderTodos();
					});
				});

				const delItem = document.createElement("button");
				delItem.classList.add("list-item-delete");
				delItem.title = "Remove item";
				delItem.textContent = "✕";
				delItem.addEventListener("click", (e) => {
					e.stopPropagation();
					list.items.splice(itemIdx, 1);
					list.updatedAt = Date.now();
					saveProjects();
					renderTodos();
				});

				li.appendChild(checkbox);
				li.appendChild(textEl);
				li.appendChild(delItem);
				itemsEl.appendChild(li);
			});

			// Add item row
			const addItemRow = document.createElement("div");
			addItemRow.classList.add("list-add-item-row");

			const addInput = document.createElement("input");
			addInput.classList.add("list-add-item-input");
			addInput.placeholder = "Add item…";

			function addItem() {
				const text = addInput.value.trim();
				if (!text) return;
				list.items.push({ id: self.crypto.randomUUID(), text, checked: false });
				list.updatedAt = Date.now();
				saveProjects();
				renderTodos();
			}
			addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addItem(); });
			addInput.addEventListener("click", (e) => e.stopPropagation());

			const addItemBtn = document.createElement("button");
			addItemBtn.classList.add("list-add-item-btn");
			addItemBtn.textContent = "+";
			addItemBtn.addEventListener("click", (e) => { e.stopPropagation(); addItem(); });

			addItemRow.appendChild(addInput);
			addItemRow.appendChild(addItemBtn);
			card.appendChild(itemsEl);
			card.appendChild(addItemRow);
		}

		container.appendChild(card);
	});

	todoContainer.innerHTML = "";
	todoContainer.appendChild(container);
}

/* ======================
   SHUFFLE VIEW
====================== */

function renderShuffle() {
	addTodoBtn.style.display = "none";
	searchQuery = "";
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.remove("overview-view");

	const mainEl = document.querySelector("#main");
	const fabBtn = document.querySelector("#fab-btn");
	mainEl.style.removeProperty("--palette-dark");
	fabBtn.style.background = "";
	fabBtn.style.boxShadow = "";
	projectTitle.style.color = "";
	projectCodeBadge.style.display = "none";
	projectTitle.textContent = "Shuffle";
	setViewHeaderIcon("shuffle", true);

	projectTabsContainer.innerHTML = "";
	sortBarContainer.innerHTML = "";
	selectionBarContainer.innerHTML = "";

	let filterProjectId = null;
	let filterPriority = null;

	function getPool() {
		const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
		const result = [];
		const srcs = filterProjectId ? projects.filter(p => p.id === filterProjectId) : projects;
		srcs.forEach(p => p.todos.forEach(t => {
			if (completedLabels.includes(t.status)) return;
			if (filterPriority && t.priority !== filterPriority) return;
			result.push({ todo: t, project: p });
		}));
		return result;
	}

	const container = document.createElement("div");
	container.classList.add("shuffle-view");

	// Filters
	const filtersRow = document.createElement("div");
	filtersRow.classList.add("shuffle-filters");

	const projectSelect = document.createElement("select");
	projectSelect.classList.add("shuffle-filter-select");
	const allProj = document.createElement("option");
	allProj.value = "";
	allProj.textContent = "All Projects";
	projectSelect.appendChild(allProj);
	projects.forEach(p => {
		const opt = document.createElement("option");
		opt.value = p.id;
		opt.textContent = p.title;
		projectSelect.appendChild(opt);
	});
	projectSelect.addEventListener("change", () => {
		filterProjectId = projectSelect.value || null;
		shuffle();
	});

	const priorityWrap = document.createElement("div");
	priorityWrap.classList.add("shuffle-priority-pills");
	["All", "Low", "Medium", "High"].forEach(p => {
		const pill = document.createElement("button");
		pill.classList.add("shuffle-priority-pill");
		pill.textContent = p;
		if ((p === "All" && !filterPriority) || p === filterPriority) pill.classList.add("active");
		pill.addEventListener("click", () => {
			filterPriority = p === "All" ? null : p;
			priorityWrap.querySelectorAll(".shuffle-priority-pill").forEach(el => el.classList.remove("active"));
			pill.classList.add("active");
			shuffle();
		});
		priorityWrap.appendChild(pill);
	});

	filtersRow.appendChild(projectSelect);
	filtersRow.appendChild(priorityWrap);

	const shuffleBtn = document.createElement("button");
	shuffleBtn.classList.add("shuffle-btn");
	shuffleBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1.1rem;vertical-align:-3px">shuffle</span> Shuffle';
	shuffleBtn.addEventListener("click", shuffle);

	const cardArea = document.createElement("div");
	cardArea.classList.add("shuffle-card-area");

	function shuffle() {
		const pool = getPool();
		cardArea.innerHTML = "";
		if (!pool.length) {
			const empty = document.createElement("div");
			empty.classList.add("shuffle-empty");
			empty.textContent = "No matching uncompleted todos found.";
			cardArea.appendChild(empty);
			return;
		}
		const { todo, project } = pool[Math.floor(Math.random() * pool.length)];

		const projectLabel = document.createElement("div");
		projectLabel.classList.add("shuffle-todo-project");
		projectLabel.textContent = project.title;
		if (project.color) projectLabel.style.color = project.color;

		const card = buildTodoCard(todo, {
			save: () => saveProjects(),
			delete: () => { project.removeTodo(todo.id); saveProjects(); shuffle(); },
			isInbox: false,
		});

		cardArea.appendChild(projectLabel);
		cardArea.appendChild(card);
	}

	container.appendChild(filtersRow);
	container.appendChild(shuffleBtn);
	container.appendChild(cardArea);

	todoContainer.appendChild(container);
	shuffle();
}

/* ======================
   TODO / NOTE DETAIL MODAL
====================== */

function showTodoDetail(todo, project) {
	const basePath = window.location.pathname;
	history.pushState({}, "", basePath + "?todo=" + todo.id);

	function save() { if (project) saveProjects(); else saveInbox(); }

	const overlay = document.createElement("div");
	overlay.classList.add("detail-overlay");

	const panel = document.createElement("div");
	panel.classList.add("detail-panel");

	// Header
	const header = document.createElement("div");
	header.classList.add("detail-panel-header");

	const titleInput = document.createElement("input");
	titleInput.classList.add("detail-panel-title");
	titleInput.value = todo.title || "";
	titleInput.addEventListener("input", () => { todo.title = titleInput.value; save(); });

	const copyBtn = document.createElement("button");
	copyBtn.classList.add("detail-panel-copy-link");
	copyBtn.title = "Copy link";
	copyBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem">link</span>';
	copyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(window.location.href);
		showUndoToast("Link copied to clipboard", null);
	});

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("detail-panel-close");
	closeBtn.title = "Close";
	closeBtn.textContent = "✕";

	function closeDetail() {
		history.pushState({}, "", basePath);
		overlay.remove();
		document.removeEventListener("keydown", onKeydown);
		// Refresh card in view
		if (currentView === "project") renderTodos();
	}
	function onKeydown(e) { if (e.key === "Escape") closeDetail(); }
	closeBtn.addEventListener("click", closeDetail);
	overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDetail(); });
	document.addEventListener("keydown", onKeydown);

	header.appendChild(titleInput);
	header.appendChild(copyBtn);
	header.appendChild(closeBtn);

	// Body
	const body = document.createElement("div");
	body.classList.add("detail-panel-body");

	// Meta row
	const metaRow = document.createElement("div");
	metaRow.classList.add("detail-panel-meta");

	if (project) {
		const projBadge = document.createElement("span");
		projBadge.classList.add("detail-project-badge");
		projBadge.textContent = project.title;
		if (project.color) {
			projBadge.style.background = project.color + "1a";
			projBadge.style.color = project.color;
			projBadge.style.borderColor = project.color + "33";
		}
		metaRow.appendChild(projBadge);
	}

	const prioritySelect = document.createElement("select");
	prioritySelect.classList.add("detail-meta-select");
	prioritySelect.dataset.priority = (todo.priority || "low").toLowerCase();
	["Low", "Medium", "High"].forEach(p => {
		const opt = document.createElement("option");
		opt.value = p;
		opt.textContent = p;
		if (todo.priority === p) opt.selected = true;
		prioritySelect.appendChild(opt);
	});
	prioritySelect.addEventListener("change", () => {
		todo.priority = prioritySelect.value;
		prioritySelect.dataset.priority = prioritySelect.value.toLowerCase();
		save();
	});

	const statusSelect = document.createElement("select");
	statusSelect.classList.add("detail-meta-select");
	getColumnLabels().forEach(label => {
		const opt = document.createElement("option");
		opt.value = label;
		opt.textContent = label;
		if (todo.status === label) opt.selected = true;
		statusSelect.appendChild(opt);
	});
	statusSelect.addEventListener("change", () => {
		todo.status = statusSelect.value;
		const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
		todo.completedAt = completedLabels.includes(todo.status) ? (todo.completedAt || Date.now()) : null;
		save();
	});

	const dueDateInput = document.createElement("input");
	dueDateInput.type = "date";
	dueDateInput.classList.add("detail-meta-date");
	if (todo.dueDate) dueDateInput.value = todo.dueDate;
	dueDateInput.addEventListener("change", () => { todo.dueDate = dueDateInput.value; save(); });

	metaRow.appendChild(prioritySelect);
	metaRow.appendChild(statusSelect);
	metaRow.appendChild(dueDateInput);

	// Description
	const descLabel = document.createElement("div");
	descLabel.classList.add("detail-field-label");
	descLabel.textContent = "Description";

	const descArea = document.createElement("textarea");
	descArea.classList.add("detail-description");
	descArea.value = todo.description || "";
	descArea.placeholder = "Add a description…";
	descArea.addEventListener("input", () => { todo.description = descArea.value; save(); });

	// Checklist
	const checklistSection = document.createElement("div");
	checklistSection.classList.add("detail-checklist-section");

	function buildChecklist() {
		checklistSection.innerHTML = "";
		const clLabel = document.createElement("div");
		clLabel.classList.add("detail-field-label");
		clLabel.textContent = "Checklist";
		checklistSection.appendChild(clLabel);

		if (!Array.isArray(todo.checklist)) todo.checklist = [];

		const list = document.createElement("ul");
		list.classList.add("detail-checklist");

		todo.checklist.forEach((item, idx) => {
			const li = document.createElement("li");
			li.classList.add("detail-checklist-item");
			if (item.completed) li.classList.add("done");

			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = item.completed;
			cb.addEventListener("change", () => { item.completed = cb.checked; li.classList.toggle("done", item.completed); save(); });

			const span = document.createElement("span");
			span.textContent = item.text;
			span.contentEditable = "true";
			span.addEventListener("blur", () => { item.text = span.textContent.trim() || item.text; save(); });

			const delBtn = document.createElement("button");
			delBtn.classList.add("detail-checklist-del");
			delBtn.textContent = "✕";
			delBtn.addEventListener("click", () => { todo.checklist.splice(idx, 1); save(); buildChecklist(); });

			li.appendChild(cb);
			li.appendChild(span);
			li.appendChild(delBtn);
			list.appendChild(li);
		});

		const addRow = document.createElement("div");
		addRow.classList.add("detail-checklist-add-row");
		const addInput = document.createElement("input");
		addInput.classList.add("detail-checklist-input");
		addInput.placeholder = "Add checklist item…";
		addInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && addInput.value.trim()) {
				todo.checklist.push({ id: self.crypto.randomUUID(), text: addInput.value.trim(), completed: false });
				save();
				buildChecklist();
			}
		});
		addRow.appendChild(addInput);
		checklistSection.appendChild(list);
		checklistSection.appendChild(addRow);
	}
	buildChecklist();

	body.appendChild(metaRow);
	body.appendChild(descLabel);
	body.appendChild(descArea);
	body.appendChild(checklistSection);

	panel.appendChild(header);
	panel.appendChild(body);
	overlay.appendChild(panel);
	document.body.appendChild(overlay);
	titleInput.focus();
}

function showNoteDetail(note, project) {
	const basePath = window.location.pathname;
	history.pushState({}, "", basePath + "?note=" + note.id);

	const overlay = document.createElement("div");
	overlay.classList.add("detail-overlay");

	const panel = document.createElement("div");
	panel.classList.add("detail-panel");
	panel.style.maxWidth = "720px";

	// Header
	const header = document.createElement("div");
	header.classList.add("detail-panel-header");

	const titleEl = document.createElement("span");
	titleEl.style.cssText = "flex:1;font-size:1rem;font-weight:600;color:var(--md-text-color);";
	titleEl.textContent = note.category ? note.category : (project?.title || "Note");

	const copyBtn = document.createElement("button");
	copyBtn.classList.add("detail-panel-copy-link");
	copyBtn.title = "Copy link";
	copyBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem">link</span>';
	copyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(window.location.href);
		showUndoToast("Link copied to clipboard", null);
	});

	const closeBtn = document.createElement("button");
	closeBtn.classList.add("detail-panel-close");
	closeBtn.title = "Close";
	closeBtn.textContent = "✕";

	function closeDetail() {
		history.pushState({}, "", basePath);
		overlay.remove();
		document.removeEventListener("keydown", onKeydown);
	}
	function onKeydown(e) { if (e.key === "Escape") closeDetail(); }
	closeBtn.addEventListener("click", closeDetail);
	overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDetail(); });
	document.addEventListener("keydown", onKeydown);

	header.appendChild(titleEl);
	header.appendChild(copyBtn);
	header.appendChild(closeBtn);

	// Content (full editable)
	const content = document.createElement("div");
	content.classList.add("note-detail-content");
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

	panel.appendChild(header);
	panel.appendChild(content);
	overlay.appendChild(panel);
	document.body.appendChild(overlay);
	content.focus();
}

function checkDetailQuery() {
	const params = new URLSearchParams(window.location.search);
	const todoId = params.get("todo");
	const noteId = params.get("note");
	if (todoId) {
		for (const project of projects) {
			const todo = project.todos.find(t => t.id === todoId);
			if (todo) { showTodoDetail(todo, project); return; }
		}
		const inboxTodo = inbox.find(t => t.id === todoId);
		if (inboxTodo) showTodoDetail(inboxTodo, null);
	} else if (noteId) {
		for (const project of projects) {
			const note = project.notes?.find(n => n.id === noteId);
			if (note) { showNoteDetail(note, project); return; }
		}
	}
}

/* ======================
   GMAIL HELPERS
====================== */

function loadGIS() {
	return new Promise((resolve, reject) => {
		if (window.google?.accounts?.oauth2) { resolve(); return; }
		if (document.querySelector('script[src*="accounts.google.com/gsi"]')) {
			const poll = setInterval(() => {
				if (window.google?.accounts?.oauth2) { clearInterval(poll); resolve(); }
			}, 100);
			setTimeout(() => { clearInterval(poll); reject(new Error("GIS timeout")); }, 10000);
			return;
		}
		const s = document.createElement("script");
		s.src = "https://accounts.google.com/gsi/client";
		s.onload = () => {
			const poll = setInterval(() => {
				if (window.google?.accounts?.oauth2) { clearInterval(poll); resolve(); }
			}, 50);
		};
		s.onerror = reject;
		document.head.appendChild(s);
	});
}

async function requestGmailToken(clientId) {
	await loadGIS();
	return new Promise((resolve, reject) => {
		const client = google.accounts.oauth2.initTokenClient({
			client_id: clientId,
			scope: "https://www.googleapis.com/auth/gmail.readonly",
			callback: (resp) => {
				if (resp.error) { reject(new Error(resp.error)); return; }
				gmailToken = resp.access_token;
				gmailTokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
				resolve();
			},
		});
		client.requestAccessToken();
	});
}

function gmailFetch(path, params = {}) {
	const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
	Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
	return fetch(url, { headers: { Authorization: `Bearer ${gmailToken}` } }).then(r => r.json());
}

function decodeGmailBody(encoded) {
	if (!encoded) return "";
	try {
		const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
		return decodeURIComponent(escape(atob(base64)));
	} catch { return ""; }
}

function extractMessageText(payload) {
	if (!payload) return "";
	if (payload.mimeType === "text/plain" && payload.body?.data)
		return decodeGmailBody(payload.body.data);
	if (payload.mimeType === "text/html" && payload.body?.data) {
		const d = document.createElement("div");
		d.innerHTML = decodeGmailBody(payload.body.data);
		return d.textContent || "";
	}
	if (payload.parts) {
		const plain = payload.parts.find(p => p.mimeType === "text/plain");
		if (plain?.body?.data) return decodeGmailBody(plain.body.data);
		const html = payload.parts.find(p => p.mimeType === "text/html");
		if (html?.body?.data) {
			const d = document.createElement("div");
			d.innerHTML = decodeGmailBody(html.body.data);
			return d.textContent || "";
		}
		for (const part of payload.parts) {
			const t = extractMessageText(part);
			if (t) return t;
		}
	}
	return "";
}

function emailHeader(headers, name) {
	return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function formatEmailDate(internalDate) {
	if (!internalDate) return "";
	const d = new Date(parseInt(internalDate));
	const diffMs = Date.now() - d;
	const diffDays = Math.floor(diffMs / 86400000);
	if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
	if (d.getFullYear() === new Date().getFullYear())
		return d.toLocaleDateString([], { month: "short", day: "numeric" });
	return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function getEmailThreadMeta(threadId) {
	if (!userPrefs.emailPrefs.threads[threadId])
		userPrefs.emailPrefs.threads[threadId] = { notes: "", tags: [], linkedTodoIds: [] };
	return userPrefs.emailPrefs.threads[threadId];
}

function saveEmailThreadMeta(threadId) {
	saveUserPrefs();
}

/* ======================
   EMAIL TAB
====================== */

function renderEmailTab() {
	addTodoBtn.style.display = "none";
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode", "overview-view");
	sortBarContainer.innerHTML = "";
	selectionBarContainer.innerHTML = "";
	projectTabsContainer.innerHTML = "";
	projectCodeBadge.style.display = "none";
	projectTitle.textContent = "Email";
	setViewHeaderIcon("mail", true);

	// Guest mode
	if (guestMode) {
		const gate = document.createElement("div");
		gate.classList.add("assistant-no-key");
		const ic = document.createElement("span");
		ic.classList.add("material-symbols-rounded");
		ic.textContent = "mail";
		const msg = document.createElement("p");
		msg.textContent = "Log in to connect your Gmail inbox.";
		const btn = document.createElement("button");
		btn.classList.add("overview-ai-settings-btn");
		btn.textContent = "Log in";
		btn.addEventListener("click", () => { localStorage.removeItem("todoroki_guest"); window.location.reload(); });
		gate.append(ic, msg, btn);
		todoContainer.appendChild(gate);
		return;
	}

	const prefs = userPrefs.emailPrefs;

	// ── Setup screen ──────────────────────────────────────────
	if (!prefs.clientId) {
		const setup = document.createElement("div");
		setup.classList.add("email-setup");

		const setupIcon = document.createElement("span");
		setupIcon.classList.add("material-symbols-rounded", "email-setup-icon");
		setupIcon.textContent = "mail";

		const setupTitle = document.createElement("h2");
		setupTitle.classList.add("email-setup-title");
		setupTitle.textContent = "Connect Gmail";

		const setupDesc = document.createElement("p");
		setupDesc.classList.add("email-setup-desc");
		setupDesc.innerHTML = `
			Label threads in Gmail with a label (e.g. <strong>Todoroki</strong>), then connect to see them here.
			You need a <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud</a>
			OAuth 2.0 Client ID with the Gmail API enabled and your app domain added as an authorized origin.
		`;

		const form = document.createElement("div");
		form.classList.add("email-setup-form");

		const clientLabel = document.createElement("label");
		clientLabel.classList.add("email-setup-label");
		clientLabel.textContent = "Google OAuth Client ID";
		const clientInput = document.createElement("input");
		clientInput.classList.add("email-setup-input");
		clientInput.placeholder = "xxxx.apps.googleusercontent.com";
		clientInput.type = "text";

		const labelLabel = document.createElement("label");
		labelLabel.classList.add("email-setup-label");
		labelLabel.textContent = "Gmail label to sync";
		const labelInput = document.createElement("input");
		labelInput.classList.add("email-setup-input");
		labelInput.placeholder = "Todoroki";
		labelInput.value = prefs.label || "Todoroki";
		labelInput.type = "text";

		const connectBtn = document.createElement("button");
		connectBtn.classList.add("email-connect-btn");
		connectBtn.textContent = "Connect Gmail";
		connectBtn.addEventListener("click", async () => {
			const cid = clientInput.value.trim();
			const lbl = labelInput.value.trim() || "Todoroki";
			if (!cid) { clientInput.focus(); return; }
			connectBtn.disabled = true;
			connectBtn.textContent = "Connecting…";
			try {
				userPrefs.emailPrefs.clientId = cid;
				userPrefs.emailPrefs.label = lbl;
				await requestGmailToken(cid);
				await saveUserPrefs();
				renderEmailTab();
			} catch (err) {
				connectBtn.disabled = false;
				connectBtn.textContent = "Connect Gmail";
				alert("Connection failed: " + (err.message || "unknown error"));
			}
		});

		form.append(clientLabel, clientInput, labelLabel, labelInput, connectBtn);
		setup.append(setupIcon, setupTitle, setupDesc, form);
		todoContainer.appendChild(setup);
		return;
	}

	// ── Main email layout ────────────────────────────────────
	const layout = document.createElement("div");
	layout.classList.add("email-layout");

	// Left: thread list
	const listPane = document.createElement("div");
	listPane.classList.add("email-thread-list");

	// List header with label, refresh, disconnect
	const listHeader = document.createElement("div");
	listHeader.classList.add("email-list-header");

	const labelChip = document.createElement("span");
	labelChip.classList.add("email-label-chip");
	labelChip.innerHTML = `<span class="material-symbols-rounded" style="font-size:0.9rem">label</span> ${prefs.label || "Todoroki"}`;

	const refreshBtn = document.createElement("button");
	refreshBtn.classList.add("email-icon-btn");
	refreshBtn.title = "Refresh";
	refreshBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem">refresh</span>';

	const settingsBtn = document.createElement("button");
	settingsBtn.classList.add("email-icon-btn");
	settingsBtn.title = "Settings / Disconnect";
	settingsBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem">settings</span>';
	settingsBtn.addEventListener("click", () => {
		if (!confirm(`Disconnect Gmail? This removes your Client ID and label settings.`)) return;
		userPrefs.emailPrefs = { clientId: null, label: "Todoroki", threads: {} };
		gmailToken = null;
		gmailTokenExpiry = 0;
		gmailThreadCache = {};
		currentEmailThreadId = null;
		saveUserPrefs();
		renderEmailTab();
	});

	listHeader.append(labelChip, refreshBtn, settingsBtn);
	listPane.appendChild(listHeader);

	// Thread list body (loading state initially)
	const listBody = document.createElement("div");
	listBody.classList.add("email-list-body");
	listPane.appendChild(listBody);

	// Right: detail pane
	const detailPane = document.createElement("div");
	detailPane.classList.add("email-detail-pane");

	layout.append(listPane, detailPane);
	todoContainer.appendChild(layout);

	// ── Render thread detail ──────────────────────────────────
	function renderThreadDetail(thread) {
		detailPane.innerHTML = "";
		if (!thread) {
			const placeholder = document.createElement("div");
			placeholder.classList.add("email-detail-placeholder");
			const ph_ic = document.createElement("span");
			ph_ic.classList.add("material-symbols-rounded");
			ph_ic.style.fontSize = "2.5rem";
			ph_ic.style.opacity = "0.2";
			ph_ic.textContent = "mail";
			const ph_txt = document.createElement("p");
			ph_txt.style.opacity = "0.4";
			ph_txt.textContent = "Select a thread to read";
			placeholder.append(ph_ic, ph_txt);
			detailPane.appendChild(placeholder);
			return;
		}

		const messages = thread.messages || [];
		const firstMsg = messages[0];
		const subject = emailHeader(firstMsg?.payload?.headers, "subject") || "(No subject)";

		// Detail header
		const dHeader = document.createElement("div");
		dHeader.classList.add("email-detail-header");
		const subjEl = document.createElement("h2");
		subjEl.classList.add("email-detail-subject");
		subjEl.textContent = subject;
		dHeader.appendChild(subjEl);
		detailPane.appendChild(dHeader);

		// Messages
		const msgsEl = document.createElement("div");
		msgsEl.classList.add("email-messages");

		messages.forEach((msg, idx) => {
			const from = emailHeader(msg.payload?.headers, "from");
			const date = formatEmailDate(msg.internalDate);
			const body = extractMessageText(msg.payload);
			const isLast = idx === messages.length - 1;

			const msgEl = document.createElement("div");
			msgEl.classList.add("email-message");
			if (!isLast) msgEl.classList.add("email-message--collapsed");

			const msgHead = document.createElement("div");
			msgHead.classList.add("email-message-head");

			const fromEl = document.createElement("span");
			fromEl.classList.add("email-message-from");
			fromEl.textContent = from;

			const dateEl = document.createElement("span");
			dateEl.classList.add("email-message-date");
			dateEl.textContent = date;

			msgHead.append(fromEl, dateEl);
			msgEl.appendChild(msgHead);

			if (isLast || !msgEl.classList.contains("email-message--collapsed")) {
				const bodyEl = document.createElement("div");
				bodyEl.classList.add("email-message-body");
				bodyEl.textContent = body.trim().slice(0, 2000) + (body.length > 2000 ? "\n…" : "");
				msgEl.appendChild(bodyEl);
			} else {
				// Collapsed: show snippet on click
				const snippetEl = document.createElement("div");
				snippetEl.classList.add("email-message-snippet");
				snippetEl.textContent = body.trim().slice(0, 100) + "…";
				msgEl.appendChild(snippetEl);
				msgHead.style.cursor = "pointer";
				msgHead.addEventListener("click", () => {
					msgEl.classList.remove("email-message--collapsed");
					snippetEl.remove();
					const bodyEl = document.createElement("div");
					bodyEl.classList.add("email-message-body");
					bodyEl.textContent = body.trim().slice(0, 2000) + (body.length > 2000 ? "\n…" : "");
					msgEl.appendChild(bodyEl);
				});
			}

			msgsEl.appendChild(msgEl);
		});
		detailPane.appendChild(msgsEl);

		// ── App metadata ──────────────────────────────────────
		const meta = getEmailThreadMeta(thread.id);

		const metaSection = document.createElement("div");
		metaSection.classList.add("email-meta");

		const metaTitle = document.createElement("div");
		metaTitle.classList.add("email-meta-title");
		metaTitle.innerHTML = '<span class="material-symbols-rounded" style="font-size:0.95rem">edit_note</span> Notes & Links';
		metaSection.appendChild(metaTitle);

		// Notes
		const notesLabel = document.createElement("label");
		notesLabel.classList.add("email-meta-label");
		notesLabel.textContent = "Notes";
		const notesArea = document.createElement("textarea");
		notesArea.classList.add("email-notes-area");
		notesArea.placeholder = "Add notes about this thread…";
		notesArea.value = meta.notes || "";
		notesArea.addEventListener("input", () => {
			meta.notes = notesArea.value;
			saveEmailThreadMeta(thread.id);
		});
		metaSection.append(notesLabel, notesArea);

		// Tags
		const tagsLabel = document.createElement("label");
		tagsLabel.classList.add("email-meta-label");
		tagsLabel.textContent = "Tags";
		const tagsRow = document.createElement("div");
		tagsRow.classList.add("email-tags-row");

		function renderTags() {
			tagsRow.innerHTML = "";
			(meta.tags || []).forEach(tag => {
				const chip = document.createElement("span");
				chip.classList.add("email-tag-chip");
				chip.textContent = "#" + tag;
				const rem = document.createElement("button");
				rem.classList.add("email-tag-remove");
				rem.textContent = "×";
				rem.addEventListener("click", () => {
					meta.tags = meta.tags.filter(t => t !== tag);
					saveEmailThreadMeta(thread.id);
					renderTags();
				});
				chip.appendChild(rem);
				tagsRow.appendChild(chip);
			});
			const tagInput = document.createElement("input");
			tagInput.classList.add("email-tag-input");
			tagInput.placeholder = "+ tag";
			tagInput.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === ",") {
					e.preventDefault();
					const val = tagInput.value.trim().replace(/^#/, "").replace(/,$/, "").toLowerCase();
					if (val && !(meta.tags || []).includes(val)) {
						if (!meta.tags) meta.tags = [];
						meta.tags.push(val);
						saveEmailThreadMeta(thread.id);
					}
					renderTags();
				}
			});
			tagsRow.appendChild(tagInput);
		}
		renderTags();
		metaSection.append(tagsLabel, tagsRow);

		// Linked todos
		const todosLabel = document.createElement("label");
		todosLabel.classList.add("email-meta-label");
		todosLabel.textContent = "Linked Todos";
		const todosArea = document.createElement("div");
		todosArea.classList.add("email-linked-todos");

		function renderLinkedTodos() {
			todosArea.innerHTML = "";
			const allTodos = projects.flatMap(p => p.todos.map(t => ({ todo: t, project: p })));
			(meta.linkedTodoIds || []).forEach(tid => {
				const found = allTodos.find(({ todo }) => todo.id === tid);
				if (!found) return;
				const { todo, project } = found;
				const row = document.createElement("div");
				row.classList.add("email-linked-todo-row");
				const badge = document.createElement("span");
				badge.classList.add("todo-number-badge");
				badge.textContent = `${project.code}-${todo.number}`;
				const title = document.createElement("span");
				title.classList.add("email-linked-todo-title");
				title.textContent = todo.title || "Untitled";
				const remBtn = document.createElement("button");
				remBtn.classList.add("email-tag-remove");
				remBtn.textContent = "×";
				remBtn.addEventListener("click", () => {
					meta.linkedTodoIds = meta.linkedTodoIds.filter(id => id !== tid);
					saveEmailThreadMeta(thread.id);
					renderLinkedTodos();
				});
				row.append(badge, title, remBtn);
				todosArea.appendChild(row);
			});

			// Picker
			const allTodoOptions = projects.flatMap(p =>
				p.todos.filter(t => !(meta.linkedTodoIds || []).includes(t.id))
					.map(t => ({ todo: t, project: p }))
			);
			if (allTodoOptions.length) {
				const picker = document.createElement("select");
				picker.classList.add("email-todo-picker");
				const defOpt = document.createElement("option");
				defOpt.value = "";
				defOpt.textContent = "+ Link a todo…";
				picker.appendChild(defOpt);
				allTodoOptions.forEach(({ todo, project }) => {
					const opt = document.createElement("option");
					opt.value = todo.id;
					opt.textContent = `${project.code}-${todo.number} · ${todo.title || "Untitled"}`;
					picker.appendChild(opt);
				});
				picker.addEventListener("change", () => {
					const id = picker.value;
					if (!id) return;
					if (!meta.linkedTodoIds) meta.linkedTodoIds = [];
					meta.linkedTodoIds.push(id);
					saveEmailThreadMeta(thread.id);
					renderLinkedTodos();
				});
				todosArea.appendChild(picker);
			}
		}
		renderLinkedTodos();
		metaSection.append(todosLabel, todosArea);

		// Linked notes (overview general notes + project notes)
		const notesLinkLabel = document.createElement("label");
		notesLinkLabel.classList.add("email-meta-label");
		notesLinkLabel.textContent = "Linked Notes";
		const linkedNotesArea = document.createElement("div");
		linkedNotesArea.classList.add("email-linked-todos");

		function renderLinkedNotes() {
			linkedNotesArea.innerHTML = "";
			const allNotes = [
				...userPrefs.generalNotes.map(n => ({ note: n, label: "Overview" })),
				...projects.flatMap(p => (p.notes || []).map(n => ({ note: n, label: p.title }))),
			];
			(meta.linkedNoteIds || []).forEach(nid => {
				const found = allNotes.find(({ note }) => note.id === nid);
				if (!found) return;
				const { note, label } = found;
				const row = document.createElement("div");
				row.classList.add("email-linked-todo-row");
				const src = document.createElement("span");
				src.classList.add("email-note-src");
				src.textContent = label;
				const title = document.createElement("span");
				title.classList.add("email-linked-todo-title");
				title.textContent = (note.content || "").slice(0, 60) || "Untitled note";
				const remBtn = document.createElement("button");
				remBtn.classList.add("email-tag-remove");
				remBtn.textContent = "×";
				remBtn.addEventListener("click", () => {
					meta.linkedNoteIds = (meta.linkedNoteIds || []).filter(id => id !== nid);
					saveEmailThreadMeta(thread.id);
					renderLinkedNotes();
				});
				row.append(src, title, remBtn);
				linkedNotesArea.appendChild(row);
			});
			const availableNotes = allNotes.filter(({ note }) => !(meta.linkedNoteIds || []).includes(note.id));
			if (availableNotes.length) {
				const picker = document.createElement("select");
				picker.classList.add("email-todo-picker");
				const defOpt = document.createElement("option");
				defOpt.value = "";
				defOpt.textContent = "+ Link a note…";
				picker.appendChild(defOpt);
				availableNotes.forEach(({ note, label }) => {
					const opt = document.createElement("option");
					opt.value = note.id;
					opt.textContent = `${label} · ${(note.content || "").slice(0, 50) || "Untitled"}`;
					picker.appendChild(opt);
				});
				picker.addEventListener("change", () => {
					const id = picker.value;
					if (!id) return;
					if (!meta.linkedNoteIds) meta.linkedNoteIds = [];
					meta.linkedNoteIds.push(id);
					saveEmailThreadMeta(thread.id);
					renderLinkedNotes();
				});
				linkedNotesArea.appendChild(picker);
			}
		}
		renderLinkedNotes();
		metaSection.append(notesLinkLabel, linkedNotesArea);

		detailPane.appendChild(metaSection);
	}

	renderThreadDetail(null);

	// ── Fetch threads ────────────────────────────────────────
	async function loadThreads() {
		listBody.innerHTML = "";
		const loading = document.createElement("div");
		loading.classList.add("email-loading");
		loading.innerHTML = '<span class="material-symbols-rounded" style="font-size:1.4rem;opacity:0.4">hourglass_empty</span><span>Loading…</span>';
		listBody.appendChild(loading);

		// Ensure token
		if (!gmailToken || Date.now() > gmailTokenExpiry) {
			try {
				await requestGmailToken(prefs.clientId);
			} catch (err) {
				listBody.innerHTML = "";
				const errEl = document.createElement("div");
				errEl.classList.add("email-loading");
				errEl.textContent = "Authentication failed. Check your Client ID.";
				listBody.appendChild(errEl);
				return;
			}
		}

		// Find label ID from name
		let labelId = null;
		try {
			const labelData = await gmailFetch("labels");
			const found = (labelData.labels || []).find(l =>
				l.name.toLowerCase() === (prefs.label || "Todoroki").toLowerCase()
			);
			labelId = found?.id;
		} catch {}

		if (!labelId) {
			listBody.innerHTML = "";
			const errEl = document.createElement("div");
			errEl.classList.add("email-loading");
			errEl.textContent = `Label "${prefs.label || "Todoroki"}" not found in Gmail. Create it and apply it to threads.`;
			listBody.appendChild(errEl);
			return;
		}

		// Fetch thread list
		let threads = [];
		try {
			const data = await gmailFetch("threads", { labelIds: labelId, maxResults: 30 });
			threads = data.threads || [];
		} catch {
			listBody.innerHTML = "";
			const errEl = document.createElement("div");
			errEl.classList.add("email-loading");
			errEl.textContent = "Failed to load threads. Try refreshing.";
			listBody.appendChild(errEl);
			return;
		}

		listBody.innerHTML = "";

		if (!threads.length) {
			const empty = document.createElement("div");
			empty.classList.add("email-loading");
			empty.textContent = `No threads with label "${prefs.label}".`;
			listBody.appendChild(empty);
			return;
		}

		// Render thread rows (fetch metadata for each)
		for (const { id } of threads) {
			const row = document.createElement("div");
			row.classList.add("email-thread-row");
			row.dataset.threadId = id;
			if (id === currentEmailThreadId) row.classList.add("active");
			row.innerHTML = '<div class="email-thread-loading">…</div>';
			listBody.appendChild(row);

			// Fetch thread metadata (use cache if available)
			if (!gmailThreadCache[id]) {
				try {
					gmailThreadCache[id] = await gmailFetch(`threads/${id}`, { format: "full" });
				} catch { continue; }
			}
			const thread = gmailThreadCache[id];
			const msgs = thread.messages || [];
			const first = msgs[0];
			const subject = emailHeader(first?.payload?.headers, "subject") || "(No subject)";
			const from = emailHeader(first?.payload?.headers, "from").replace(/<[^>]+>/, "").trim();
			const last = msgs[msgs.length - 1];
			const date = formatEmailDate(last?.internalDate);
			const snippet = thread.snippet || "";
			const hasMeta = !!(userPrefs.emailPrefs.threads[id]);

			row.innerHTML = "";
			row.classList.toggle("email-thread-row--meta", hasMeta);

			const rowTop = document.createElement("div");
			rowTop.classList.add("email-thread-row-top");
			const subjectEl = document.createElement("span");
			subjectEl.classList.add("email-thread-subject");
			subjectEl.textContent = subject;
			const dateEl = document.createElement("span");
			dateEl.classList.add("email-thread-date");
			dateEl.textContent = date;
			rowTop.append(subjectEl, dateEl);

			const fromEl = document.createElement("div");
			fromEl.classList.add("email-thread-from");
			fromEl.textContent = from;

			const snippetEl = document.createElement("div");
			snippetEl.classList.add("email-thread-snippet");
			snippetEl.textContent = snippet;

			row.append(rowTop, fromEl, snippetEl);
			row.addEventListener("click", () => {
				listBody.querySelectorAll(".email-thread-row").forEach(r => r.classList.remove("active"));
				row.classList.add("active");
				currentEmailThreadId = id;
				renderThreadDetail(thread);
			});

			if (id === currentEmailThreadId) renderThreadDetail(thread);
		}
	}

	refreshBtn.addEventListener("click", () => { gmailThreadCache = {}; loadThreads(); });
	loadThreads();
}

function renderOverview() {
	addTodoBtn.style.display = "none";
	searchQuery = "";
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.add("overview-view");
	projectCodeBadge.style.display = "none";
	sortBarContainer.innerHTML = "";
	document.querySelector("#main").style.removeProperty("--palette-dark");
	document.querySelector("#fab-btn").style.background = "";
	document.querySelector("#fab-btn").style.boxShadow = "";
	projectTitle.style.color = "";

	if (overviewTab === "assistant") {
		projectTabsContainer.innerHTML = "";
		projectTitle.textContent = "Assistant";
		setViewHeaderIcon("✦", false);
		renderOverviewAssistant();
		return;
	}

	projectTitle.textContent = "Overview";
	setViewHeaderIcon("◉", false);

	// Tab bar: Dashboard | Notes (uses same project-tab-bar style)
	projectTabsContainer.innerHTML = "";
	const tabBar = document.createElement("div");
	tabBar.classList.add("project-tab-bar");

	[
		{ id: "dashboard",  label: "Dashboard" },
		{ id: "inprogress", label: "In Progress" },
		{ id: "completed",  label: "Completed" },
		{ id: "notes",      label: "Notes" },
	].forEach(({ id, label }) => {
		const btn = document.createElement("button");
		btn.classList.add("project-tab");
		if (overviewTab === id) btn.classList.add("active");
		btn.textContent = label;
		btn.addEventListener("click", () => {
			overviewTab = id;
			pushViewUrl();
			renderOverview();
		});
		tabBar.appendChild(btn);
	});
	projectTabsContainer.appendChild(tabBar);

	if (overviewTab === "notes")      { renderOverviewNotes();       return; }
	if (overviewTab === "completed")  { renderOverviewCompleted();   return; }
	if (overviewTab === "inprogress") { renderOverviewInProgress();  return; }

	const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
	const now = Date.now();
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

	const allProjectTodos = projects.flatMap(p => p.todos);
	const allTodos = [...allProjectTodos, ...inbox];

	// Build todos-with-ctx arrays for popup
	const allProjectTodosWithCtx = projects.flatMap(p => p.todos.map(t => ({ todo: t, project: p })));
	const allTodosWithCtx = [...allProjectTodosWithCtx, ...inbox.map(t => ({ todo: t, project: null }))];

	const totalCount = allTodos.length;
	const completedCount = allTodos.filter(t => completedLabels.includes(t.status)).length;
	const highPriorityCount = allTodos.filter(t => (t.priority || "").toLowerCase() === "high").length;
	const overdueCount = allTodos.filter(t => {
		if (!t.dueDate || completedLabels.includes(t.status)) return false;
		return new Date(t.dueDate).getTime() < now;
	}).length;

	const completedTodosWithCtx = allTodosWithCtx.filter(({ todo }) => completedLabels.includes(todo.status));
	const highPriorityTodosWithCtx = allTodosWithCtx.filter(({ todo }) => (todo.priority || "").toLowerCase() === "high");
	const overdueTodosWithCtx = allTodosWithCtx.filter(({ todo }) => {
		if (!todo.dueDate || completedLabels.includes(todo.status)) return false;
		return new Date(todo.dueDate).getTime() < now;
	});
	const inboxTodosWithCtx = inbox.map(t => ({ todo: t, project: null }));

	// Stats row
	const statsRow = document.createElement("div");
	statsRow.classList.add("overview-stats-row");

	[
		{ label: "Total",         value: totalCount,         todos: allTodosWithCtx },
		{ label: "Completed",     value: completedCount,     todos: completedTodosWithCtx },
		{ label: "High Priority", value: highPriorityCount,  todos: highPriorityTodosWithCtx },
		{ label: "Overdue",       value: overdueCount,       todos: overdueTodosWithCtx },
		{ label: "In Inbox",      value: inbox.length,       todos: inboxTodosWithCtx },
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

		if (stat.todos.length > 0) {
			card.classList.add("has-popup");
			let activePopup = null;
			card.addEventListener("mouseenter", () => {
				if (activePopup) activePopup.remove();
				activePopup = buildStatPopup(stat.todos, card);
				document.body.appendChild(activePopup);
				activePopup.addEventListener("mouseleave", () => {
					activePopup.remove();
					activePopup = null;
				});
			});
			card.addEventListener("mouseleave", (e) => {
				if (activePopup && !activePopup.contains(e.relatedTarget)) {
					activePopup.remove();
					activePopup = null;
				}
			});
		}

		statsRow.appendChild(card);
	});

	todoContainer.appendChild(statsRow);

	// AI summary panel
	const aiPanel = document.createElement("div");
	aiPanel.classList.add("overview-ai-panel");

	if (guestMode) {
		const noKeyMsg = document.createElement("div");
		noKeyMsg.classList.add("overview-ai-no-key");
		const noKeyIcon = document.createElement("span");
		noKeyIcon.classList.add("material-symbols-rounded");
		noKeyIcon.textContent = "auto_awesome";
		const noKeyText = document.createElement("span");
		noKeyText.textContent = "Log in and add your Anthropic API key to use AI features";
		const noKeyBtn = document.createElement("button");
		noKeyBtn.classList.add("overview-ai-settings-btn");
		noKeyBtn.textContent = "Log in";
		noKeyBtn.addEventListener("click", () => {
			localStorage.removeItem("todoroki_guest");
			window.location.reload();
		});
		noKeyMsg.append(noKeyIcon, noKeyText, noKeyBtn);
		aiPanel.appendChild(noKeyMsg);
	} else if (!userPrefs.anthropicApiKey) {
		const noKeyMsg = document.createElement("div");
		noKeyMsg.classList.add("overview-ai-no-key");
		const noKeyIcon = document.createElement("span");
		noKeyIcon.classList.add("material-symbols-rounded");
		noKeyIcon.textContent = "auto_awesome";
		const noKeyText = document.createElement("span");
		noKeyText.textContent = "Add your Anthropic API key in Settings to use AI features";
		const noKeyBtn = document.createElement("button");
		noKeyBtn.classList.add("overview-ai-settings-btn");
		noKeyBtn.textContent = "Open Settings";
		noKeyBtn.addEventListener("click", () => {
			const userRow = document.querySelector(".sidebar-user-row");
			if (userRow) userRow.click();
		});
		noKeyMsg.append(noKeyIcon, noKeyText, noKeyBtn);
		aiPanel.appendChild(noKeyMsg);
	} else {
		const summariseBtn = document.createElement("button");
		summariseBtn.classList.add("overview-ai-btn");
		const btnIcon = document.createElement("span");
		btnIcon.classList.add("material-symbols-rounded");
		btnIcon.textContent = "auto_awesome";
		const btnLabel = document.createElement("span");
		btnLabel.textContent = "Summarise my todos";
		summariseBtn.append(btnIcon, btnLabel);

		const resultCard = document.createElement("div");
		resultCard.classList.add("overview-ai-result");
		resultCard.style.display = "none";

		summariseBtn.addEventListener("click", async () => {
			if (summariseBtn.dataset.loading) return;
			summariseBtn.dataset.loading = "1";
			btnLabel.textContent = "Summarising…";
			btnIcon.textContent = "hourglass_empty";
			summariseBtn.disabled = true;
			resultCard.style.display = "none";
			try {
				const inProgressStatuses = columns.filter(c => !c.isCompleted).map(c => c.label);
				const todoList = projects.flatMap(p => p.todos.filter(t => inProgressStatuses.includes(t.status)).map(t => ({
					project: p.title,
					title: t.title,
					priority: t.priority || "Low",
					status: t.status,
					dueDate: t.dueDate || null,
					description: t.description || "",
				})));
				const inboxActive = inbox.filter(t => inProgressStatuses.includes(t.status)).map(t => ({
					project: "Inbox",
					title: t.title,
					priority: t.priority || "Low",
					status: t.status,
					dueDate: t.dueDate || null,
					description: t.description || "",
				}));
				const allActive = [...todoList, ...inboxActive];

				if (!allActive.length) {
					resultCard.style.display = "";
					resultCard.innerHTML = "";
					const empty = document.createElement("p");
					empty.textContent = "No active todos to summarise.";
					resultCard.appendChild(empty);
					return;
				}

				const todoText = allActive.map(t =>
					`- [${t.project}] ${t.title} (${t.priority} priority${t.dueDate ? `, due ${t.dueDate}` : ""}${t.description ? `: ${t.description.slice(0, 100)}` : ""})`
				).join("\n");

				const response = await callClaudeProxy(
					[{ role: "user", content: `Here are my active todos:\n\n${todoText}\n\nPlease give me a concise summary: what's most important, any overdue or high-priority items, and a suggested focus for today. Keep it to 3-4 sentences.` }],
					{ system: "You are a helpful productivity assistant. Be concise, practical, and encouraging." }
				);

				const summary = response.content?.[0]?.text || "No summary returned.";
				resultCard.style.display = "";
				resultCard.innerHTML = "";
				const summaryHeader = document.createElement("div");
				summaryHeader.classList.add("overview-ai-result-header");
				const summaryIcon = document.createElement("span");
				summaryIcon.classList.add("material-symbols-rounded");
				summaryIcon.textContent = "auto_awesome";
				const summaryTitle = document.createElement("span");
				summaryTitle.textContent = "AI Summary";
				const dismissBtn = document.createElement("button");
				dismissBtn.classList.add("overview-ai-dismiss");
				dismissBtn.innerHTML = "×";
				dismissBtn.addEventListener("click", () => { resultCard.style.display = "none"; });
				summaryHeader.append(summaryIcon, summaryTitle, dismissBtn);
				const summaryText = document.createElement("div");
				summaryText.classList.add("overview-ai-summary-text");
				summaryText.innerHTML = parseMarkdown(summary);
				resultCard.append(summaryHeader, summaryText);
			} catch (err) {
				resultCard.style.display = "";
				resultCard.innerHTML = "";
				const errMsg = document.createElement("p");
				errMsg.classList.add("overview-ai-error");
				errMsg.textContent = err.message || "Failed to get summary.";
				resultCard.appendChild(errMsg);
			} finally {
				delete summariseBtn.dataset.loading;
				btnLabel.textContent = "Summarise my todos";
				btnIcon.textContent = "auto_awesome";
				summariseBtn.disabled = false;
			}
		});

		aiPanel.append(summariseBtn, resultCard);
	}
	todoContainer.appendChild(aiPanel);

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

// ── Build context string from all user data ────────────────────────
function buildAssistantContext() {
	const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
	const now = new Date();
	let ctx = `Today: ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}\n`;
	ctx += `Current time: ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}\n\n`;

	ctx += `KANBAN COLUMNS (ordered):\n`;
	columns.forEach(c => { ctx += `  - "${c.label}"${c.isCompleted ? " [completed]" : ""}\n`; });
	ctx += "\n";

	ctx += `PROJECTS (${projects.length}):\n`;
	projects.forEach(p => {
		const active = p.todos.filter(t => !completedLabels.includes(t.status));
		const done   = p.todos.filter(t =>  completedLabels.includes(t.status));
		ctx += `\nProject: "${p.title}" (id: ${p.id})\n`;
		if (active.length === 0 && done.length === 0) {
			ctx += `  (no todos)\n`;
		} else {
			if (active.length) {
				ctx += `  Active todos:\n`;
				active.forEach(t => {
					const overdue = t.dueDate && new Date(t.dueDate) < now && !completedLabels.includes(t.status);
					ctx += `    - id:${t.id} | "${t.title}" | ${t.status} | ${t.priority} priority`;
					if (t.dueDate) ctx += ` | due: ${t.dueDate}${overdue ? " ⚠️ OVERDUE" : ""}`;
					if (t.description) ctx += ` | notes: ${t.description.slice(0, 80)}`;
					ctx += "\n";
				});
			}
			if (done.length) ctx += `  Completed: ${done.length} todo(s)\n`;
		}
	});

	ctx += `\nINBOX (${inbox.length} todos):\n`;
	if (inbox.length === 0) {
		ctx += `  (empty)\n`;
	} else {
		inbox.forEach(t => {
			const overdue = t.dueDate && new Date(t.dueDate) < now;
			ctx += `  - id:${t.id} | "${t.title}" | ${t.status} | ${t.priority} priority`;
			if (t.dueDate) ctx += ` | due: ${t.dueDate}${overdue ? " ⚠️ OVERDUE" : ""}`;
			ctx += "\n";
		});
	}

	return ctx;
}

// ── Parse and execute a structured action from Claude's response ───
function parseAssistantActions(text) {
	const matches = [...text.matchAll(/<action>([\s\S]*?)<\/action>/g)];
	return matches.map(m => { try { return JSON.parse(m[1].trim()); } catch { return null; } }).filter(Boolean);
}

function stripActionTags(text) {
	return text.replace(/<action>[\s\S]*?<\/action>/g, "").trim();
}

async function executeAssistantAction(action) {
	const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);

	if (action.type === "create_todo") {
		const defaultStatus = columns.find(c => !c.isCompleted)?.label || "Not Started";
		const todo = {
			id: self.crypto.randomUUID(),
			title: action.title || "New todo",
			status: action.status || defaultStatus,
			priority: action.priority || "Low",
			dueDate: action.due_date || "",
			description: action.notes || "",
			notes: action.notes || "",
			checklist: [], referenceLink: "", epicId: null,
			number: 0, toolIds: [], tags: [], comments: [],
			completedAt: null, schedule: null,
			createdAt: Date.now(), updatedAt: Date.now(),
		};
		if (completedLabels.includes(todo.status)) todo.completedAt = Date.now();
		if (action.project_id) {
			const proj = projects.find(p => p.id === action.project_id);
			if (proj) { proj.addTodo(todo); renumberProjectTodos(proj); }
		} else {
			inbox.push(todo);
		}
		saveProjects(); saveInbox();
		return `✓ Created todo: "${todo.title}"`;
	}

	if (action.type === "update_todo") {
		let todo = null;
		for (const p of projects) { todo = p.todos.find(t => t.id === action.todo_id); if (todo) break; }
		if (!todo) todo = inbox.find(t => t.id === action.todo_id);
		if (!todo) return `Could not find todo with id ${action.todo_id}`;
		if (action.title    !== undefined) todo.title    = action.title;
		if (action.priority !== undefined) todo.priority = action.priority;
		if (action.due_date !== undefined) todo.dueDate  = action.due_date || "";
		if (action.notes    !== undefined) todo.notes    = action.notes;
		if (action.status   !== undefined) {
			todo.status = action.status;
			if (completedLabels.includes(action.status) && !todo.completedAt) todo.completedAt = Date.now();
			else if (!completedLabels.includes(action.status)) todo.completedAt = null;
		}
		todo.updatedAt = Date.now();
		saveProjects(); saveInbox();
		return `✓ Updated todo: "${todo.title}"`;
	}

	if (action.type === "complete_todo") {
		let todo = null;
		for (const p of projects) { todo = p.todos.find(t => t.id === action.todo_id); if (todo) break; }
		if (!todo) todo = inbox.find(t => t.id === action.todo_id);
		if (!todo) return `Could not find todo with id ${action.todo_id}`;
		const doneLabel = columns.find(c => c.isCompleted)?.label || "Done";
		todo.status = doneLabel;
		todo.completedAt = Date.now();
		todo.updatedAt = Date.now();
		saveProjects(); saveInbox();
		return `✓ Completed: "${todo.title}"`;
	}

	return null;
}

function renderOverviewAssistant() {
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");

	const SYSTEM_PROMPT = `You are a smart, concise personal assistant for a todo/project management app called Todoroki. You help the user stay on top of their work.

You have access to the user's complete project and todo data in every message. Use it to give specific, actionable answers.

When the user asks you to CREATE, UPDATE, or COMPLETE a todo, you MUST include a structured action tag at the end of your response. Use this exact format (one per action):
<action>{"type":"create_todo","title":"...","project_id":"PROJECT_ID_OR_NULL","priority":"Low|Medium|High","status":"STATUS_LABEL","due_date":"YYYY-MM-DD_OR_NULL","notes":"OPTIONAL"}</action>
<action>{"type":"update_todo","todo_id":"ID","title":"...","status":"...","priority":"...","due_date":"...","notes":"..."}</action>
<action>{"type":"complete_todo","todo_id":"ID"}</action>

Only include fields that are changing in update_todo. Use null for project_id to add to inbox.
For queries and summaries, do NOT include action tags — just respond with text.
Keep responses concise. Use markdown for formatting. Never invent todo IDs — only use IDs from the context.`;

	if (guestMode) {
		const noKey = document.createElement("div");
		noKey.classList.add("assistant-no-key");
		const icon = document.createElement("span");
		icon.classList.add("material-symbols-rounded");
		icon.textContent = "auto_awesome";
		const msg = document.createElement("p");
		msg.textContent = "Log in and add your Anthropic API key to use the Personal Assistant.";
		const btn = document.createElement("button");
		btn.classList.add("overview-ai-settings-btn");
		btn.textContent = "Log in";
		btn.addEventListener("click", () => { localStorage.removeItem("todoroki_guest"); window.location.reload(); });
		noKey.append(icon, msg, btn);
		todoContainer.appendChild(noKey);
		return;
	}

	if (!userPrefs.anthropicApiKey) {
		const noKey = document.createElement("div");
		noKey.classList.add("assistant-no-key");
		const icon = document.createElement("span");
		icon.classList.add("material-symbols-rounded");
		icon.textContent = "auto_awesome";
		const msg = document.createElement("p");
		msg.textContent = "Add your Anthropic API key in Settings to use the Personal Assistant.";
		const btn = document.createElement("button");
		btn.classList.add("overview-ai-settings-btn");
		btn.textContent = "Open Settings";
		btn.addEventListener("click", () => { const r = document.querySelector(".sidebar-user-row"); if (r) r.click(); });
		noKey.append(icon, msg, btn);
		todoContainer.appendChild(noKey);
		return;
	}

	const container = document.createElement("div");
	container.classList.add("assistant-container");

	// ── Quick actions ──────────────────────────────────────────────
	const quickRow = document.createElement("div");
	quickRow.classList.add("assistant-quick-actions");
	const quickActions = [
		{ label: "Summarise my week",       prompt: "Give me a summary of my week: what I've completed, what's in progress, and any upcoming deadlines." },
		{ label: "What's overdue?",         prompt: "Which of my todos are overdue? List them with their project and how late they are." },
		{ label: "What should I focus on?", prompt: "Based on my priorities, due dates, and workload, what should I focus on today?" },
		{ label: "How productive have I been?", prompt: "How productive have I been recently? Look at completed todos and give me an honest assessment." },
		{ label: "What's coming up?",       prompt: "What deadlines and todos are coming up in the next 7–14 days?" },
	];
	quickActions.forEach(({ label, prompt }) => {
		const btn = document.createElement("button");
		btn.classList.add("assistant-quick-btn");
		btn.textContent = label;
		btn.addEventListener("click", () => sendMessage(prompt, label));
		quickRow.appendChild(btn);
	});
	container.appendChild(quickRow);

	// ── Messages area ─────────────────────────────────────────────
	const messagesEl = document.createElement("div");
	messagesEl.classList.add("assistant-messages");

	// Welcome message (only if no history yet)
	if (assistantHistory.length === 0) {
		const welcome = document.createElement("div");
		welcome.classList.add("assistant-welcome");
		const welcomeIcon = document.createElement("span");
		welcomeIcon.classList.add("material-symbols-rounded");
		welcomeIcon.textContent = "auto_awesome";
		const welcomeText = document.createElement("p");
		welcomeText.textContent = "Hi! I can see all your projects and todos. Ask me anything, or use a quick action above.";
		welcome.append(welcomeIcon, welcomeText);
		messagesEl.appendChild(welcome);
	} else {
		// Re-render previous messages from history
		assistantHistory.forEach(msg => {
			appendMessage(messagesEl, msg.role, msg.displayContent || msg.content);
		});
	}

	container.appendChild(messagesEl);

	// ── Input row ─────────────────────────────────────────────────
	const inputRow = document.createElement("div");
	inputRow.classList.add("assistant-input-row");

	const textarea = document.createElement("textarea");
	textarea.classList.add("assistant-input");
	textarea.placeholder = "Ask anything about your todos, or tell me what to create…";
	textarea.rows = 1;
	textarea.addEventListener("input", () => {
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
	});
	textarea.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (textarea.value.trim()) sendMessage(textarea.value.trim());
		}
	});

	const sendBtn = document.createElement("button");
	sendBtn.classList.add("assistant-send-btn");
	sendBtn.innerHTML = `<span class="material-symbols-rounded">send</span>`;
	sendBtn.addEventListener("click", () => { if (textarea.value.trim()) sendMessage(textarea.value.trim()); });

	inputRow.append(textarea, sendBtn);
	container.appendChild(inputRow);
	todoContainer.appendChild(container);

	// ── Core send/receive logic ────────────────────────────────────
	function appendMessage(container, role, content, isAction = false) {
		const wrapper = document.createElement("div");
		wrapper.classList.add("assistant-message", `assistant-message--${role}`);
		if (isAction) wrapper.classList.add("assistant-message--action");

		const bubble = document.createElement("div");
		bubble.classList.add("assistant-bubble");

		if (isAction) {
			bubble.textContent = content;
		} else if (role === "assistant") {
			bubble.classList.add("assistant-bubble--md");
			bubble.innerHTML = parseMarkdown(content);
		} else {
			bubble.textContent = content;
		}

		wrapper.appendChild(bubble);
		container.appendChild(wrapper);
		container.scrollTop = container.scrollHeight;
		return wrapper;
	}

	function showThinking() {
		const wrapper = document.createElement("div");
		wrapper.classList.add("assistant-message", "assistant-message--assistant", "assistant-message--thinking");
		const bubble = document.createElement("div");
		bubble.classList.add("assistant-bubble", "assistant-thinking");
		bubble.innerHTML = `<span></span><span></span><span></span>`;
		wrapper.appendChild(bubble);
		messagesEl.appendChild(wrapper);
		messagesEl.scrollTop = messagesEl.scrollHeight;
		return wrapper;
	}

	async function sendMessage(text, displayText) {
		const label = displayText || text;
		textarea.value = "";
		textarea.style.height = "auto";
		sendBtn.disabled = true;
		textarea.disabled = true;

		// Show user message
		appendMessage(messagesEl, "user", label);

		// Build messages array for API (use actual prompt text, not display label)
		const userMsg = { role: "user", content: text };
		assistantHistory.push({ ...userMsg, displayContent: label });

		// Show thinking indicator
		const thinkingEl = showThinking();

		try {
			const context = buildAssistantContext();
			const systemWithContext = `${SYSTEM_PROMPT}\n\n--- USER DATA ---\n${context}`;

			// Build messages array (strip displayContent before sending)
			const apiMessages = assistantHistory.map(({ role, content }) => ({ role, content }));

			const response = await callClaudeProxy(apiMessages, {
				system: systemWithContext,
				max_tokens: 1500,
			});

			const rawContent = response.content?.[0]?.text || "";

			// Parse and execute actions
			const actions = parseAssistantActions(rawContent);
			const displayContent = stripActionTags(rawContent);

			thinkingEl.remove();

			// Add assistant message to history and display
			assistantHistory.push({ role: "assistant", content: rawContent, displayContent });
			appendMessage(messagesEl, "assistant", displayContent);

			// Execute actions and show confirmations
			for (const action of actions) {
				const confirmation = await executeAssistantAction(action);
				if (confirmation) {
					appendMessage(messagesEl, "action", confirmation, true);
				}
			}

			// If actions modified data, re-render sidebar
			if (actions.length > 0) {
				renderProjects();
			}

		} catch (err) {
			thinkingEl.remove();
			appendMessage(messagesEl, "assistant", `Sorry, something went wrong: ${err.message}`);
		} finally {
			sendBtn.disabled = false;
			textarea.disabled = false;
			textarea.focus();
		}
	}
}

function renderOverviewCompleted() {
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.add("overview-view");

	const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
	const allTodos = [
		...projects.flatMap(p => p.todos.map(t => ({ todo: t, project: p }))),
		...inbox.map(t => ({ todo: t, project: null })),
	].filter(({ todo }) => completedLabels.includes(todo.status));

	// Sort / filter state
	let search = "";
	let tagFilter = null;
	let projectFilter = null;

	const allProjects = [...new Set(allTodos.map(({ project }) => project).filter(Boolean))];
	const allTags = [...new Set(allTodos.flatMap(({ todo }) => todo.tags || []))];

	const wrapper = document.createElement("div");
	wrapper.classList.add("ov-completed-wrapper");

	// Controls row
	const controls = document.createElement("div");
	controls.classList.add("ov-controls-row");

	const searchInput = document.createElement("input");
	searchInput.type = "search";
	searchInput.placeholder = "Search…";
	searchInput.classList.add("sort-search-input");
	searchInput.style.width = "200px";
	searchInput.addEventListener("input", () => { search = searchInput.value; rebuild(); });

	const projectSel = document.createElement("select");
	projectSel.classList.add("ov-filter-select");
	const allProjOpt = document.createElement("option"); allProjOpt.value = ""; allProjOpt.textContent = "All projects"; projectSel.appendChild(allProjOpt);
	allProjects.forEach(p => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.title; projectSel.appendChild(o); });
	projectSel.addEventListener("change", () => { projectFilter = projectSel.value || null; rebuild(); });

	const tagSel = document.createElement("select");
	tagSel.classList.add("ov-filter-select");
	const allTagOpt = document.createElement("option"); allTagOpt.value = ""; allTagOpt.textContent = "All tags"; tagSel.appendChild(allTagOpt);
	allTags.forEach(t => { const o = document.createElement("option"); o.value = t; o.textContent = `#${t}`; tagSel.appendChild(o); });
	tagSel.addEventListener("change", () => { tagFilter = tagSel.value || null; rebuild(); });

	controls.appendChild(searchInput);
	if (allProjects.length > 1) controls.appendChild(projectSel);
	if (allTags.length) controls.appendChild(tagSel);
	wrapper.appendChild(controls);

	const gridContainer = document.createElement("div");
	wrapper.appendChild(gridContainer);

	function rebuild() {
		gridContainer.innerHTML = "";
		const q = search.toLowerCase();

		const filtered = allTodos.filter(({ todo, project }) => {
			if (projectFilter && project?.id !== projectFilter) return false;
			if (tagFilter && !(todo.tags || []).includes(tagFilter)) return false;
			if (q) {
				const match = [todo.title, todo.description, todo.status, ...(todo.tags || [])].some(s => s?.toLowerCase().includes(q));
				if (!match) return false;
			}
			return true;
		});

		if (!filtered.length) {
			const empty = document.createElement("div");
			empty.classList.add("ov-empty-msg");
			empty.textContent = "No completed todos.";
			gridContainer.appendChild(empty);
			return;
		}

		// Sort newest first by completedAt/updatedAt
		const sorted = [...filtered].sort((a, b) => {
			const aTs = a.todo.completedAt || a.todo.updatedAt || 0;
			const bTs = b.todo.completedAt || b.todo.updatedAt || 0;
			return bTs - aTs;
		});

		const grid = document.createElement("div");
		grid.classList.add("ov-completed-grid");

		let lastDay = null;
		sorted.forEach(({ todo, project }) => {
			const ts = todo.completedAt || todo.updatedAt || 0;
			const day = ts ? new Date(ts).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "Unknown date";

			if (day !== lastDay) {
				lastDay = day;
				const separator = document.createElement("div");
				separator.classList.add("ov-completed-date-separator");
				grid.appendChild(separator);
				separator.textContent = day;
			}

			const ctx = {
				save: () => { saveProjects(); rebuild(); },
				delete: () => {
					if (project) {
						const idx = project.todos.indexOf(todo);
						if (idx !== -1) { project.todos.splice(idx, 1); saveProjects(); }
					}
					rebuild();
				},
				isInbox: !project,
				project,
			};
			const card = buildTodoCard(todo, ctx);
			grid.appendChild(card);
		});

		gridContainer.appendChild(grid);
	}

	rebuild();
	todoContainer.appendChild(wrapper);
}

function renderOverviewInProgress() {
	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.add("overview-view");

	const completedLabels = columns.filter(c => c.isCompleted).map(c => c.label);
	const inProgressTodos = projects.flatMap(p =>
		p.todos
			.filter(t => !completedLabels.includes(t.status))
			.map(t => ({ todo: t, project: p }))
	);

	const todayStr = new Date().toISOString().slice(0, 10);

	// Ensure schedule structure
	inProgressTodos.forEach(({ todo }) => {
		if (!todo.schedule) todo.schedule = {};
	});

	// View toggle: day | week
	let viewMode = "day"; // "day" | "week"
	const viewDate = new Date();
	viewDate.setHours(0, 0, 0, 0);

	const outer = document.createElement("div");
	outer.classList.add("inprogress-outer");

	// Top controls
	const topBar = document.createElement("div");
	topBar.classList.add("inprogress-topbar");
	const dayBtn = document.createElement("button");
	dayBtn.classList.add("project-tab", "active");
	dayBtn.textContent = "Day";
	const weekBtn = document.createElement("button");
	weekBtn.classList.add("project-tab");
	weekBtn.textContent = "Week";
	dayBtn.addEventListener("click", () => { viewMode = "day"; dayBtn.classList.add("active"); weekBtn.classList.remove("active"); rebuildTimeline(); });
	weekBtn.addEventListener("click", () => { viewMode = "week"; weekBtn.classList.add("active"); dayBtn.classList.remove("active"); rebuildTimeline(); });
	const tabGroup = document.createElement("div");
	tabGroup.classList.add("project-tab-bar");
	tabGroup.style.marginBottom = "0";
	tabGroup.appendChild(dayBtn);
	tabGroup.appendChild(weekBtn);
	topBar.appendChild(tabGroup);

	// Calendar export controls
	const calActions = document.createElement("div");
	calActions.classList.add("inprogress-cal-actions");

	const exportBtn = document.createElement("button");
	exportBtn.classList.add("inprogress-cal-btn");
	exportBtn.title = "Download .ics file to import into any calendar app";
	exportBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem;vertical-align:middle;">download</span> Export .ics';
	exportBtn.addEventListener("click", () => { downloadICS(); showUndoToast("Calendar file downloaded", null); });

	const feedBtn = document.createElement("button");
	feedBtn.classList.add("inprogress-cal-btn");
	feedBtn.title = "Get a live iCal feed URL to subscribe from Google Calendar";
	feedBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem;vertical-align:middle;">link</span> iCal Feed';
	feedBtn.addEventListener("click", async () => {
		feedBtn.disabled = true;
		feedBtn.textContent = "…";
		try {
			const token = await getOrCreateIcalToken();
			const feedUrl = `${window.location.origin}/api/calendar/${token}.ics`;
			await navigator.clipboard.writeText(feedUrl);
			showUndoToast("Feed URL copied — paste it into Google Calendar → Other calendars → From URL", null);
		} catch (e) {
			alert("Failed to generate feed URL: " + e.message);
		} finally {
			feedBtn.disabled = false;
			feedBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem;vertical-align:middle;">link</span> iCal Feed';
		}
	});

	calActions.appendChild(exportBtn);
	calActions.appendChild(feedBtn);
	topBar.appendChild(calActions);

	outer.appendChild(topBar);

	const splitView = document.createElement("div");
	splitView.classList.add("inprogress-split");
	outer.appendChild(splitView);

	// LEFT — Timeline
	const timelinePanel = document.createElement("div");
	timelinePanel.classList.add("timeline-panel");
	splitView.appendChild(timelinePanel);

	// RIGHT — Todo list
	const listPanel = document.createElement("div");
	listPanel.classList.add("inprogress-list-panel");

	const listTitle = document.createElement("div");
	listTitle.classList.add("inprogress-list-title");
	listTitle.textContent = "In Progress";
	listPanel.appendChild(listTitle);

	const listScroll = document.createElement("div");
	listScroll.classList.add("inprogress-list-scroll");

	function openInProgressTodoModal(todo, project) {
		const existing = document.querySelector(".inprogress-modal-overlay");
		if (existing) existing.remove();
		const overlay = document.createElement("div");
		overlay.classList.add("modal-overlay", "inprogress-modal-overlay");
		overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
		const wrap = document.createElement("div");
		wrap.classList.add("modal-card");
		wrap.style.maxWidth = "420px";
		wrap.style.padding = "0";
		wrap.style.borderLeft = "none";
		wrap.style.overflow = "hidden";
		const card = buildTodoCard(todo, {
			save: () => { saveProjects(); rebuildTimeline(); renderList(); },
			delete: () => {
				const idx = project.todos.indexOf(todo);
				if (idx !== -1) { project.todos.splice(idx, 1); saveProjects(); }
				overlay.remove();
				renderOverviewInProgress();
			},
			isInbox: false,
			project,
		});
		card.style.boxShadow = "none";
		card.style.borderRadius = "0";
		wrap.appendChild(card);
		overlay.appendChild(wrap);
		document.body.appendChild(overlay);
	}

	function renderList() {
		listScroll.innerHTML = "";
		inProgressTodos.forEach(({ todo, project }) => {
			const card = document.createElement("div");
			card.classList.add("inprogress-todo-chip");
			card.draggable = true;
			card.dataset.todoId = todo.id;

			if (project?.code && todo.number) {
				const badge = document.createElement("span");
				badge.classList.add("todo-number-badge");
				badge.textContent = `${project.code}-${todo.number}`;
				card.appendChild(badge);
			}
			const title = document.createElement("span");
			title.textContent = todo.title || "Untitled";
			card.appendChild(title);

			card.addEventListener("dragstart", (e) => {
				e.dataTransfer.setData("application/todo-id", todo.id);
				e.dataTransfer.effectAllowed = "copy";
			});

			card.addEventListener("click", (e) => {
				e.stopPropagation();
				openInProgressTodoModal(todo, project);
			});

			listScroll.appendChild(card);
		});
	}
	renderList();
	listPanel.appendChild(listScroll);
	splitView.appendChild(listPanel);

	function getDateStr(d) { return d.toISOString().slice(0, 10); }

	function buildDayColumn(dateStr, label) {
		const col = document.createElement("div");
		col.classList.add("timeline-day-col");

		const dayLabel = document.createElement("div");
		dayLabel.classList.add("timeline-day-label");
		dayLabel.textContent = label;
		col.appendChild(dayLabel);

		for (let h = 0; h < 24; h++) {
			const slot = document.createElement("div");
			slot.classList.add("timeline-slot");
			slot.dataset.date = dateStr;
			slot.dataset.hour = h;

			const slotLabel = document.createElement("span");
			slotLabel.classList.add("timeline-slot-label");
			slotLabel.textContent = `${String(h).padStart(2, "0")}:00`;
			slot.appendChild(slotLabel);

			// Show any scheduled todos in this slot
			inProgressTodos.forEach(({ todo, project }) => {
				const sched = todo.schedule?.[dateStr];
				if (sched && h >= sched.startHour && h < sched.endHour) {
					if (h === sched.startHour) {
						const block = document.createElement("div");
						block.classList.add("timeline-block");
						block.style.height = `${(sched.endHour - sched.startHour) * 52 - 2}px`;
						block.draggable = true;
						block.addEventListener("dragstart", (e) => {
							e.dataTransfer.setData("application/todo-move", JSON.stringify({ todoId: todo.id, fromDate: dateStr }));
							e.dataTransfer.effectAllowed = "move";
						});
						block.addEventListener("click", (e) => {
							if (e.target.closest(".timeline-block-remove, .timeline-block-resize")) return;
							e.stopPropagation();
							openInProgressTodoModal(todo, project);
						});
						if (project?.code) {
							const badge = document.createElement("span");
							badge.classList.add("todo-number-badge");
							badge.style.fontSize = "0.6rem";
							badge.style.alignSelf = "flex-start";
							badge.style.width = "fit-content";
							badge.textContent = `${project.code}-${todo.number || ""}`;
							block.appendChild(badge);
						}
						const blockTitle = document.createElement("span");
						blockTitle.textContent = todo.title || "Untitled";
						block.appendChild(blockTitle);

						const removeBtn = document.createElement("button");
						removeBtn.classList.add("timeline-block-remove");
						removeBtn.textContent = "×";
						removeBtn.addEventListener("click", (e) => {
							e.stopPropagation();
							delete todo.schedule[dateStr];
							saveProjects();
							rebuildTimeline();
						});
						block.appendChild(removeBtn);

						const resizeHandle = document.createElement("div");
						resizeHandle.classList.add("timeline-block-resize");
						resizeHandle.addEventListener("mousedown", (e) => {
							e.stopPropagation();
							e.preventDefault();
							const SLOT_H = 52;
							const startY = e.clientY;
							const startEnd = sched.endHour;
							function onMove(ev) {
								const delta = Math.round((ev.clientY - startY) / SLOT_H);
								sched.endHour = Math.max(sched.startHour + 1, Math.min(24, startEnd + delta));
								block.style.height = `${(sched.endHour - sched.startHour) * SLOT_H - 2}px`;
							}
							function onUp() {
								document.removeEventListener("mousemove", onMove);
								document.removeEventListener("mouseup", onUp);
								saveProjects();
								rebuildTimeline();
							}
							document.addEventListener("mousemove", onMove);
							document.addEventListener("mouseup", onUp);
						});
						block.appendChild(resizeHandle);

						slot.appendChild(block);
					} else {
						slot.classList.add("timeline-slot-occupied");
					}
				}
			});

			slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("timeline-slot-drag-over"); });
			slot.addEventListener("dragleave", () => slot.classList.remove("timeline-slot-drag-over"));
			slot.addEventListener("drop", (e) => {
				e.preventDefault();
				slot.classList.remove("timeline-slot-drag-over");
				const moveData = e.dataTransfer.getData("application/todo-move");
				if (moveData) {
					const { todoId, fromDate } = JSON.parse(moveData);
					const found = inProgressTodos.find(x => x.todo.id === todoId);
					if (!found) return;
					if (!found.todo.schedule) found.todo.schedule = {};
					const prevSched = found.todo.schedule[fromDate];
					const duration = prevSched ? (prevSched.endHour - prevSched.startHour) : 1;
					if (fromDate !== dateStr || prevSched?.startHour !== h) {
						delete found.todo.schedule[fromDate];
						found.todo.schedule[dateStr] = { startHour: h, endHour: Math.min(h + duration, 24) };
						saveProjects();
						rebuildTimeline();
					}
					return;
				}
				const todoId = e.dataTransfer.getData("application/todo-id");
				const found = inProgressTodos.find(x => x.todo.id === todoId);
				if (!found) return;
				if (!found.todo.schedule) found.todo.schedule = {};
				found.todo.schedule[dateStr] = { startHour: h, endHour: Math.min(h + 1, 24) };
				saveProjects();
				rebuildTimeline();
			});

			col.appendChild(slot);
		}
		return col;
	}

	function rebuildTimeline() {
		timelinePanel.innerHTML = "";
		if (viewMode === "day") {
			const label = viewDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
			timelinePanel.appendChild(buildDayColumn(getDateStr(viewDate), label));
		} else {
			// Week navigation header
			const weekNavRow = document.createElement("div");
			weekNavRow.classList.add("week-nav-row");

			const prevBtn = document.createElement("button");
			prevBtn.classList.add("week-nav-btn");
			prevBtn.innerHTML = "&#8249;";
			prevBtn.title = "Previous week";
			prevBtn.addEventListener("click", () => { viewDate.setDate(viewDate.getDate() - 7); rebuildTimeline(); });

			const nextBtn = document.createElement("button");
			nextBtn.classList.add("week-nav-btn");
			nextBtn.innerHTML = "&#8250;";
			nextBtn.title = "Next week";
			nextBtn.addEventListener("click", () => { viewDate.setDate(viewDate.getDate() + 7); rebuildTimeline(); });

			const weekSunday = new Date(viewDate);
			weekSunday.setDate(weekSunday.getDate() - weekSunday.getDay());
			const weekSaturday = new Date(weekSunday);
			weekSaturday.setDate(weekSaturday.getDate() + 6);
			const weekLabelEl = document.createElement("span");
			weekLabelEl.classList.add("week-nav-label");
			weekLabelEl.textContent = `${weekSunday.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${weekSaturday.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;

			weekNavRow.append(prevBtn, weekLabelEl, nextBtn);
			timelinePanel.appendChild(weekNavRow);

			const weekGrid = document.createElement("div");
			weekGrid.classList.add("timeline-week-grid");
			for (let i = 0; i < 7; i++) {
				const d = new Date(weekSunday);
				d.setDate(weekSunday.getDate() + i);
				const isToday = getDateStr(d) === todayStr;
				const label = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
				const col = buildDayColumn(getDateStr(d), label);
				if (isToday) col.classList.add("timeline-col--today");
				weekGrid.appendChild(col);
			}
			timelinePanel.appendChild(weekGrid);
		}
	}

	rebuildTimeline();
	todoContainer.appendChild(outer);
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
	delBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const savedNote = { ...note, tags: [...(note.tags || []) ] };
		const savedProject = project;

		if (project) {
			const idx = (project.notes || []).findIndex(n => n.id === note.id);
			if (idx !== -1) project.notes.splice(idx, 1);
			saveProjects();
		} else {
			const idx = userPrefs.generalNotes.findIndex(n => n.id === note.id);
			if (idx !== -1) userPrefs.generalNotes.splice(idx, 1);
			saveUserPrefs();
		}

		renderOverviewNotes();

		showUndoToast("Note deleted", () => {
			if (savedProject) {
				if (!savedProject.notes) savedProject.notes = [];
				savedProject.notes.push(savedNote);
				saveProjects();
			} else {
				userPrefs.generalNotes.push(savedNote);
				saveUserPrefs();
			}
			renderOverviewNotes();
		});
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

	todoContainer.innerHTML = "";
	todoContainer.classList.remove("swimlane-mode");
	todoContainer.classList.remove("overview-view");

	// Project icon in title wrap — always reset classes so setViewHeaderIcon changes don't linger
	const titleWrap = document.querySelector("#project-title-wrap");
	let titleIcon = titleWrap.querySelector(".project-title-icon");
	if (!titleIcon) {
		titleIcon = document.createElement("span");
		titleWrap.insertBefore(titleIcon, projectTitle);
	}
	titleIcon.className = "material-symbols-rounded project-title-icon";
	titleIcon.style.cursor = "pointer";
	titleIcon.textContent = project.icon || "folder";
	titleIcon.style.display = project.icon ? "" : "none";
	titleIcon.onclick = null;
	titleIcon.addEventListener("click", (e) => {
		e.stopPropagation();
		openIconPicker(project, titleIcon, () => { renderTodos(); });
	});

	projectTitle.textContent = project.title;

	// Apply project colour to header elements + --palette-dark for the rest of #main
	const mainEl = document.querySelector("#main");
	const fabBtn = document.querySelector("#fab-btn");
	if (project.color) {
		mainEl.style.setProperty("--palette-dark", project.color);
		projectTitle.style.color = project.color;
		titleIcon.style.color = project.color;
		fabBtn.style.background = project.color;
		fabBtn.style.boxShadow = `0 4px 16px ${project.color}59`;
	} else {
		mainEl.style.removeProperty("--palette-dark");
		projectTitle.style.color = "";
		titleIcon.style.color = "";
		fabBtn.style.background = "";
		fabBtn.style.boxShadow = "";
	}

	// Code badge — use onclick (single handler, no accumulation)
	if (!project.code) project.code = generateProjectCode(project.title);
	projectCodeBadge.textContent = project.code;
	projectCodeBadge.style.display = "";
	if (project.color) {
		projectCodeBadge.style.color = project.color;
		projectCodeBadge.style.background = project.color + "1a";
		projectCodeBadge.style.borderColor = project.color + "33";
	} else {
		projectCodeBadge.style.color = "";
		projectCodeBadge.style.background = "";
		projectCodeBadge.style.borderColor = "";
	}
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
	if (!project.lists) project.lists = [];

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

	if (activeTab?.type === "lists") {
		sortBarContainer.innerHTML = "";
		addTodoBtn.style.display = "none";
		renderListsTab(project);
		renderSelectionBar();
		return;
	}

	sortBarContainer.innerHTML = "";
	sortBarContainer.appendChild(buildSortBar(project.todos, renderTodos));

	const filterBarsContainer = document.createElement("div");
	filterBarsContainer.classList.add("filter-bars-container");

	if (project.epics.length > 0) {
		const filterBar = buildEpicFilterBar(project);
		if (filterBar) filterBarsContainer.appendChild(filterBar);
	}

	// Stack tool filter (shown when project has a Stack tab)
	if (project.tabs?.some(t => t.type === "stack") && project.tools?.length) {
		const stackFilterBar = buildStackFilterBar(project);
		if (stackFilterBar) filterBarsContainer.appendChild(stackFilterBar);
	}

	// Tag filter bar
	const allTodoTags = [...new Set(project.todos.flatMap(t => t.tags || []).filter(Boolean))];
	if (allTodoTags.length > 0) {
		filterBarsContainer.appendChild(buildTodoTagFilterBar(allTodoTags));
	}

	if (filterBarsContainer.children.length > 0) {
		sortBarContainer.appendChild(filterBarsContainer);
		const filterToggle = document.createElement("button");
		filterToggle.classList.add("filter-toggle-btn");
		filterToggle.textContent = "Filters";
		filterToggle.addEventListener("click", () => {
			const open = filterBarsContainer.classList.toggle("filter-bars-open");
			filterToggle.classList.toggle("active", open);
			filterToggle.textContent = open ? "Filters ✕" : "Filters";
		});
		const sortBarEl = sortBarContainer.querySelector(".sort-bar");
		const searchInput = sortBarEl.querySelector(".sort-search-input");
		if (searchInput) sortBarEl.insertBefore(filterToggle, searchInput);
		else sortBarEl.appendChild(filterToggle);
	}

	if (project.epics.length === 0) {
		const epicBtn = document.createElement("button");
		epicBtn.classList.add("sort-btn", "add-epic-sort-btn");
		epicBtn.textContent = "+ Add Epic";
		epicBtn.addEventListener("click", () => {
			const newEpic = { id: self.crypto.randomUUID(), title: "New Epic", collapsed: false, extraColumns: [] };
			project.epics.push(newEpic);
			saveProjects();
			renderTodos();
		});
		const sortBarEl = sortBarContainer.querySelector(".sort-bar");
		if (sortBarEl) {
			const searchInput = sortBarEl.querySelector(".sort-search-input");
			if (searchInput) sortBarEl.insertBefore(epicBtn, searchInput);
			else sortBarEl.appendChild(epicBtn);
		}
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
	if (currentView === "overview" && overviewTab !== "assistant") overviewItem.classList.add("active");

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
		if (overviewTab === "assistant") overviewTab = "dashboard";
		selectedTodos.clear();
		sidebar.classList.remove("open");
		sidebarBackdrop.classList.remove("visible");
		pushViewUrl();
		renderProjects();
		renderOverview();
	});

	scrollEl.appendChild(overviewItem);

	// Assistant sub-item (under Overview)
	const assistantSidebarItem = document.createElement("div");
	assistantSidebarItem.classList.add("assistant-sidebar-item");
	if (currentView === "overview" && overviewTab === "assistant") assistantSidebarItem.classList.add("active");
	assistantSidebarItem.textContent = "✦ Assistant";
	assistantSidebarItem.addEventListener("click", () => {
		currentView = "overview";
		overviewTab = "assistant";
		currentProjectTab = "board";
		selectedTodos.clear();
		sidebar.classList.remove("open");
		sidebarBackdrop.classList.remove("visible");
		pushViewUrl();
		renderProjects();
		renderOverview();
	});
	scrollEl.appendChild(assistantSidebarItem);

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
		pushViewUrl();
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

	// Shuffle sidebar item
	const shuffleItem = document.createElement("div");
	shuffleItem.classList.add("shuffle-sidebar-item");
	if (currentView === "shuffle") shuffleItem.classList.add("active");
	shuffleItem.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem">shuffle</span> Shuffle';
	shuffleItem.addEventListener("click", () => {
		currentView = "shuffle";
		currentProjectTab = "board";
		selectedTodos.clear();
		sidebar.classList.remove("open");
		sidebarBackdrop.classList.remove("visible");
		pushViewUrl();
		renderProjects();
		renderShuffle();
	});
	scrollEl.appendChild(shuffleItem);

	const emailItem = document.createElement("div");
	emailItem.classList.add("email-sidebar-item");
	if (currentView === "email") emailItem.classList.add("active");
	emailItem.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem">mail</span> Email';
	emailItem.addEventListener("click", () => {
		currentView = "email";
		currentProjectTab = "board";
		selectedTodos.clear();
		sidebar.classList.remove("open");
		sidebarBackdrop.classList.remove("visible");
		pushViewUrl();
		renderProjects();
		renderEmailTab();
	});
	scrollEl.appendChild(emailItem);

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

		// Apply project color: active → colored background, inactive → colored icon
		const isActiveProject = project.id === currentProjectId && currentView === "project";
		if (project.color) {
			item.style.setProperty("--project-color", project.color);
			item.style.setProperty("--project-contrast", getContrastColor(project.color));
			item.dataset.hasColor = "true";
		}

		// Right-click on item → color picker
		item.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			openColorPicker(project, item, () => { renderProjects(); renderTodos(); });
		});

		// Project icon in sidebar (wrapper clips overflow if name has no ligature)
		const iconWrap = document.createElement("span");
		iconWrap.classList.add("project-sidebar-icon-wrap");
		const iconEl = document.createElement("span");
		iconEl.classList.add("material-symbols-rounded", "project-sidebar-icon");
		iconEl.textContent = project.icon || "folder";
		iconEl.title = "Click to change icon · Right-click to change colour";
		iconEl.addEventListener("click", (e) => {
			e.stopPropagation();
			openIconPicker(project, iconEl, () => {
				renderProjects();
				// Reflect icon change in project title header immediately
				if (project.id === currentProjectId && currentView === "project") {
					const titleIcon = document.querySelector(".project-title-icon");
					if (titleIcon) {
						titleIcon.textContent = project.icon || "folder";
						titleIcon.style.display = project.icon ? "" : "none";
					}
				}
			});
		});
		iconWrap.appendChild(iconEl);
		item.appendChild(iconWrap);

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
			pushViewUrl();
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
	} else if (guestMode) {
		bottomEl.appendChild(buildGuestRow());
	}
}

/* ======================
   GUEST ROW
====================== */

function buildGuestRow() {
	const wrap = document.createElement("div");

	const banner = document.createElement("div");
	banner.classList.add("guest-banner");

	const cloudIcon = document.createElement("span");
	cloudIcon.classList.add("material-symbols-rounded");
	cloudIcon.style.fontSize = "0.95rem";
	cloudIcon.style.color = "var(--palette-dark)";
	cloudIcon.textContent = "cloud_off";

	const bannerText = document.createElement("span");
	bannerText.textContent = "Guest — data stays on this device";

	banner.appendChild(cloudIcon);
	banner.appendChild(bannerText);

	const row = document.createElement("div");
	row.classList.add("guest-user-row");
	row.title = "Click to set display name";

	const avatar = document.createElement("div");
	avatar.classList.add("guest-user-avatar");
	avatar.style.background = userPrefs.avatarColor || "#6366f1";
	const displayName = userPrefs.displayName || "Guest";
	avatar.textContent = displayName.charAt(0).toUpperCase();

	const nameEl = document.createElement("span");
	nameEl.classList.add("guest-user-name");
	nameEl.textContent = displayName;

	const loginBtn = document.createElement("button");
	loginBtn.classList.add("guest-login-btn");
	loginBtn.textContent = "Log in";
	loginBtn.title = "Log in to sync across devices";
	loginBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		localStorage.removeItem("todoroki_guest");
		window.location.reload();
	});

	row.addEventListener("click", () => {
		const newName = prompt("Your display name:", userPrefs.displayName || "Guest");
		if (newName !== null) {
			userPrefs.displayName = newName.trim() || "Guest";
			saveUserPrefs();
			renderProjects();
		}
	});

	row.appendChild(avatar);
	row.appendChild(nameEl);
	row.appendChild(loginBtn);
	wrap.appendChild(banner);
	wrap.appendChild(row);
	return wrap;
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
	avatar.style.background = getAvatarColor();
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

	// ── Accounts switcher ──
	const accountsSection = document.createElement("div");
	accountsSection.classList.add("user-settings-section");

	const accountsLabel = document.createElement("div");
	accountsLabel.classList.add("user-settings-accounts-label");
	accountsLabel.textContent = "Accounts";
	accountsSection.appendChild(accountsLabel);

	function buildAccountsList() {
		accountsSection.querySelectorAll(".account-row, .account-add-btn").forEach(el => el.remove());

		const accs = getStoredAccounts();
		const activeId = currentUser?.id;

		Object.entries(accs).forEach(([uid, acc]) => {
			const row = document.createElement("div");
			row.classList.add("account-row");
			if (uid === activeId) row.classList.add("account-row--active");

			const av = document.createElement("div");
			av.classList.add("account-row-avatar");
			av.style.background = (uid === activeId ? getAvatarColor() : acc.avatarColor) || "#6366f1";
			av.textContent = (acc.name || acc.email || "?").charAt(0).toUpperCase();

			const info = document.createElement("div");
			info.classList.add("account-row-info");
			const nameDiv = document.createElement("div");
			nameDiv.classList.add("account-row-name");
			nameDiv.textContent = acc.name || acc.email;
			const emailDiv = document.createElement("div");
			emailDiv.classList.add("account-row-email");
			emailDiv.textContent = acc.email;
			info.appendChild(nameDiv);
			info.appendChild(emailDiv);

			const actions = document.createElement("div");
			actions.classList.add("account-row-actions");

			if (uid === activeId) {
				const check = document.createElement("span");
				check.classList.add("account-active-check");
				check.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem;color:var(--md-primary)">check_circle</span>';
				actions.appendChild(check);
			} else {
				const switchBtn = document.createElement("button");
				switchBtn.classList.add("account-switch-btn");
				switchBtn.textContent = "Switch";
				switchBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					switchBtn.textContent = "…";
					switchBtn.disabled = true;
					switchAccount(uid);
				});
				actions.appendChild(switchBtn);
			}

			const removeBtn = document.createElement("button");
			removeBtn.classList.add("account-remove-btn");
			removeBtn.title = uid === activeId ? "Sign out of this account" : "Remove account";
			removeBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:0.9rem">close</span>';
			removeBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const remaining = Object.keys(getStoredAccounts()).filter(id => id !== uid);
				if (uid === activeId) {
					if (remaining.length > 0) {
						removeStoredAccount(uid);
						await switchAccount(remaining[0]);
					} else {
						signOutAllAccounts();
					}
				} else {
					removeStoredAccount(uid);
					buildAccountsList();
				}
			});
			actions.appendChild(removeBtn);

			row.appendChild(av);
			row.appendChild(info);
			row.appendChild(actions);
			accountsSection.appendChild(row);
		});

		// Add account button
		const addBtn = document.createElement("button");
		addBtn.classList.add("account-add-btn");
		addBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:1rem">add</span> Add account';
		addBtn.addEventListener("click", () => addAccount());
		accountsSection.appendChild(addBtn);
	}

	buildAccountsList();
	popup.appendChild(accountsSection);

	// ── Divider ──
	const divAccounts = document.createElement("div");
	divAccounts.classList.add("user-settings-divider");
	popup.appendChild(divAccounts);

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
	colorLabel.textContent = "Profile icon colour";
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

	// ── AI / API Key (collapsed by default) ──
	const apiSection = document.createElement("div");
	apiSection.classList.add("user-settings-section");

	const apiHeaderRow = document.createElement("div");
	apiHeaderRow.classList.add("user-settings-api-header");

	const apiLabel = document.createElement("span");
	apiLabel.classList.add("user-settings-label");
	apiLabel.style.margin = "0";
	apiLabel.textContent = "Anthropic API Key";

	const apiStatusBadge = document.createElement("span");
	apiStatusBadge.classList.add("user-settings-api-badge");
	apiStatusBadge.textContent = userPrefs.anthropicApiKey ? "✓ Set" : "Not set";
	apiStatusBadge.classList.toggle("user-settings-api-badge--set", !!userPrefs.anthropicApiKey);

	const apiEditBtn = document.createElement("button");
	apiEditBtn.classList.add("user-settings-api-edit-btn");
	apiEditBtn.textContent = "Edit";

	apiHeaderRow.append(apiLabel, apiStatusBadge, apiEditBtn);
	apiSection.appendChild(apiHeaderRow);

	const apiExpandArea = document.createElement("div");
	apiExpandArea.classList.add("user-settings-api-expand");
	apiExpandArea.style.display = "none";

	const apiDesc = document.createElement("p");
	apiDesc.classList.add("user-settings-api-desc");
	apiDesc.textContent = "Powers AI features. Stored securely in your account, never shared.";

	const apiRow = document.createElement("div");
	apiRow.classList.add("user-settings-api-row");

	const apiInput = document.createElement("input");
	apiInput.type = "password";
	apiInput.classList.add("user-settings-input");
	apiInput.placeholder = "sk-ant-…";
	apiInput.value = userPrefs.anthropicApiKey || "";
	apiInput.autocomplete = "off";

	const apiSaveBtn = document.createElement("button");
	apiSaveBtn.classList.add("user-settings-api-save");
	apiSaveBtn.textContent = "Save";

	const apiStatus = document.createElement("span");
	apiStatus.classList.add("user-settings-api-status");

	apiSaveBtn.addEventListener("click", async () => {
		const key = apiInput.value.trim();
		userPrefs.anthropicApiKey = key || null;
		await saveUserPrefs();
		apiStatus.textContent = key ? "✓ Saved" : "Removed";
		apiStatusBadge.textContent = key ? "✓ Set" : "Not set";
		apiStatusBadge.classList.toggle("user-settings-api-badge--set", !!key);
		setTimeout(() => { apiStatus.textContent = ""; }, 2000);
	});
	apiInput.addEventListener("keydown", (e) => { if (e.key === "Enter") apiSaveBtn.click(); });

	apiEditBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const open = apiExpandArea.style.display !== "none";
		apiExpandArea.style.display = open ? "none" : "";
		apiEditBtn.textContent = open ? "Edit" : "Done";
		if (!open) requestAnimationFrame(() => apiInput.focus());
	});

	apiRow.append(apiInput, apiSaveBtn);
	apiExpandArea.append(apiDesc, apiRow, apiStatus);
	apiSection.appendChild(apiExpandArea);
	popup.appendChild(apiSection);

	// ── Divider ──
	const div3 = document.createElement("div");
	div3.classList.add("user-settings-divider");
	popup.appendChild(div3);

	// ── Sign out ──
	const signOutBtn = document.createElement("button");
	signOutBtn.classList.add("user-settings-signout");
	signOutBtn.textContent = "Sign out of all accounts";
	signOutBtn.addEventListener("click", () => signOutAllAccounts());
	popup.appendChild(signOutBtn);

	document.body.appendChild(popup);

	// Position above anchor
	const rect = anchorEl.getBoundingClientRect();
	popup.style.left = `${rect.left}px`;
	popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
	// Clamp to viewport width
	const popupWidth = 280;
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

document.querySelector("#fab-btn").addEventListener("click", () => showContextAddForm());

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
