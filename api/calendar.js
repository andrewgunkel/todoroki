import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
    // Token is the last path segment: /api/calendar/TOKEN.ics
    const url = req.url || "";
    const match = url.match(/\/([^/]+)\.ics(?:\?|$)/);
    const token = match?.[1];

    if (!token) {
        return res.status(400).send("Missing token");
    }

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Resolve token → user_id
    const { data: pref, error: prefErr } = await supabase
        .from("user_preferences")
        .select("user_id")
        .eq("ical_token", token)
        .maybeSingle();

    if (prefErr || !pref) {
        return res.status(404).send("Token not found");
    }

    const userId = pref.user_id;

    // Load all todos with schedule data for this user
    const { data: todoRows, error: todoErr } = await supabase
        .from("todos")
        .select("id, title, description, priority, status, schedule, project_id")
        .eq("user_id", userId);

    if (todoErr) {
        return res.status(500).send("Failed to load todos");
    }

    // Load projects for names
    const { data: projectRows } = await supabase
        .from("projects")
        .select("id, title, color, columns")
        .eq("user_id", userId);

    const projectMap = {};
    (projectRows || []).forEach(p => { projectMap[p.id] = p; });

    function escICS(str) {
        return (str || "").replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
    }

    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Todoroki//TodoList//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Todoroki Schedule",
        "X-WR-CALDESC:Your Todoroki in-progress schedule",
    ];

    (todoRows || []).forEach(todo => {
        if (!todo.schedule || typeof todo.schedule !== "object") return;
        const proj = projectMap[todo.project_id];

        Object.entries(todo.schedule).forEach(([dateStr, sched]) => {
            if (!sched || sched.startHour === undefined || sched.endHour === undefined) return;

            const [y, m, d] = dateStr.split("-");
            const sh = String(sched.startHour).padStart(2, "0");
            const eh = String(sched.endHour).padStart(2, "0");
            const dtstart = `${y}${m}${d}T${sh}0000`;
            const dtend   = `${y}${m}${d}T${eh}0000`;
            const uid     = `${todo.id}-${dateStr}@todoroki`;
            const now     = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

            const descParts = [];
            if (todo.description) descParts.push(todo.description);
            if (proj) descParts.push(`Project: ${proj.title}`);
            descParts.push(`Priority: ${todo.priority || "Low"}`);

            lines.push("BEGIN:VEVENT");
            lines.push(`DTSTART:${dtstart}`);
            lines.push(`DTEND:${dtend}`);
            lines.push(`DTSTAMP:${now}`);
            lines.push(`UID:${uid}`);
            lines.push(`SUMMARY:${escICS(todo.title || "Untitled")}`);
            if (descParts.length) lines.push(`DESCRIPTION:${escICS(descParts.join("\\n"))}`);
            if (proj) lines.push(`CATEGORIES:${escICS(proj.title)}`);
            lines.push("END:VEVENT");
        });
    });

    lines.push("END:VCALENDAR");

    const ics = lines.join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="todoroki.ics"`);
    res.setHeader("Cache-Control", "no-cache, no-store");
    res.status(200).send(ics);
}
