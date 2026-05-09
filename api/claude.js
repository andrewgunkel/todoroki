import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default async function handler(req, res) {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
        return res.status(204).end();
    }

    // Set CORS headers on all responses
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method !== "POST") {
        return res.status(405).json({ error: "method_not_allowed", message: "Only POST requests are accepted" });
    }

    // Extract JWT from Authorization header
    const authHeader = req.headers["authorization"] || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!jwt) {
        return res.status(401).json({ error: "unauthorized", message: "Missing Authorization header" });
    }

    // Create Supabase client with service role key to verify user
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Verify the user via JWT
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) {
        return res.status(401).json({ error: "unauthorized", message: "Invalid or expired token" });
    }

    // Fetch the user's Anthropic API key from user_preferences
    const { data: prefs, error: prefsError } = await supabase
        .from("user_preferences")
        .select("anthropic_api_key")
        .eq("user_id", user.id)
        .maybeSingle();

    if (prefsError) {
        return res.status(500).json({ error: "db_error", message: "Failed to retrieve preferences" });
    }

    const anthropicApiKey = prefs?.anthropic_api_key;
    if (!anthropicApiKey) {
        return res.status(403).json({ error: "no_api_key", message: "No Anthropic API key configured" });
    }

    // Extract request body params
    const {
        messages,
        model = "claude-haiku-4-5-20251001",
        system,
        max_tokens = 1024,
    } = req.body || {};

    // Call Anthropic API
    const body = { model, messages, max_tokens };
    if (system) body.system = system;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicApiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
    });

    const anthropicData = await anthropicRes.json();

    return res.status(anthropicRes.status).json(anthropicData);
}
