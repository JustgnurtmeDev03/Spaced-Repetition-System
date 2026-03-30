/**
 * /api/srs.js — Vercel serverless proxy cho Notion SRS
 *
 * GET  /api/srs?action=due               → thẻ đến hạn hôm nay
 * GET  /api/srs?action=stats             → tổng quan số liệu
 * GET  /api/srs?action=logs&limit=50     → lịch sử review (MỚI)
 * POST /api/srs { action:"review" }      → cập nhật SM-2 sau review
 * POST /api/srs { action:"log" }         → ghi vào Review Log DB
 * POST /api/srs { action:"create" }      → tạo 1 thẻ mới (MỚI)
 * POST /api/srs { action:"import" }      → import hàng loạt từ CSV (MỚI)
 */

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const SRS_CARD_DB = process.env.SRS_CARD_DB;
    const SRS_LOG_DB = process.env.SRS_LOG_DB;

    if (!NOTION_TOKEN || !SRS_CARD_DB || !SRS_LOG_DB) {
      return res.status(500).json({ error: "Missing env variables" });
    }

    const headers = {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };

    const action = req.method === "GET" ? req.query.action : req.body.action;

    // ========================
    // GET DUE CARDS
    // ========================
    if (action === "due") {
      const r = await fetch(
        `https://api.notion.com/v1/databases/${SRS_CARD_DB}/query`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        }
      );

      const data = await r.json();

      const cards = data.results.map((p) => ({
        id: p.id,
        front: p.properties.Front?.rich_text?.[0]?.plain_text || "",
        back: p.properties.Back?.rich_text?.[0]?.plain_text || "",
        deck: p.properties.Deck?.select?.name || "",
      }));

      return res.json({ cards });
    }

    // ========================
    // CREATE CARD
    // ========================
    if (action === "create") {
      const { front, back, deck } = req.body;

      const r = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent: { database_id: SRS_CARD_DB },
          properties: {
            Front: { rich_text: [{ text: { content: front } }] },
            Back: { rich_text: [{ text: { content: back } }] },
            Deck: deck ? { select: { name: deck } } : null,
          },
        }),
      });

      const data = await r.json();

      if (data.object === "error") {
        return res.status(500).json(data);
      }

      return res.json({ ok: true });
    }

    // ========================
    // RATE CARD + LOG
    // ========================
    if (action === "rate") {
      const { cardId, rating } = req.body;

      // UPDATE CARD (simple version)
      await fetch(`https://api.notion.com/v1/pages/${cardId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {},
        }),
      });

      // CREATE LOG (IMPORTANT FIX HERE)
      const logRes = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          parent: { database_id: SRS_LOG_DB },
          properties: {
            ID: {
              title: [
                {
                  text: { content: `Review ${new Date().toISOString()}` },
                },
              ],
            },
            Card: {
              relation: [{ id: cardId }],
            },
            Date: {
              date: { start: new Date().toISOString() },
            },
            Rating: {
              number: rating,
            },
            Result: {
              rich_text: [
                {
                  text: { content: rating >= 3 ? "Good" : "Again" },
                },
              ],
            },
            Deck: {
              rich_text: [
                {
                  text: { content: "Default" },
                },
              ],
            },
          },
        }),
      });

      const logData = await logRes.json();

      if (logData.object === "error") {
        return res.status(500).json(logData);
      }

      return res.json({ ok: true });
    }

    // ========================
    // GET LOGS
    // ========================
    if (action === "logs") {
      const r = await fetch(
        `https://api.notion.com/v1/databases/${SRS_LOG_DB}/query`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            sorts: [
              {
                property: "Date",
                direction: "descending",
              },
            ],
          }),
        }
      );

      const data = await r.json();

      const logs = data.results.map((p) => ({
        id: p.id,
        rating: p.properties.Rating?.number,
        date: p.properties.Date?.date?.start,
        result: p.properties.Result?.rich_text?.[0]?.plain_text,
      }));

      return res.json({ logs });
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function notionQuery(token, dbId, filter, sorts) {
  let allResults = [];
  let startCursor;

  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (startCursor) body.start_cursor = startCursor;

    const res = await fetch(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion query ${res.status}: ${text.substring(0, 200)}`);
    }

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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion PATCH ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

function getHeader(req, name) {
  const raw = req.headers?.[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function getRuntimeConfig(req) {
  const header = (name, fallback = "") => {
    const v = getHeader(req, name);
    return typeof v === "string" && v.trim() ? v.trim() : fallback;
  };

  const token = header("x-srs-token", process.env.NOTION_TOKEN || "");
  const cardDb = header("x-srs-card-db", process.env.SRS_CARD_DB || "").replace(
    /-/g,
    ""
  );
  const logDb = header("x-srs-log-db", process.env.SRS_LOG_DB || "").replace(
    /-/g,
    ""
  );

  const PROP = {
    title: header("x-srs-prop-front", process.env.SRS_PROP_FRONT || "Front"),
    front: header("x-srs-prop-front", process.env.SRS_PROP_FRONT || "Front"),
    back: header("x-srs-prop-back", process.env.SRS_PROP_BACK || "Back"),
    deck: header("x-srs-prop-deck", process.env.SRS_PROP_DECK || "Deck"),
    tags: header("x-srs-prop-tags", process.env.SRS_PROP_TAGS || "Tags"),
    next: header("x-srs-prop-next", process.env.SRS_PROP_NEXT || "Next Review"),
    ef: header("x-srs-prop-ef", process.env.SRS_PROP_EF || "EF"),
    interval: header(
      "x-srs-prop-interval",
      process.env.SRS_PROP_INTERVAL || "Interval"
    ),
    reps: header("x-srs-prop-reps", process.env.SRS_PROP_REPS || "Repetitions"),
    status: header(
      "x-srs-prop-status",
      process.env.SRS_PROP_STATUS || "Status"
    ),
  };

  const LOG = {
    title: header(
      "x-srs-log-prop-title",
      process.env.SRS_LOG_PROP_TITLE || "Name"
    ),
    card: header(
      "x-srs-log-prop-card",
      process.env.SRS_LOG_PROP_CARD || "Card"
    ),
    date: header(
      "x-srs-log-prop-date",
      process.env.SRS_LOG_PROP_DATE || "Date"
    ),
    rating: header(
      "x-srs-log-prop-rating",
      process.env.SRS_LOG_PROP_RATING || "Rating"
    ),
    interval: header(
      "x-srs-log-prop-interval",
      process.env.SRS_LOG_PROP_INTERVAL || "New Interval"
    ),
    ef: header("x-srs-log-prop-ef", process.env.SRS_LOG_PROP_EF || "New EF"),
    deck: header(
      "x-srs-log-prop-deck",
      process.env.SRS_LOG_PROP_DECK || "Deck"
    ),
    result: header(
      "x-srs-log-prop-result",
      process.env.SRS_LOG_PROP_RESULT || "Result"
    ),
  };

  return { token, cardDb, logDb, PROP, LOG };
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion CREATE ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

function parseCard(page, PROP) {
  const pr = page.properties || {};
  return {
    id: page.id,
    front: getText(pr[PROP.front]),
    back: getText(pr[PROP.back]),
    deck: pr[PROP.deck]?.select?.name || "General",
    tags: pr[PROP.tags]?.multi_select?.map((s) => s.name) || [],
    ef: pr[PROP.ef]?.number ?? 2.5,
    interval: pr[PROP.interval]?.number ?? 1,
    reps: pr[PROP.reps]?.number ?? 0,
    status: getStatus(pr[PROP.status]),
    next: pr[PROP.next]?.date?.start ?? null,
  };
}

function getText(prop) {
  if (!prop) return "";
  if (prop.title) return prop.title.map((t) => t.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join("");
  return "";
}

function getStatus(prop) {
  return prop?.status?.name || prop?.select?.name || "";
}
