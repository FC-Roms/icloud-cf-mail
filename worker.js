import PostalMime, { addressParser } from "postal-mime";

const DEFAULT_BLOCKED_DOMAINS = ["spam.com", "fake-mailer.com"];
const DEFAULT_SPAM_WORDS = ["casino", "crypto bonus", "buy now", "loan approved"];
const DEFAULT_MAX_MESSAGE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_WORKER_ID = "icloud-cf-mail";
const DEFAULT_VIEW_TOKEN_PLACEHOLDER = "change-this-view-token";
const LOG_PAGE_SIZE = 10;
const LOGS_AUTO_REFRESH_MS = 30_000;
const MAX_QUERY_EMAILS = 50;
const MAIL_MESSAGES_TABLE = "mail_messages";
const MAIL_RECIPIENTS_TABLE = "mail_message_recipients";
const INLINE_CID_ATTACHMENT_LIMIT_BYTES = 512 * 1024;
const INLINE_CID_ATTACHMENT_TOTAL_LIMIT_BYTES = 2 * 1024 * 1024;
const QUERYABLE_MAIL_DOMAIN = "icloud.com";
const JSON_NO_STORE_HEADERS = {
  "cache-control": "no-store",
};
const PAGE_SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src data: https: http:; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const RECIPIENT_HEADER_NAMES = [
  "to",
  "cc",
  "bcc",
  "delivered-to",
  "x-original-to",
  "resent-to",
  "x-forwarded-to",
  "x-envelope-to",
  "envelope-to",
  "apparently-to",
  "x-apparently-to",
  "original-recipient",
  "final-recipient",
];
const EMAIL_ADDRESS_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

