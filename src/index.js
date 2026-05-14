import "./styles.css";
import { supabase, signInWithGoogle } from "./auth.js";

const layout = document.getElementById("layout");
const fab = document.getElementById("fab-btn");

// Hide app shell until authenticated
layout.style.display = "none";
fab.style.display = "none";

/* ========================
   AUTH SCREEN
======================== */

function buildAuthScreen() {
	const screen = document.createElement("div");
	screen.id = "auth-screen";

	const card = document.createElement("div");
	card.id = "auth-card";

	// Logo
	const icon = document.createElement("div");
	icon.id = "auth-icon";
	icon.textContent = "✓";

	// App name
	const title = document.createElement("h1");
	title.id = "auth-title";
	title.textContent = "Todoroki";

	// Tagline
	const subtitle = document.createElement("p");
	subtitle.id = "auth-subtitle";
	subtitle.textContent = "Sign in to access your projects and todos.";

	// Google sign-in button
	const googleBtn = document.createElement("button");
	googleBtn.id = "auth-google-btn";
	googleBtn.innerHTML = `
		<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
			<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
			<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
			<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
			<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
		</svg>
		Sign in with Google
	`;
	googleBtn.addEventListener("click", () => {
		googleBtn.disabled = true;
		googleBtn.textContent = "Redirecting…";
		signInWithGoogle();
	});

	// Guest / local-only mode
	const divider = document.createElement("div");
	divider.id = "auth-divider";
	divider.textContent = "or";

	const guestBtn = document.createElement("button");
	guestBtn.id = "auth-guest-btn";
	guestBtn.textContent = "Continue as Guest";
	guestBtn.addEventListener("click", () => {
		localStorage.setItem("todoroki_guest", "true");
		showApp();
	});

	card.appendChild(icon);
	card.appendChild(title);
	card.appendChild(subtitle);
	card.appendChild(googleBtn);
	card.appendChild(divider);
	card.appendChild(guestBtn);
	screen.appendChild(card);
	return screen;
}

let authScreen = null;

function showAuthScreen() {
	if (authScreen) return;
	authScreen = buildAuthScreen();
	document.body.appendChild(authScreen);
	layout.style.display = "none";
	fab.style.display = "none";
}

let appInitialized = false;

async function showApp() {
	if (authScreen) {
		authScreen.remove();
		authScreen = null;
	}
	layout.style.display = "";
	fab.style.display = "";
	if (!appInitialized) {
		appInitialized = true;
		await import("./app.js");
	}
}

/* ========================
   BOOT
======================== */

async function boot() {
	const { data: { session } } = await supabase.auth.getSession();

	if (session) {
		await showApp();
	} else {
		showAuthScreen();
	}

	supabase.auth.onAuthStateChange((event, session) => {
		if (event === "SIGNED_IN" && session) {
			showApp();
		} else if (event === "SIGNED_OUT") {
			window.location.reload();
		}
	});
}

boot();
