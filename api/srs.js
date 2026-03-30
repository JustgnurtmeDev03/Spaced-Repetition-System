/**
 * /api/srs.js — Vercel serverless function
 * Proxy cho Notion API để tránh CORS khi embed widget vào Notion
 *
 * Endpoints:
 *   GET  /api/srs?action=due               → lấy thẻ đến hạn hôm nay
 *   GET  /api/srs?action=stats             → thống kê tổng quan
 *   POST /api/srs  { action: "review", ... } → cập nhật sau review
 *   POST /api/srs  { action: "log", ... }    → ghi Review Log
 */

export default async function handler(req, res) {
  // CORS headers — cho phép Notion embed gọi được
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token   = process.env.NOTION_TOKEN;
  const cardDb  = (process.env.SRS_CARD_DB  || "").replace(/-/g, "");
  const logDb   = (process.env.SRS_LOG_DB   || "").replace(/-/g, "");

  if (!token || !cardDb) {
    return res.status(500).json({
      error: "Missing NOTION_TOKEN or SRS_CARD_DB in environment variables",
    });
  }

  // Property name config (env vars with fallback)
  const PROP = {
    front:    process.env.SRS_PROP_FRONT    || "Front",
    back:     process.env.SRS_PROP_BACK     || "Back",
    deck:     process.env.SRS_PROP_DECK     || "Deck",
    tags:     process.env.SRS_PROP_TAGS     || "Tags",
    next:     process.env.SRS_PROP_NEXT     || "Next Review",
    ef:       process.env.SRS_PROP_EF       || "EF",
    interval: process.env.SRS_PROP_INTERVAL || "Interval",
    reps:     process.env.SRS_PROP_REPS     || "Repetitions",
    status:   process.env.SRS_PROP_STATUS   || "Status",
  };

  try {
    // ── GET: fetch due cards ──────────────────────────────
    if (req.method === "GET") {
      const action = req.query.action || "due";
      const deck   = req.query.deck;

      if (action === "due") {
        const today = new Date().toLocaleDateString("en-CA");

        // Build filter: Next Review <= today OR empty (new cards)
        let filter = {
          or: [
            { property: PROP.next, date: { on_or_before: today } },
            { property: PROP.next, date: { is_empty: true } },
          ],
        };

        // Optional deck filter
        if (deck && deck !== "all") {
          filter = {
            and: [
              filter,
              { property: PROP.deck, select: { equals: deck } },
            ],
          };
        }

        const data = await notionQuery(token, cardDb, filter, [
          { property: PROP.next, direction: "ascending" },
        ]);

        const cards = (data.results || []).map((page) =>
          parseCard(page, PROP)
        ).filter((c) => c.front);

        return res.status(200).json({ cards, count: cards.length });
      }

      if (action === "stats") {
        // Query all cards for stats
        const data = await notionQuery(token, cardDb, null, null);
        const all  = data.results || [];
        const today = new Date().toLocaleDateString("en-CA");

        const stats = {
          total:    all.length,
          due:      all.filter((p) => {
            const d = p.properties[PROP.next]?.date?.start;
            return !d || d <= today;
          }).length,
          new:      all.filter((p) =>
            getStatus(p.properties[PROP.status]) === "New"
          ).length,
          mastered: all.filter((p) =>
            getStatus(p.properties[PROP.status]) === "Mastered"
          ).length,
        };

        return res.status(200).json(stats);
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    // ── POST ──────────────────────────────────────────────
    if (req.method === "POST") {
      const body = req.body || {};

      // action=review: update SM-2 fields on a card
      if (body.action === "review") {
        const { pageId, newEf, newInterval, newReps, nextDate, newStatus } = body;
        if (!pageId) return res.status(400).json({ error: "Missing pageId" });

        const properties = {
          [PROP.ef]:       { number: parseFloat(newEf) },
          [PROP.interval]: { number: newInterval },
          [PROP.reps]:     { number: newReps },
          [PROP.next]:     { date:   { start: nextDate } },
          [PROP.status]:   { status: { name: newStatus } },
        };

        await notionPatch(token, pageId, properties);
        return res.status(200).json({ ok: true });
      }

      // action=log: create a Review Log entry
      if (body.action === "log") {
        if (!logDb) return res.status(400).json({ error: "SRS_LOG_DB not configured" });
        const { cardId, date, rating, newInterval, newEf } = body;

        // Log DB property names (env vars with fallback to common names)
        const logDate     = process.env.SRS_LOG_PROP_DATE      || "Date";
        const logRating   = process.env.SRS_LOG_PROP_RATING    || "Rating";
        const logInterval = process.env.SRS_LOG_PROP_INTERVAL  || "New Interval";
        const logEf       = process.env.SRS_LOG_PROP_EF        || "New EF";
        const logCard     = process.env.SRS_LOG_PROP_CARD      || "Card";

        const todayStr = date || new Date().toISOString().substring(0, 10);

        const properties = {
          "Name":        { title:    [{ text: { content: `LOG-${todayStr}` } }] },
          [logCard]:     { relation: [{ id: cardId }] },
          [logDate]:     { date:     { start: todayStr } },
          [logRating]:   { select:   { name: String(rating) } },
          [logInterval]: { number:   newInterval },
          [logEf]:       { number:   parseFloat(parseFloat(newEf).toFixed(3)) },
        };

        await notionCreate(token, logDb, properties);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function notionQuery(token, dbId, filter, sorts) {
  let allResults = [];
  let startCursor = undefined;

  do {
    const body = { page_size: 100 };
    if (filter)      body.filter       = filter;
    if (sorts)       body.sorts        = sorts;
    if (startCursor) body.start_cursor = startCursor;

    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Notion query ${res.status}: ${await res.text()}`);
    const data = await res.json();
    allResults = allResults.concat(data.results || []);
    startCursor = data.has_more ? data.next_cursor : undefined;
  } while (startCursor);

  return { results: allResults };
}

async function notionPatch(token, pageId, properties) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`Notion patch ${res.status}`);
  return res.json();
}

async function notionCreate(token, dbId, properties) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ parent: { database_id: dbId }, properties }),
  });
  if (!res.ok) throw new Error(`Notion create ${res.status}`);
  return res.json();
}

function parseCard(page, PROP) {
  const pr = page.properties || {};
  return {
    id:       page.id,
    front:    getText(pr[PROP.front]),
    back:     getText(pr[PROP.back]),
    deck:     pr[PROP.deck]?.select?.name || "General",
    tags:     pr[PROP.tags]?.multi_select?.map((s) => s.name) || [],
    ef:       pr[PROP.ef]?.number ?? 2.5,
    interval: pr[PROP.interval]?.number ?? 1,
    reps:     pr[PROP.reps]?.number ?? 0,
    status:   getStatus(pr[PROP.status]),
    next:     pr[PROP.next]?.date?.start ?? null,
  };
}

function getText(prop) {
  if (!prop) return "";
  if (prop.title)     return prop.title.map((t) => t.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join("");
  return "";
}
function getStatus(prop) {
  return prop?.status?.name || prop?.select?.name || "";
}