const MAIL_DB_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ${MAIL_MESSAGES_TABLE} (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    envelope_to_email TEXT NOT NULL,
    primary_to_email TEXT NOT NULL,
    recipient_emails_json TEXT NOT NULL,
    to_header TEXT NOT NULL,
    from_email TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_header TEXT NOT NULL,
    reply_to_email TEXT NOT NULL,
    reply_to_header TEXT NOT NULL,
    subject TEXT NOT NULL,
    message_date TEXT NOT NULL,
    message_id TEXT NOT NULL,
    html_body TEXT NOT NULL,
    text_body TEXT NOT NULL,
    html_source TEXT NOT NULL,
    raw_headers_json TEXT NOT NULL,
    attachment_count INTEGER NOT NULL,
    raw_size INTEGER NOT NULL,
    parse_error TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mail_messages_worker_received
    ON ${MAIL_MESSAGES_TABLE}(worker_id, received_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS ${MAIL_RECIPIENTS_TABLE} (
    worker_id TEXT NOT NULL,
    email TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (worker_id, email, message_id)
  )`,
];

const initializedMailDbs = new WeakSet();
const initializingMailDbs = new WeakMap();

function serializeScriptValue(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function normalizeHeader(value) {
  return value ? value.toString().trim() : "";
}

function normalizeEmail(value) {
  return (value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
}

function getEmailDomain(value) {
  const email = normalizeEmail(value);
  const atIndex = email.lastIndexOf("@");

  return atIndex === -1 ? "" : email.slice(atIndex + 1);
}

function isQueryableIcloudEmail(value) {
  const email = normalizeEmail(value);

  return isValidEmail(email) && getEmailDomain(email) === QUERYABLE_MAIL_DOMAIN;
}

function parseQueryableEmailInput(values, { maxCount = MAX_QUERY_EMAILS } = {}) {
  const inputs = Array.isArray(values) ? values : [values];
  const emails = [];
  const seen = new Set();
  let hasInvalid = false;

  for (const input of inputs) {
    for (const part of String(input || "").split(/[\n\r,]+/)) {
      const email = normalizeEmail(part);

      if (!email) continue;
      if (!isQueryableIcloudEmail(email)) {
        hasInvalid = true;
        continue;
      }
      if (seen.has(email)) continue;

      seen.add(email);
      emails.push(email);

      if (emails.length > maxCount) {
        return {
          emails,
          hasInvalid,
          tooMany: true,
        };
      }
    }
  }

  return {
    emails,
    hasInvalid,
    tooMany: false,
  };
}

function addEmail(addresses, value) {
  const email = normalizeEmail(value);

  if (email && isValidEmail(email)) {
    addresses.add(email);
  }
}

function parseCsv(value, fallback = []) {
  if (!value) return fallback;

  const items = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return items.length > 0 ? items : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err || "");
}

function getWorkerId(env) {
  return (env.WORKER_ID || DEFAULT_WORKER_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
}

function getWorkerUrl(env, requestUrl) {
  return (env.WORKER_URL || "").trim() || requestUrl.origin;
}

function timingSafeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < maxLength; index++) {
    diff |= left.charCodeAt(index % Math.max(left.length, 1)) ^
      right.charCodeAt(index % Math.max(right.length, 1));
  }

  return diff === 0;
}

function getConfiguredViewToken(env) {
  const token = normalizeHeader(env.VIEW_TOKEN);

  if (!token || token === DEFAULT_VIEW_TOKEN_PLACEHOLDER) return "";
  return token;
}

function getBearerToken(request) {
  const header = normalizeHeader(request.headers.get("authorization"));
  const match = header.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function validateViewAccess(request, env) {
  const configuredToken = getConfiguredViewToken(env);

  if (!configuredToken) {
    return {
      ok: false,
      status: 503,
      message: "VIEW_TOKEN secret is not configured",
    };
  }

  if (!timingSafeEqual(getBearerToken(request), configuredToken)) {
    return {
      ok: false,
      status: 401,
      message: "Unauthorized",
    };
  }

  return {
    ok: true,
  };
}

function addParsedAddress(items, item) {
  if (!item) return;

  if (Array.isArray(item.group)) {
    item.group.forEach((member) => addParsedAddress(items, member));
    return;
  }

  const address = normalizeEmail(item.address);

  if (!address || !isValidEmail(address)) return;

  items.push({
    name: normalizeHeader(item.name),
    address,
  });
}

function parseAddressHeader(value) {
  const headerValue = normalizeHeader(value);
  const items = [];

  if (!headerValue) return items;

  try {
    addressParser(headerValue, { flatten: true }).forEach((item) =>
      addParsedAddress(items, item)
    );
  } catch {
    for (const match of headerValue.matchAll(EMAIL_ADDRESS_PATTERN)) {
      items.push({
        name: "",
        address: normalizeEmail(match[0]),
      });
    }
  }

  const seen = new Set();

  return items.filter((item) => {
    if (seen.has(item.address)) return false;
    seen.add(item.address);
    return true;
  });
}

function addPostalAddresses(addresses, value) {
  if (!value) return;

  const items = Array.isArray(value) ? value : [value];

  for (const item of items) {
    if (typeof item === "string") {
      parseAddressHeader(item).forEach((address) => addEmail(addresses, address.address));
      continue;
    }

    if (item && typeof item === "object") {
      if (Array.isArray(item.group)) {
        addPostalAddresses(addresses, item.group);
        continue;
      }

      addEmail(addresses, item.address);
    }
  }
}

function collectRecipientEmails(headers, envelopeTo, parsedEmail) {
  const addresses = new Set();
  addEmail(addresses, envelopeTo);

  for (const headerName of RECIPIENT_HEADER_NAMES) {
    for (const item of parseAddressHeader(headers.get(headerName))) {
      addEmail(addresses, item.address);
    }
  }

  addPostalAddresses(addresses, parsedEmail?.to);
  addPostalAddresses(addresses, parsedEmail?.cc);
  addPostalAddresses(addresses, parsedEmail?.bcc);

  return [...addresses];
}

function getPrimaryToEmail(headers, envelopeTo) {
  const toAddresses = parseAddressHeader(headers.get("to"));

  return toAddresses[0]?.address || normalizeEmail(envelopeTo);
}

function getFromDetails(headers, envelopeFrom, parsedEmail) {
  const fromHeader = normalizeHeader(headers.get("from"));
  const parsedFrom =
    (Array.isArray(parsedEmail?.from) ? parsedEmail.from[0] : parsedEmail?.from) ||
    parseAddressHeader(fromHeader)[0];
  const fromEmail = normalizeEmail(parsedFrom?.address || envelopeFrom);

  return {
    fromEmail,
    fromName: normalizeHeader(parsedFrom?.name),
    fromHeader,
  };
}

function getReplyToDetails(headers, parsedEmail) {
  const replyToHeader = normalizeHeader(headers.get("reply-to"));
  const parsedReplyTo =
    (Array.isArray(parsedEmail?.replyTo) ? parsedEmail.replyTo[0] : parsedEmail?.replyTo) ||
    parseAddressHeader(replyToHeader)[0];

  return {
    replyToEmail: normalizeEmail(parsedReplyTo?.address),
    replyToHeader,
  };
}

function getRawHeadersJson(headers) {
  const rows = [];

  for (const [name, value] of headers.entries()) {
    rows.push([name, value]);
  }

  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(rows);
}

function escapeHtml(value) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlToText(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textToHtml(text) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base target="_blank">
  <style>
    body {
      margin: 0;
      padding: 24px;
      color: #17201d;
      background: #ffffff;
      font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>${escapeHtml(text || "")}</body>
</html>`;
}

function stripDangerousHtml(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?<\/embed>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<frameset[\s\S]*?<\/frameset>/gi, "")
    .replace(/<frame[\s\S]*?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s(href|src)\s*=\s*"javascript:[^"]*"/gi, ' $1="#"')
    .replace(/\s(href|src)\s*=\s*'javascript:[^']*'/gi, " $1='#'");
}

