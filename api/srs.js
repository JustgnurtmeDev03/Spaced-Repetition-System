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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-srs-token, x-srs-card-db, x-srs-log-db, x-srs-prop-front, x-srs-prop-back, x-srs-prop-deck, x-srs-prop-tags, x-srs-prop-next, x-srs-prop-ef, x-srs-prop-interval, x-srs-prop-reps, x-srs-prop-status, x-srs-log-prop-title, x-srs-log-prop-card, x-srs-log-prop-date, x-srs-log-prop-rating, x-srs-log-prop-interval, x-srs-log-prop-ef, x-srs-log-prop-deck, x-srs-log-prop-result"
  );
  if (req.method === "OPTIONS") return res.status(200).end();

  const runtime = getRuntimeConfig(req);
  const { token, cardDb, logDb, PROP, LOG } = runtime;

  if (!token || !cardDb) {
    return res.status(500).json({
      error:
        "Thiếu NOTION_TOKEN hoặc SRS_CARD_DB trong environment variables hoặc request headers",
    });
  }

  try {
    // ════════════════════════════════════════════
    // GET
    // ════════════════════════════════════════════
    if (req.method === "GET") {
      const { action = "due", deck, limit = "50" } = req.query;

      // ── due: thẻ đến hạn hôm nay ─────────────
      if (action === "due") {
        const today = new Date().toLocaleDateString("en-CA");
        let filter = {
          or: [
            { property: PROP.next, date: { on_or_before: today } },
            { property: PROP.next, date: { is_empty: true } },
          ],
        };
        if (deck && deck !== "all") {
          filter = {
            and: [filter, { property: PROP.deck, select: { equals: deck } }],
          };
        }
        const data = await notionQuery(token, cardDb, filter, [
          { property: PROP.next, direction: "ascending" },
        ]);
        const cards = data.results
          .map((p) => parseCard(p, PROP))
          .filter((c) => c.front);
        return res.status(200).json({ cards, count: cards.length });
      }

      // ── stats: tổng quan ──────────────────────
      if (action === "stats") {
        const data = await notionQuery(token, cardDb, null, null);
        const all = data.results;
        const today = new Date().toLocaleDateString("en-CA");
        // Deck breakdown
        const deckMap = {};
        all.forEach((p) => {
          const d = p.properties[PROP.deck]?.select?.name || "General";
          deckMap[d] = (deckMap[d] || 0) + 1;
        });
        return res.status(200).json({
          total: all.length,
          due: all.filter((p) => {
            const d = p.properties[PROP.next]?.date?.start;
            return !d || d <= today;
          }).length,
          new: all.filter((p) => getStatus(p.properties[PROP.status]) === "New")
            .length,
          mastered: all.filter(
            (p) => getStatus(p.properties[PROP.status]) === "Mastered"
          ).length,
          decks: deckMap,
        });
      }

      // ── logs: lịch sử review ──────────────────
      if (action === "logs") {
        if (!logDb) {
          return res.status(200).json({
            logs: [],
            warning:
              "SRS_LOG_DB chưa được cấu hình trong Vercel environment variables",
          });
        }
        const n = Math.min(parseInt(limit) || 50, 100);
        const data = await notionQuery(token, logDb, null, [
          { property: LOG.date, direction: "descending" },
        ]);
        const logs = data.results.slice(0, n).map((page) => {
          const pr = page.properties;
          const ratingStr = pr[LOG.rating]?.select?.name || "0";
          const ratingNum = parseInt(ratingStr) || 0;
          return {
            id: page.id,
            cardFront: getText(pr[LOG.title]),
            date: pr[LOG.date]?.date?.start || null,
            rating: ratingNum,
            newInterval: pr[LOG.interval]?.number ?? null,
            newEf: pr[LOG.ef]?.number ?? null,
            deck: pr[LOG.deck]?.select?.name || null,
            pass: ratingNum >= 3,
          };
        });
        return res.status(200).json({ logs, total: data.results.length });
      }

      return res.status(400).json({ error: "Unknown action: " + action });
    }

    // ════════════════════════════════════════════
    // POST
    // ════════════════════════════════════════════
    if (req.method === "POST") {
      // Parse body (handle both pre-parsed and raw string)
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

      // ── review: cập nhật SM-2 trên thẻ ────────
      if (body.action === "review") {
        const { pageId, newEf, newInterval, newReps, nextDate, newStatus } =
          body;
        if (!pageId) return res.status(400).json({ error: "Missing pageId" });

        await notionPatch(token, pageId, {
          [PROP.ef]: { number: parseFloat(parseFloat(newEf).toFixed(4)) },
          [PROP.interval]: { number: newInterval },
          [PROP.reps]: { number: newReps },
          [PROP.next]: { date: { start: nextDate } },
          [PROP.status]: { status: { name: newStatus } },
        });
        return res.status(200).json({ ok: true });
      }

      // ── log: ghi vào Review Log DB ─────────────
      if (body.action === "log") {
        if (!logDb) {
          return res.status(400).json({
            error: "SRS_LOG_DB chưa cấu hình",
            hint: "Thêm SRS_LOG_DB=<review-log-db-id> vào Vercel Environment Variables",
          });
        }

        const {
          cardId,
          cardFront,
          cardDeck,
          date,
          rating,
          newInterval,
          newEf,
        } = body;

        // Chuẩn hóa date
        const dateStr =
          typeof date === "string" && date.length >= 10
            ? date.substring(0, 10)
            : new Date().toLocaleDateString("en-CA");

        // Dùng cardFront làm Name để dễ đọc trong Notion
        const nameText = cardFront
          ? cardFront.substring(0, 80)
          : `LOG-${dateStr}`;

        const ratingNum = parseInt(rating) || 0;

        const props = {
          [LOG.title]: { title: [{ text: { content: nameText } }] },
          [LOG.date]: { date: { start: dateStr } },
          [LOG.rating]: { select: { name: String(ratingNum) } },
          [LOG.interval]: { number: newInterval },
          [LOG.ef]: { number: parseFloat(parseFloat(newEf).toFixed(4)) },
        };

        // Thêm các field optional
        if (cardId) props[LOG.card] = { relation: [{ id: cardId }] };
        if (cardDeck) props[LOG.deck] = { select: { name: cardDeck } };
        props[LOG.result] = {
          select: { name: ratingNum >= 3 ? "Pass" : "Fail" },
        };

        await notionCreate(token, logDb, props);
        return res.status(200).json({ ok: true });
      }

      // ── create: tạo 1 thẻ mới ──────────────────
      if (body.action === "create") {
        const { front, back, deck, tags } = body;
        if (!front?.trim() || !back?.trim()) {
          return res.status(400).json({ error: "Front và Back là bắt buộc" });
        }

        const today = new Date().toLocaleDateString("en-CA");
        const props = {
          [PROP.front]: {
            title: [{ text: { content: front.trim().substring(0, 2000) } }],
          },
          [PROP.back]: {
            rich_text: [{ text: { content: back.trim().substring(0, 2000) } }],
          },
          [PROP.ef]: { number: 2.5 },
          [PROP.interval]: { number: 1 },
          [PROP.reps]: { number: 0 },
          [PROP.next]: { date: { start: today } },
          [PROP.status]: { status: { name: "New" } },
        };

        if (deck?.trim()) {
          props[PROP.deck] = { select: { name: deck.trim() } };
        }
        if (tags?.length) {
          props[PROP.tags] = {
            multi_select: tags
              .map((t) => ({ name: String(t).trim() }))
              .filter((t) => t.name),
          };
        }

        const page = await notionCreate(token, cardDb, props);
        return res
          .status(200)
          .json({ ok: true, id: page.id, front: front.trim() });
      }

      // ── import: bulk tạo thẻ từ CSV ────────────
      if (body.action === "import") {
        const { cards } = body;
        if (!Array.isArray(cards) || !cards.length) {
          return res.status(400).json({ error: "Không có thẻ nào để import" });
        }

        const today = new Date().toLocaleDateString("en-CA");
        const results = { success: 0, failed: 0, errors: [] };

        for (const card of cards) {
          if (!card.front?.trim() || !card.back?.trim()) {
            results.failed++;
            results.errors.push(
              `Bỏ qua thẻ thiếu Front/Back: "${card.front || "(trống)"}"`
            );
            continue;
          }

          try {
            const props = {
              [PROP.front]: {
                title: [
                  { text: { content: card.front.trim().substring(0, 2000) } },
                ],
              },
              [PROP.back]: {
                rich_text: [
                  { text: { content: card.back.trim().substring(0, 2000) } },
                ],
              },
              [PROP.ef]: { number: 2.5 },
              [PROP.interval]: { number: 1 },
              [PROP.reps]: { number: 0 },
              [PROP.next]: { date: { start: today } },
              [PROP.status]: { status: { name: "New" } },
            };

            if (card.deck?.trim()) {
              props[PROP.deck] = { select: { name: card.deck.trim() } };
            }
            if (card.tags?.length) {
              props[PROP.tags] = {
                multi_select: card.tags
                  .map((t) => ({ name: String(t).trim() }))
                  .filter((t) => t.name),
              };
            }

            await notionCreate(token, cardDb, props);
            results.success++;

            // Delay nhỏ tránh rate limit Notion (3 req/s)
            await new Promise((r) => setTimeout(r, 340));
          } catch (e) {
            results.failed++;
            results.errors.push(
              `"${card.front.substring(0, 40)}": ${e.message}`
            );
          }
        }

        return res.status(200).json(results);
      }

      return res.status(400).json({ error: "Unknown action: " + body.action });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: err.message });
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