function ensureHtmlDocument(html, fallbackText) {
  const cleaned = stripDangerousHtml((html || "").trim());

  if (!cleaned) return textToHtml(fallbackText);
  if (/<html[\s>]/i.test(cleaned)) return cleaned;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base target="_blank">
</head>
<body>${cleaned}</body>
</html>`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeContentId(value) {
  return normalizeHeader(value).replace(/^<|>$/g, "");
}

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function inlineCidAttachments(html, attachments = []) {
  let nextHtml = html || "";
  let totalBytes = 0;

  if (!nextHtml || !Array.isArray(attachments)) return nextHtml;

  for (const attachment of attachments) {
    const contentId = normalizeContentId(attachment.contentId);
    const content = attachment.content;

    if (!contentId || !content) continue;

    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);

    if (bytes.byteLength > INLINE_CID_ATTACHMENT_LIMIT_BYTES) continue;
    if (totalBytes + bytes.byteLength > INLINE_CID_ATTACHMENT_TOTAL_LIMIT_BYTES) continue;

    totalBytes += bytes.byteLength;

    const mimeType = attachment.mimeType || "application/octet-stream";
    const dataUri = `data:${mimeType};base64,${arrayBufferToBase64(bytes)}`;
    const candidates = [contentId, encodeURIComponent(contentId)];

    for (const candidate of candidates) {
      nextHtml = nextHtml.replace(
        new RegExp(`cid:${escapeRegExp(candidate)}`, "gi"),
        dataUri
      );
    }
  }

  return nextHtml;
}

async function parseIncomingMessage(message) {
  try {
    const parsedEmail = await PostalMime.parse(message.raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 50,
      maxHeadersSize: 512 * 1024,
    });
    const textBody = parsedEmail.text || htmlToText(parsedEmail.html || "");
    const htmlBody = ensureHtmlDocument(
      inlineCidAttachments(parsedEmail.html || "", parsedEmail.attachments),
      textBody
    );

    return {
      parsedEmail,
      htmlBody,
      textBody,
      htmlSource: parsedEmail.html ? "text/html" : parsedEmail.text ? "text/plain" : "none",
      attachmentCount: Array.isArray(parsedEmail.attachments)
        ? parsedEmail.attachments.length
        : 0,
      parseError: "",
    };
  } catch (err) {
    console.error("Email parse error:", err);

    return {
      parsedEmail: null,
      htmlBody: textToHtml(""),
      textBody: "",
      htmlSource: "parse-error",
      attachmentCount: 0,
      parseError: getErrorMessage(err),
    };
  }
}

async function ensureMailDbSchema(env) {
  const db = env.MAIL_DB;

  if (!db) {
    throw new Error("MAIL_DB D1 not configured");
  }

  if (initializedMailDbs.has(db)) return db;

  let initPromise = initializingMailDbs.get(db);

  if (!initPromise) {
    initPromise = (async () => {
      for (const statement of MAIL_DB_SCHEMA_STATEMENTS) {
        await db.prepare(statement).run();
      }

      initializedMailDbs.add(db);
      initializingMailDbs.delete(db);
    })().catch((err) => {
      initializingMailDbs.delete(db);
      throw err;
    });

    initializingMailDbs.set(db, initPromise);
  }

  await initPromise;
  return db;
}

function parseRecipientEmailsJson(value) {
  if (typeof value !== "string" || !value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => normalizeEmail(item)).filter((item) => isValidEmail(item))
      : [];
  } catch {
    return [];
  }
}

function mapDbMessageRow(row, queriedEmailsSet = null) {
  const message = {
    id: row.id,
    subject: row.subject || "",
    date: row.date || "",
    htmlBody: row.htmlBody || "",
    receivedAt: row.receivedAt || "",
  };

  if (queriedEmailsSet instanceof Set && queriedEmailsSet.size > 1) {
    const matchedEmails = parseRecipientEmailsJson(row.recipientEmailsJson).filter((email) =>
      queriedEmailsSet.has(email)
    );

    if (matchedEmails.length > 0) {
      message.matchedEmails = matchedEmails;
    }
  }

  return message;
}

function parseRawHeadersJson(value) {
  if (typeof value !== "string" || !value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveMailMessage(env, messageData) {
  const db = await ensureMailDbSchema(env);
  const id = crypto.randomUUID();
  const workerId = getWorkerId(env);
  const receivedAt = new Date().toISOString();
  const recipientEmails = [...new Set((messageData.recipientEmails || []).map(normalizeEmail))]
    .filter((email) => isQueryableIcloudEmail(email));
  const primaryToEmail = isQueryableIcloudEmail(messageData.primaryToEmail)
    ? normalizeEmail(messageData.primaryToEmail)
    : recipientEmails[0] || "";

  await db
    .prepare(
      `INSERT INTO ${MAIL_MESSAGES_TABLE} (
        id, worker_id, envelope_to_email, primary_to_email, recipient_emails_json,
        to_header, from_email, from_name, from_header, reply_to_email,
        reply_to_header, subject, message_date, message_id, html_body,
        text_body, html_source, raw_headers_json, attachment_count,
        raw_size, parse_error, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      workerId,
      normalizeEmail(messageData.envelopeToEmail),
      primaryToEmail,
      JSON.stringify(recipientEmails),
      normalizeHeader(messageData.toHeader),
      normalizeEmail(messageData.fromEmail),
      normalizeHeader(messageData.fromName),
      normalizeHeader(messageData.fromHeader),
      normalizeEmail(messageData.replyToEmail),
      normalizeHeader(messageData.replyToHeader),
      normalizeHeader(messageData.subject),
      normalizeHeader(messageData.date),
      normalizeHeader(messageData.messageId),
      messageData.htmlBody || "",
      messageData.textBody || "",
      normalizeHeader(messageData.htmlSource) || "none",
      messageData.rawHeadersJson || "[]",
      Number(messageData.attachmentCount) || 0,
      Number(messageData.rawSize) || 0,
      normalizeHeader(messageData.parseError),
      receivedAt
    )
    .run();

  for (const recipient of recipientEmails) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ${MAIL_RECIPIENTS_TABLE}
        (worker_id, email, message_id)
        VALUES (?, ?, ?)`
      )
      .bind(workerId, recipient, id)
      .run();
  }

  return id;
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

function encodeCursor(cursor) {
  if (!cursor) return null;

  return encodeBase64Url(JSON.stringify({ v: 1, c: cursor }));
}

function decodeCursor(value) {
  const token = (value || "").trim();

  if (!token) return { ok: true, cursor: undefined };

  try {
    const data = JSON.parse(decodeBase64Url(token));

    if (data?.v !== 1 || typeof data.c !== "string" || !data.c) {
      return { ok: false };
    }

    return {
      ok: true,
      cursor: data.c,
    };
  } catch {
    return { ok: false };
  }
}

function encodeLogCursorFromRow(row) {
  if (!row?.receivedAt || !row?.id) return null;

  return encodeCursor(
    JSON.stringify({
      receivedAt: row.receivedAt,
      id: row.id,
    })
  );
}

function decodeLogCursor(value) {
  const decoded = decodeCursor(value);

  if (!decoded.ok) return { ok: false };
  if (!decoded.cursor) return { ok: true, cursor: null };

  try {
    const data = JSON.parse(decoded.cursor);

    if (
      typeof data?.receivedAt !== "string" ||
      !data.receivedAt ||
      typeof data?.id !== "string" ||
      !data.id
    ) {
      return { ok: false };
    }

    return {
      ok: true,
      cursor: {
        receivedAt: data.receivedAt,
        id: data.id,
      },
    };
  } catch {
    return { ok: false };
  }
}

function getSearchParamsPreservePlus(url, name) {
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const values = [];

  for (const part of query.split("&")) {
    if (!part) continue;

    const separatorIndex = part.indexOf("=");
    const rawName = separatorIndex === -1 ? part : part.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : part.slice(separatorIndex + 1);

    try {
      if (decodeURIComponent(rawName.replace(/\+/g, " ")) !== name) continue;

      values.push(decodeURIComponent(rawValue.replace(/\+/g, "%2B")));
    } catch {
      return [];
    }
  }

  return values;
}

async function listMailMessages(env, { emails = [], cursor } = {}) {
  const db = await ensureMailDbSchema(env);
  const workerId = getWorkerId(env);
  const emailFilters = parseQueryableEmailInput(emails).emails;
  const queriedEmailsSet = new Set(emailFilters);
  const conditions = ["m.worker_id = ?"];
  const params = [workerId];

  if (emailFilters.length > 0) {
    const placeholders = emailFilters.map(() => "?").join(", ");

    conditions.push(
      `EXISTS (
        SELECT 1
        FROM ${MAIL_RECIPIENTS_TABLE} r
        WHERE r.worker_id = m.worker_id
          AND r.message_id = m.id
          AND r.email IN (${placeholders})
      )`
    );
    params.push(...emailFilters);
  }

  if (cursor) {
    conditions.push("(m.received_at < ? OR (m.received_at = ? AND m.id < ?))");
    params.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }

  params.push(LOG_PAGE_SIZE + 1);

  const result = await db
    .prepare(
      `SELECT
        m.id,
        m.subject,
        m.message_date AS "date",
        m.html_body AS htmlBody,
        m.received_at AS receivedAt,
        m.recipient_emails_json AS recipientEmailsJson
      FROM ${MAIL_MESSAGES_TABLE} m
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT ?`
    )
    .bind(...params)
    .all();

  const rows = Array.isArray(result?.results) ? result.results : [];
  const mapped = rows.map((row) => mapDbMessageRow(row, queriedEmailsSet));
  const hasMore = mapped.length > LOG_PAGE_SIZE;
  const messages = hasMore ? mapped.slice(0, LOG_PAGE_SIZE) : mapped;
  const nextCursor = hasMore
    ? encodeLogCursorFromRow(messages[messages.length - 1])
    : null;

  return {
    messages,
    logs: messages,
    pagination: {
      limit: LOG_PAGE_SIZE,
      hasMore: Boolean(nextCursor),
      nextCursor,
    },
  };
}

function renderMailPage(workerUrl) {
  const serializedWorkerUrl = serializeScriptValue(workerUrl);

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>iCloud Mail</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;700;900&display=swap">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%23176b7a'/%3E%3Cpath d='M22 43h19c5.523 0 10-4.477 10-10 0-5.093-3.804-9.297-8.732-9.924C40.647 17.792 35.873 14 30.25 14c-7.042 0-12.75 5.708-12.75 12.75 0 .463.025.92.075 1.372C13.153 29.082 10 32.919 10 37.5 10 40.538 11.231 43 22 43Z' fill='%23ffffff'/%3E%3C/svg%3E">
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f7f5;
      --panel: rgba(255, 255, 255, 0.94);
      --panel-strong: #ffffff;
      --panel-soft: #edf3f2;
      --panel-soft-strong: #e3ece9;
      --ink: #132320;
      --muted: #61706b;
      --line: rgba(19, 35, 32, 0.12);
      --accent: #176b7a;
      --accent-strong: #0e5461;
      --danger: #b42318;
      --focus: rgba(23, 107, 122, 0.16);
      --radius-xl: 30px;
      --radius-lg: 22px;
      --radius-md: 18px;
      --radius-sm: 14px;
      --control-height: 56px;
      --shadow: 0 22px 60px rgba(16, 31, 28, 0.12);
      --shadow-soft: 0 14px 34px rgba(16, 31, 28, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    html {
      -webkit-text-size-adjust: 100%;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top right, rgba(23, 107, 122, 0.12), transparent 24%),
        radial-gradient(circle at left 18%, rgba(175, 210, 202, 0.26), transparent 30%),
        linear-gradient(180deg, #f6f9f7 0%, #eef4f1 100%);
      color: var(--ink);
      font-family: "Noto Sans", "Segoe UI", Arial, sans-serif;
      letter-spacing: -0.015em;
    }

    button,
    input,
    textarea {
      font: inherit;
    }

    button {
      min-height: var(--control-height);
      border: 0;
      border-radius: var(--radius-md);
      cursor: pointer;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      transition:
        transform 180ms ease,
        box-shadow 180ms ease,
        background-color 180ms ease,
        border-color 180ms ease;
      touch-action: manipulation;
    }

    button:hover:not(:disabled) {
      transform: translateY(-1px);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
      transform: none;
    }

    .page {
      width: min(1240px, calc(100% - 32px));
      margin: 0 auto;
      padding: clamp(20px, 4vw, 40px) 0 56px;
    }

    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 22px;
    }

    h1 {
      margin: 0;
      font-size: clamp(3.2rem, 8vw, 5.4rem);
      line-height: 0.92;
      letter-spacing: -0.065em;
      max-width: 8ch;
    }

    .status {
      flex: 0 0 auto;
      border: 1px solid rgba(23, 107, 122, 0.14);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.82);
      color: var(--accent-strong);
      padding: 12px 18px;
      font-size: 1rem;
      font-weight: 700;
      white-space: nowrap;
      box-shadow: 0 8px 20px rgba(16, 31, 28, 0.06);
      backdrop-filter: blur(16px);
    }

    .search-panel {
      position: relative;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.62);
      border-radius: var(--radius-xl);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(246, 250, 248, 0.92));
      box-shadow: var(--shadow);
      padding: clamp(22px, 3vw, 34px);
      backdrop-filter: blur(18px);
    }

    .search-panel::after {
      content: "";
      position: absolute;
      inset: 0 auto auto 58%;
      width: 240px;
      height: 240px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(23, 107, 122, 0.1), transparent 68%);
      pointer-events: none;
      transform: translateY(-44%);
    }

    .search-form {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.86fr);
      gap: 18px;
      align-items: stretch;
    }

    .field {
      display: grid;
      gap: 10px;
      min-width: 0;
    }

    .field-stack {
      display: grid;
      gap: 18px;
      align-content: stretch;
    }

    .field-label {
      color: var(--muted);
      font-size: 0.8rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    input,
    textarea {
      width: 100%;
      border: 1px solid rgba(19, 35, 32, 0.1);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.92);
      color: var(--ink);
      outline: none;
      font-size: 16px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.95),
        0 4px 10px rgba(16, 31, 28, 0.03);
      transition:
        border-color 160ms ease,
        box-shadow 160ms ease,
        background-color 160ms ease;
    }

    textarea::placeholder,
    input::placeholder {
      color: #7b8683;
    }

    input {
      min-height: var(--control-height);
      padding: 0 18px;
    }

    textarea {
      min-height: 166px;
      padding: 16px 18px;
      line-height: 1.55;
      font-weight: 600;
      resize: vertical;
    }

    input:focus,
    textarea:focus {
      border-color: rgba(23, 107, 122, 0.38);
      box-shadow:
        0 0 0 5px var(--focus),
        0 10px 24px rgba(23, 107, 122, 0.08);
      background: var(--panel-strong);
    }

    .field-note {
      color: var(--muted);
      font-size: 0.9rem;
      font-weight: 600;
      line-height: 1.45;
      text-transform: none;
      max-width: 64ch;
    }

    .action-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      align-self: end;
    }

    .primary {
      background: linear-gradient(180deg, #247d8d 0%, #166978 100%);
      color: #fff;
      box-shadow: 0 14px 24px rgba(23, 107, 122, 0.22);
    }

    .primary:hover:not(:disabled) {
      background: linear-gradient(180deg, #1d7281 0%, #105d6a 100%);
      box-shadow: 0 16px 28px rgba(23, 107, 122, 0.26);
    }

    .secondary {
      border: 1px solid rgba(19, 35, 32, 0.1);
      background: rgba(255, 255, 255, 0.82);
      color: var(--ink);
      box-shadow: 0 10px 20px rgba(16, 31, 28, 0.06);
    }

    .secondary:hover:not(:disabled) {
      border-color: rgba(23, 107, 122, 0.24);
      background: rgba(255, 255, 255, 0.96);
    }

    .meta-line {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 18px;
    }

    .meta-chip {
      display: grid;
      gap: 6px;
      padding: 14px 16px;
      border: 1px solid rgba(19, 35, 32, 0.08);
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.56);
    }

    .meta-label {
      color: var(--muted);
      font-size: 0.76rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .meta-value {
      color: var(--ink);
      font-size: 1rem;
      font-weight: 650;
      line-height: 1.4;
      word-break: break-word;
    }

    .message {
      margin-top: 16px;
      border-radius: var(--radius-lg);
      background: linear-gradient(180deg, rgba(237, 243, 242, 0.9), rgba(227, 236, 233, 0.9));
      color: var(--muted);
      padding: 16px 18px;
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.5;
    }

    .message.error {
      background: linear-gradient(180deg, #fff3f1, #ffe7e4);
      color: var(--danger);
    }

    .messages {
      display: grid;
      gap: 16px;
      margin-top: 18px;
    }

    .mail-card {
      border: 1px solid rgba(19, 35, 32, 0.08);
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow-soft);
      overflow: hidden;
    }

    .mail-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      padding: 18px 20px;
      border-bottom: 1px solid rgba(19, 35, 32, 0.08);
    }

    .mail-head h2 {
      margin: 0;
      font-size: 1.08rem;
      line-height: 1.35;
      letter-spacing: -0.02em;
    }

    .mail-title {
      display: grid;
      gap: 8px;
    }

    .mail-match {
      color: var(--accent-strong);
      font-size: 0.85rem;
      font-weight: 700;
      line-height: 1.45;
      word-break: break-word;
    }

    .mail-date {
      color: var(--muted);
      font-size: 0.88rem;
      font-weight: 700;
      white-space: nowrap;
    }

    .mail-frame {
      width: 100%;
      height: min(680px, 78vh);
      border: 0;
      display: block;
      background: #fff;
    }

    .load-more {
      display: flex;
      justify-content: center;
      margin-top: 20px;
    }

    .hidden {
      display: none;
    }

    @media (max-width: 920px) {
      .search-form {
        grid-template-columns: 1fr;
      }

      .field-stack {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 760px) {
      .page {
        width: min(100% - 18px, 1240px);
        padding-top: 18px;
      }

      .topbar,
      .mail-head {
        display: grid;
        grid-template-columns: 1fr;
        align-items: flex-start;
      }

      h1 {
        max-width: none;
        font-size: clamp(2.8rem, 17vw, 4.4rem);
      }

      .status {
        justify-self: start;
      }

      .search-panel {
        border-radius: 24px;
        padding: 18px;
      }

      textarea {
        min-height: 154px;
      }

      .action-row,
      .meta-line {
        grid-template-columns: 1fr;
      }

      .mail-date {
        white-space: normal;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="topbar" aria-labelledby="page-title">
      <h1 id="page-title">iCloud Mail</h1>
      <div class="status" data-auto-status>Tự làm mới: tắt</div>
    </section>

    <section class="search-panel">
      <form class="search-form" data-mail-form>
        <label class="field">
          <span class="field-label">Email iCloud</span>
          <textarea data-mail-input name="email" placeholder="farrago.mull-1u@icloud.com&#10;user+tag@icloud.com, another-alias@icloud.com" autocomplete="off" autocapitalize="none" spellcheck="false" required></textarea>
          <span class="field-note">Nhập nhiều email, mỗi dòng một email hoặc ngăn cách bằng dấu phẩy.</span>
        </label>
        <div class="field-stack">
          <label class="field">
            <span class="field-label">Mã truy cập</span>
            <input data-token-input type="password" name="token" placeholder="VIEW_TOKEN" autocomplete="current-password" required>
          </label>
          <div class="action-row">
            <button class="primary" type="submit" data-search-button>Tìm mail</button>
            <button class="secondary" type="button" data-refresh-button>Làm mới</button>
          </div>
        </div>
      </form>
      <div class="meta-line">
        <div class="meta-chip">
          <span class="meta-label">Đang xem</span>
          <strong class="meta-value" data-current-mail>Chưa chọn email</strong>
        </div>
        <div class="meta-chip">
          <span class="meta-label">Cập nhật</span>
          <strong class="meta-value" data-last-updated>Chưa cập nhật</strong>
        </div>
      </div>
      <div class="message" data-message>Nhập một hoặc nhiều địa chỉ iCloud để xem mail.</div>
    </section>

    <section class="messages" data-messages aria-live="polite"></section>
    <div class="load-more">
      <button class="secondary hidden" type="button" data-load-more>Tải thêm</button>
    </div>
  </main>

  <script>
    const WORKER_URL = ${serializedWorkerUrl};
    const LOGS_URL = new URL("/logs", WORKER_URL.endsWith("/") ? WORKER_URL : WORKER_URL + "/").toString();
    const AUTO_REFRESH_MS = ${LOGS_AUTO_REFRESH_MS};
    const AUTO_REFRESH_SECONDS = Math.round(AUTO_REFRESH_MS / 1000);
    const MAX_QUERY_EMAILS = ${MAX_QUERY_EMAILS};

    const form = document.querySelector("[data-mail-form]");
    const input = document.querySelector("[data-mail-input]");
    const tokenInput = document.querySelector("[data-token-input]");
    const searchButton = document.querySelector("[data-search-button]");
    const refreshButton = document.querySelector("[data-refresh-button]");
    const loadMoreButton = document.querySelector("[data-load-more]");
    const messagesEl = document.querySelector("[data-messages]");
    const messageEl = document.querySelector("[data-message]");
    const currentMailEl = document.querySelector("[data-current-mail]");
    const lastUpdatedEl = document.querySelector("[data-last-updated]");
    const autoStatusEl = document.querySelector("[data-auto-status]");

    let currentMails = [];
    let accessToken = window.sessionStorage.getItem("icloud-mail-view-token") || "";
    let nextCursor = null;
    let loading = false;
    let autoRefreshId = null;
    let requestId = 0;

    tokenInput.value = accessToken;

    function setLoading(value) {
      loading = value;
      searchButton.disabled = value;
      refreshButton.disabled = value;
      loadMoreButton.disabled = value;
    }

    function setMessage(text, type = "info") {
      messageEl.textContent = text;
      messageEl.classList.toggle("error", type === "error");
    }

    function setAutoRefresh(active) {
      if (autoRefreshId) {
        window.clearInterval(autoRefreshId);
        autoRefreshId = null;
      }

      if (!active) {
        autoStatusEl.textContent = "Tự làm mới: tắt";
        return;
      }

      autoStatusEl.textContent = "Tự làm mới: " + AUTO_REFRESH_SECONDS + "s";
      autoRefreshId = window.setInterval(() => {
        if (currentMails.length === 0 || loading) return;
        fetchMessages({ append: false, cursor: null, silent: true });
      }, AUTO_REFRESH_MS);
    }

    function formatDate(value) {
      if (!value) return "Không rõ";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;

      return new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
    }

    function isIcloudEmail(value) {
      return /^[^\\s@]+@icloud\\.com$/i.test((value || "").trim());
    }

    function parseEmailInput(value) {
      const emails = [];
      const seen = new Set();
      let hasInvalid = false;

      for (const part of String(value || "").split(/[\\n\\r,]+/)) {
        const email = part.trim().toLowerCase();

        if (!email) continue;
        if (!isIcloudEmail(email)) {
          hasInvalid = true;
          continue;
        }
        if (seen.has(email)) continue;

        seen.add(email);
        emails.push(email);
      }

      return {
        emails,
        hasInvalid,
        tooMany: emails.length > MAX_QUERY_EMAILS,
      };
    }

    function summarizeEmails(emails) {
      if (emails.length === 0) return "Chưa chọn email";

      const preview = emails.length <= 3 ? emails.join(", ") : emails.slice(0, 3).join(", ") + " +" + (emails.length - 3);

      return emails.length === 1 ? preview : emails.length + " email: " + preview;
    }

    function createMessageCard(item) {
      const card = document.createElement("article");
      card.className = "mail-card";

      const head = document.createElement("header");
      head.className = "mail-head";
      const titleWrap = document.createElement("div");
      titleWrap.className = "mail-title";
      const title = document.createElement("h2");
      title.textContent = item.subject || "(Không có tiêu đề)";
      titleWrap.append(title);

      if (
        Array.isArray(item.matchedEmails) &&
        item.matchedEmails.length > 0 &&
        currentMails.length > 1
      ) {
        const match = document.createElement("div");
        match.className = "mail-match";
        match.textContent = "Khớp: " + item.matchedEmails.join(", ");
        titleWrap.append(match);
      }

      const date = document.createElement("div");
      date.className = "mail-date";
      date.textContent = formatDate(item.date || item.receivedAt);
      head.append(titleWrap, date);

      const iframe = document.createElement("iframe");
      iframe.className = "mail-frame";
      iframe.setAttribute("sandbox", "allow-popups");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.srcdoc = item.htmlBody || "";

      card.append(head, iframe);
      return card;
    }

    function renderMessages(items, append) {
      if (!append) messagesEl.textContent = "";

      if (!append && items.length === 0) {
        setMessage(
          currentMails.length > 1 ? "Chưa có mail cho các email này." : "Chưa có mail cho email này."
        );
        return;
      }

      const fragment = document.createDocumentFragment();
      items.forEach((item) => fragment.append(createMessageCard(item)));
      messagesEl.append(fragment);
      setMessage(append ? "Đã tải thêm mail." : "Đã cập nhật danh sách mail.");
    }

    async function fetchMessages({ append = false, cursor = null, silent = false } = {}) {
      if (currentMails.length === 0) {
        setMessage("Nhập email trước khi làm mới.", "error");
        input.focus();
        return;
      }

      accessToken = tokenInput.value.trim();
      if (!accessToken) {
        setMessage("Nhập mã truy cập trước khi tải mail.", "error");
        tokenInput.focus();
        return;
      }

      window.sessionStorage.setItem("icloud-mail-view-token", accessToken);

      const currentRequest = ++requestId;
      const params = new URLSearchParams();

      currentMails.forEach((email) => params.append("mail", email));
      if (cursor) params.set("cursor", cursor);

      setLoading(true);
      if (!silent) setMessage(append ? "Đang tải thêm..." : "Đang tải mail...");

      try {
        const response = await fetch(LOGS_URL + "?" + params.toString(), {
          cache: "no-store",
          headers: {
            authorization: "Bearer " + accessToken,
          },
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Không thể tải mail");
        }

        const data = await response.json();
        const items = Array.isArray(data.messages) ? data.messages : data.logs;

        if (!Array.isArray(items)) throw new Error("Response không hợp lệ");
        if (currentRequest !== requestId) return;

        nextCursor = data.pagination?.nextCursor || null;
        renderMessages(items, append);
        currentMailEl.textContent = summarizeEmails(currentMails);
        lastUpdatedEl.textContent = "Cập nhật: " + formatDate(new Date().toISOString());
        loadMoreButton.classList.toggle("hidden", !nextCursor);
      } catch (err) {
        if (currentRequest !== requestId) return;
        setMessage(err instanceof Error ? err.message : "Không thể tải mail", "error");
      } finally {
        if (currentRequest === requestId) setLoading(false);
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const parsed = parseEmailInput(input.value);
      accessToken = tokenInput.value.trim();
      if (parsed.tooMany) {
        setMessage("Tối đa " + MAX_QUERY_EMAILS + " email @icloud.com mỗi lần.", "error");
        input.focus();
        return;
      }
      if (parsed.hasInvalid) {
        setMessage("Chỉ được tra cứu email @icloud.com.", "error");
        input.focus();
        return;
      }
      if (parsed.emails.length === 0) return;
      if (!accessToken) {
        setMessage("Nhập mã truy cập trước khi tìm mail.", "error");
        tokenInput.focus();
        return;
      }

      currentMails = parsed.emails;
      nextCursor = null;
      setAutoRefresh(true);
      fetchMessages({ append: false });
    });

    refreshButton.addEventListener("click", () => {
      const parsed = parseEmailInput(input.value);
      accessToken = tokenInput.value.trim();
      if (parsed.tooMany) {
        setMessage("Tối đa " + MAX_QUERY_EMAILS + " email @icloud.com mỗi lần.", "error");
        input.focus();
        return;
      }
      if (parsed.hasInvalid) {
        setMessage("Chỉ được tra cứu email @icloud.com.", "error");
        input.focus();
        return;
      }
      if (parsed.emails.length > 0) {
        currentMails = parsed.emails;
      }
      if (!accessToken) {
        setMessage("Nhập mã truy cập trước khi làm mới.", "error");
        tokenInput.focus();
        return;
      }
      if (currentMails.length === 0) {
        setMessage("Nhập email trước khi làm mới.", "error");
        input.focus();
        return;
      }
      nextCursor = null;
      setAutoRefresh(currentMails.length > 0);
      fetchMessages({ append: false });
    });

    loadMoreButton.addEventListener("click", () => {
      if (!nextCursor) return;
      fetchMessages({ append: true, cursor: nextCursor });
    });
  </script>
</body>
</html>`;
}

async function handleEmail(message, env) {
  const adminEmail = normalizeEmail(env.ADMIN_EMAIL);
  const blockedDomains = parseCsv(env.BLOCKED_DOMAINS, DEFAULT_BLOCKED_DOMAINS);
  const spamWords = parseCsv(env.SPAM_WORDS, DEFAULT_SPAM_WORDS);
  const maxMessageSize = parsePositiveInteger(
    env.MAX_MESSAGE_SIZE_BYTES,
    DEFAULT_MAX_MESSAGE_SIZE_BYTES
  );

  if (!adminEmail) {
    message.setReject("ADMIN_EMAIL not configured");
    return;
  }

  const envelopeToEmail = normalizeEmail(message.to);
  const envelopeFromEmail = normalizeEmail(message.from);
  const subject = normalizeHeader(message.headers.get("subject"));

  if (message.rawSize > maxMessageSize) {
    message.setReject("Message too large");
    return;
  }

  const senderDomain = envelopeFromEmail.split("@")[1] || "";

  if (blockedDomains.includes(senderDomain)) {
    message.setReject("Sender blocked");
    return;
  }

  const lowerSubject = subject.toLowerCase();

  if (spamWords.some((word) => lowerSubject.includes(word))) {
    message.setReject("Spam detected");
    return;
  }

  const parsed = await parseIncomingMessage(message);
  const fromDetails = getFromDetails(message.headers, envelopeFromEmail, parsed.parsedEmail);
  const replyToDetails = getReplyToDetails(message.headers, parsed.parsedEmail);
  const detectedRecipientEmails = collectRecipientEmails(
    message.headers,
    envelopeToEmail,
    parsed.parsedEmail
  );
  const recipientEmails = detectedRecipientEmails.filter(isQueryableIcloudEmail);
  const primaryToEmail =
    recipientEmails[0] ||
    (isQueryableIcloudEmail(getPrimaryToEmail(message.headers, envelopeToEmail))
      ? getPrimaryToEmail(message.headers, envelopeToEmail)
      : "");

  await saveMailMessage(env, {
    envelopeToEmail,
    primaryToEmail,
    recipientEmails,
    toHeader: normalizeHeader(message.headers.get("to")),
    ...fromDetails,
    ...replyToDetails,
    subject,
    date: normalizeHeader(message.headers.get("date")),
    messageId: normalizeHeader(message.headers.get("message-id")),
    htmlBody: parsed.htmlBody,
    textBody: parsed.textBody,
    htmlSource: parsed.htmlSource,
    rawHeadersJson: getRawHeadersJson(message.headers),
    attachmentCount: parsed.attachmentCount,
    rawSize: message.rawSize,
    parseError: parsed.parseError,
  });

  const headers = new Headers();
  headers.set("X-Original-To", envelopeToEmail);
  if (primaryToEmail) {
    headers.set("X-Indexed-Recipient", primaryToEmail);
  }
  headers.set("X-Processed-By", "icloud-cf-mail-worker");

  await message.forward(adminEmail, headers);
}

export default {
  async email(message, env, ctx) {
    try {
      await handleEmail(message, env, ctx);
    } catch (err) {
      console.error("Email worker error:", err);

      try {
        if (env.ADMIN_EMAIL) {
          await message.forward(env.ADMIN_EMAIL);
          return;
        }
      } catch (forwardErr) {
        console.error("Fallback forward failed:", forwardErr);
      }

      message.setReject("Internal error");
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/mail")) {
      return new Response(renderMailPage(getWorkerUrl(env, url)), {
        headers: PAGE_SECURITY_HEADERS,
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "icloud-cf-mail",
        workerId: getWorkerId(env),
      });
    }

    if (url.pathname === "/logs" || url.pathname === "/messages") {
      const mailQuery = parseQueryableEmailInput(getSearchParamsPreservePlus(url, "mail"));

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: JSON_NO_STORE_HEADERS,
        });
      }

      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: JSON_NO_STORE_HEADERS,
        });
      }

      if (mailQuery.tooMany) {
        return new Response(`Up to ${MAX_QUERY_EMAILS} @icloud.com emails can be queried at once`, {
          status: 400,
          headers: JSON_NO_STORE_HEADERS,
        });
      }

      if (mailQuery.hasInvalid) {
        return new Response("Only @icloud.com email can be queried", {
          status: 400,
          headers: JSON_NO_STORE_HEADERS,
        });
      }

      if (mailQuery.emails.length === 0) {
        return new Response("mail @icloud.com is required", {
          status: 400,
          headers: JSON_NO_STORE_HEADERS,
        });
      }

      const access = validateViewAccess(request, env);

      if (!access.ok) {
        return new Response(access.message, {
          status: access.status,
          headers: JSON_NO_STORE_HEADERS,
        });
      }

      const cursor = decodeLogCursor(url.searchParams.get("cursor"));

      if (!cursor.ok) {
        return new Response("Invalid cursor", {
          status: 400,
          headers: JSON_NO_STORE_HEADERS,
        });
      }

      try {
        const payload = await listMailMessages(env, {
          emails: mailQuery.emails,
          cursor: cursor.cursor,
        });

        return Response.json(payload, {
          headers: JSON_NO_STORE_HEADERS,
        });
      } catch (err) {
        console.error("Read messages failed:", err);

        return Response.json(
          {
            error: "Failed to read messages",
            detail: getErrorMessage(err),
          },
          {
            status: 500,
            headers: JSON_NO_STORE_HEADERS,
          }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
