import assert from "node:assert/strict";
import worker from "../worker.js";

function makeDb(seedMessages = []) {
  const messages = new Map();
  const recipients = new Map();

  function recipientKey(workerId, email) {
    return `${workerId}::${email}`;
  }

  function insertRecipient(workerId, email, messageId) {
    const key = recipientKey(workerId, email);

    if (!recipients.has(key)) recipients.set(key, new Set());
    recipients.get(key).add(messageId);
  }

  function insertMessage(entry) {
    messages.set(entry.id, entry);

    for (const email of entry.recipientEmails) {
      insertRecipient(entry.workerId, email, entry.id);
    }
  }

  for (const entry of seedMessages) {
    insertMessage(entry);
  }

  function sortByNewest(a, b) {
    if (a.receivedAt !== b.receivedAt) {
      return b.receivedAt.localeCompare(a.receivedAt);
    }

    return b.id.localeCompare(a.id);
  }

  function toRow(entry) {
    return {
      id: entry.id,
      workerId: entry.workerId,
      envelopeToEmail: entry.envelopeToEmail,
      primaryToEmail: entry.primaryToEmail,
      recipientEmailsJson: JSON.stringify(entry.recipientEmails),
      toHeader: entry.toHeader,
      fromEmail: entry.fromEmail,
      fromName: entry.fromName,
      fromHeader: entry.fromHeader,
      replyToEmail: entry.replyToEmail,
      replyToHeader: entry.replyToHeader,
      subject: entry.subject,
      date: entry.date,
      messageId: entry.messageId,
      htmlBody: entry.htmlBody,
      textBody: entry.textBody,
      htmlSource: entry.htmlSource,
      rawHeadersJson: JSON.stringify(entry.rawHeaders),
      attachmentCount: entry.attachmentCount,
      rawSize: entry.rawSize,
      parseError: entry.parseError,
      receivedAt: entry.receivedAt,
    };
  }

  return {
    prepare(query) {
      const sql = query.replace(/\s+/g, " ").trim().toLowerCase();
      let params = [];

      const statement = {
        bind(...values) {
          params = values;
          return statement;
        },

        async run() {
          if (sql.startsWith("insert into mail_messages")) {
            const [
              id,
              workerId,
              envelopeToEmail,
              primaryToEmail,
              recipientEmailsJson,
              toHeader,
              fromEmail,
              fromName,
              fromHeader,
              replyToEmail,
              replyToHeader,
              subject,
              date,
              messageId,
              htmlBody,
              textBody,
              htmlSource,
              rawHeadersJson,
              attachmentCount,
              rawSize,
              parseError,
              receivedAt,
            ] = params;

            insertMessage({
              id,
              workerId,
              envelopeToEmail,
              primaryToEmail,
              recipientEmails: JSON.parse(recipientEmailsJson),
              toHeader,
              fromEmail,
              fromName,
              fromHeader,
              replyToEmail,
              replyToHeader,
              subject,
              date,
              messageId,
              htmlBody,
              textBody,
              htmlSource,
              rawHeaders: JSON.parse(rawHeadersJson),
              attachmentCount,
              rawSize,
              parseError,
              receivedAt,
            });

            return { success: true };
          }

          if (sql.startsWith("insert or ignore into mail_message_recipients")) {
            const [workerId, email, messageId] = params;
            insertRecipient(workerId, email, messageId);
            return { success: true };
          }

          return { success: true };
        },

        async all() {
          if (!sql.includes("from mail_messages m")) {
            return { results: [] };
          }

          const mailFilterMatch = sql.match(/and r\.email in \(([^)]+)\)/);
          const hasCursor = sql.includes("m.received_at < ?");
          let index = 0;
          const workerId = params[index++];
          const mailFilterCount = mailFilterMatch ? (mailFilterMatch[1].match(/\?/g) || []).length : 0;
          const mailFilters =
            mailFilterCount > 0 ? params.slice(index, index + mailFilterCount) : [];
          index += mailFilterCount;
          let cursor = null;

          if (hasCursor) {
            cursor = {
              receivedAt: params[index++],
              receivedAtEqual: params[index++],
              id: params[index++],
            };
          }

          const limit = Number(params[index++]);
          let entries = [...messages.values()].filter(
            (entry) => entry.workerId === workerId
          );

          if (mailFilters.length > 0) {
            const matchedIds = new Set();

            for (const mailFilter of mailFilters) {
              const key = recipientKey(workerId, mailFilter);

              for (const id of recipients.get(key) || []) {
                matchedIds.add(id);
              }
            }

            entries = entries.filter((entry) => matchedIds.has(entry.id));
          }

          if (cursor) {
            entries = entries.filter(
              (entry) =>
                entry.receivedAt < cursor.receivedAt ||
                (entry.receivedAt === cursor.receivedAtEqual && entry.id < cursor.id)
            );
          }

          entries.sort(sortByNewest);

          return {
            results: entries.slice(0, limit).map(toRow),
          };
        },
      };

      return statement;
    },
  };
}

function isoAt(minute, hour = 10) {
  return `2026-05-17T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

function buildSeed(id, recipient, minute) {
  return {
    id,
    workerId: "icloud-cf-mail",
    envelopeToEmail: "route@linhtd.com",
    primaryToEmail: recipient,
    recipientEmails: [recipient],
    toHeader: `Hide My Email <${recipient}>`,
    fromEmail: "sender@example.com",
    fromName: "Sender",
    fromHeader: "Sender <sender@example.com>",
    replyToEmail: "",
    replyToHeader: "",
    subject: `Seed ${id}`,
    date: "Sun, 17 May 2026 10:00:00 +0000",
    messageId: `<${id}@example.com>`,
    htmlBody: `<!doctype html><html><body><p>${id}</p></body></html>`,
    textBody: id,
    htmlSource: "text/html",
    rawHeaders: [],
    attachmentCount: 0,
    rawSize: 1000,
    parseError: "",
    receivedAt: isoAt(minute),
  };
}

async function readJson(path, env, { token = env.VIEW_TOKEN } = {}) {
  const headers = new Headers();

  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const response = await worker.fetch(
    new Request(`https://example.com${path}`, { headers }),
    env
  );

  return {
    response,
    body: response.headers.get("content-type")?.includes("json")
      ? await response.json()
      : await response.text(),
  };
}

{
  const env = {
    MAIL_DB: makeDb(),
    WORKER_URL: "https://icloud-cf-mail.example.workers.dev",
  };
  const { response, body } = await readJson("/", env);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(body, /iCloud Mail/);
  assert.match(body, /const LOGS_URL/);
  assert.match(body, /<textarea data-mail-input/);
}

{
  const env = {
    MAIL_DB: makeDb(),
  };
  const { response, body } = await readJson("/logs", env);

  assert.equal(response.status, 400);
  assert.equal(body, "mail @icloud.com is required");
}

{
  const env = {
    ADMIN_EMAIL: "archive@icloud.com",
    VIEW_TOKEN: "test-view-token",
    MAIL_DB: makeDb(),
  };
  const raw = [
    "From: OpenAI <noreply_at_tm_openai_com_pwq38d878c8d9g_vb0z2280@icloud.com>",
    "Reply-To: noreply_at_tm_openai_com_pwq38d878c8d9g_vb0z2280@icloud.com",
    "To: Hide My Email <farrago.mull-1u@icloud.com>",
    "Subject: A new security key or passkey was added to your account",
    "Date: Sun, 17 May 2026 13:38:00 +0700",
    "Message-ID: <openai-passkey@example.com>",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<!doctype html><html><body><h1>Security alert</h1><p>A passkey was added.</p></body></html>",
  ].join("\r\n");
  let forwardedTo = "";
  let forwardedHeaders;
  let rejectReason = "";

  await worker.email(
    {
      to: "route@linhtd.com",
      from: "bounce@linhtd.com",
      headers: new Headers({
        from: "OpenAI <noreply_at_tm_openai_com_pwq38d878c8d9g_vb0z2280@icloud.com>",
        "reply-to": "noreply_at_tm_openai_com_pwq38d878c8d9g_vb0z2280@icloud.com",
        to: "Hide My Email <farrago.mull-1u@icloud.com>",
        subject: "A new security key or passkey was added to your account",
        date: "Sun, 17 May 2026 13:38:00 +0700",
        "message-id": "<openai-passkey@example.com>",
      }),
      raw,
      rawSize: raw.length,
      async forward(to, headers) {
        forwardedTo = to;
        forwardedHeaders = headers;
      },
      setReject(reason) {
        rejectReason = reason;
      },
    },
    env
  );

  assert.equal(rejectReason, "");
  assert.equal(forwardedTo, "archive@icloud.com");
  assert.equal(forwardedHeaders.get("X-Original-To"), "route@linhtd.com");
  assert.equal(forwardedHeaders.get("X-Indexed-Recipient"), "farrago.mull-1u@icloud.com");

  const byAlias = await readJson("/logs?mail=farrago.mull-1u@icloud.com", env);
  assert.equal(byAlias.response.status, 200);
  assert.equal(byAlias.body.messages.length, 1);
  assert.deepEqual(Object.keys(byAlias.body.messages[0]).sort(), [
    "date",
    "htmlBody",
    "id",
    "receivedAt",
    "subject",
  ]);
  assert.equal(byAlias.body.messages[0].primaryToEmail, undefined);
  assert.equal(byAlias.body.messages[0].recipientEmails, undefined);
  assert.equal(byAlias.body.messages[0].fromEmail, undefined);
  assert.equal(byAlias.body.messages[0].fromHeader, undefined);
  assert.equal(byAlias.body.messages[0].replyToEmail, undefined);
  assert.equal(byAlias.body.messages[0].toHeader, undefined);
  assert.equal(byAlias.body.messages[0].envelopeToEmail, undefined);
  assert.equal(byAlias.body.messages[0].messageId, undefined);
  assert.equal(byAlias.body.messages[0].rawSize, undefined);
  assert.equal(byAlias.body.messages[0].htmlSource, undefined);
  assert.equal(byAlias.body.messages[0].attachmentCount, undefined);
  assert.match(byAlias.body.messages[0].htmlBody, /Security alert/);

  const bySender = await readJson(
    "/logs?mail=noreply_at_tm_openai_com_pwq38d878c8d9g_vb0z2280@icloud.com",
    env
  );
  assert.equal(bySender.response.status, 200);
  assert.equal(bySender.body.messages.length, 0);

  const byEnvelope = await readJson("/logs?mail=route@linhtd.com", env);
  assert.equal(byEnvelope.response.status, 400);
  assert.equal(byEnvelope.body, "Only @icloud.com email can be queried");

  const withoutToken = await readJson("/logs?mail=farrago.mull-1u@icloud.com", env, {
    token: "",
  });
  assert.equal(withoutToken.response.status, 401);
  assert.equal(withoutToken.body, "Unauthorized");
}

{
  const env = {
    ADMIN_EMAIL: "archive@icloud.com",
    VIEW_TOKEN: "test-view-token",
    MAIL_DB: makeDb(),
  };
  const raw = [
    "From: sender@example.com",
    "To: Hide My Email <user+tag@icloud.com>",
    "Subject: Plus tag",
    "Date: Sun, 17 May 2026 13:39:00 +0700",
    "Message-ID: <plus@example.com>",
    "",
    "Plus body",
  ].join("\r\n");

  await worker.email(
    {
      to: "route@linhtd.com",
      from: "sender@example.com",
      headers: new Headers({
        from: "sender@example.com",
        to: "Hide My Email <user+tag@icloud.com>",
        subject: "Plus tag",
        date: "Sun, 17 May 2026 13:39:00 +0700",
        "message-id": "<plus@example.com>",
      }),
      raw,
      rawSize: raw.length,
      async forward() {},
      setReject(reason) {
        throw new Error(reason);
      },
    },
    env
  );

  const result = await readJson("/logs?mail=user+tag@icloud.com", env);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.messages.length, 1);
  assert.equal(result.body.messages[0].primaryToEmail, undefined);
  assert.match(result.body.messages[0].htmlBody, /Plus body/);
}

{
  const seed = [];

  for (let i = 0; i < 13; i++) {
    seed.push(buildSeed(`page-${String(i + 1).padStart(2, "0")}`, "page@icloud.com", 59 - i));
  }

  const env = {
    MAIL_DB: makeDb(seed),
    VIEW_TOKEN: "test-view-token",
  };
  const first = await readJson("/logs?mail=page@icloud.com", env);

  assert.equal(first.response.status, 200);
  assert.equal(first.body.messages.length, 10);
  assert.equal(first.body.pagination.hasMore, true);
  assert.equal(typeof first.body.pagination.nextCursor, "string");

  const second = await readJson(
    `/logs?mail=page@icloud.com&cursor=${first.body.pagination.nextCursor}`,
    env
  );

  assert.equal(second.response.status, 200);
  assert.deepEqual(second.body.messages.map((item) => item.id), [
    "page-11",
    "page-12",
    "page-13",
  ]);
  assert.equal(second.body.pagination.hasMore, false);
}

{
  const env = {
    MAIL_DB: makeDb([
      {
        ...buildSeed("multi-both", "alpha@icloud.com", 59),
        recipientEmails: ["alpha@icloud.com", "beta@icloud.com"],
        toHeader: "Hide My Email <alpha@icloud.com>, Hide My Email <beta@icloud.com>",
      },
      buildSeed("multi-alpha", "alpha@icloud.com", 58),
      buildSeed("multi-beta", "beta@icloud.com", 57),
      buildSeed("multi-other", "other@icloud.com", 56),
    ]),
    VIEW_TOKEN: "test-view-token",
  };
  const result = await readJson("/logs?mail=alpha@icloud.com&mail=beta@icloud.com", env);

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.messages.map((item) => item.id), [
    "multi-both",
    "multi-alpha",
    "multi-beta",
  ]);
  assert.deepEqual(result.body.messages[0].matchedEmails, [
    "alpha@icloud.com",
    "beta@icloud.com",
  ]);
  assert.deepEqual(result.body.messages[1].matchedEmails, ["alpha@icloud.com"]);
  assert.deepEqual(result.body.messages[2].matchedEmails, ["beta@icloud.com"]);

  const sameResultViaTextareaStyleInput = await readJson(
    "/logs?mail=alpha@icloud.com%0Abeta@icloud.com",
    env
  );

  assert.equal(sameResultViaTextareaStyleInput.response.status, 200);
  assert.deepEqual(
    sameResultViaTextareaStyleInput.body.messages.map((item) => item.id),
    ["multi-both", "multi-alpha", "multi-beta"]
  );
}

{
  const env = {
    MAIL_DB: makeDb([
      buildSeed("plus-batch", "user+tag@icloud.com", 59),
      buildSeed("plain-batch", "page@icloud.com", 58),
    ]),
    VIEW_TOKEN: "test-view-token",
  };
  const result = await readJson("/logs?mail=user+tag@icloud.com,page@icloud.com", env);

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.messages.map((item) => item.id), [
    "plus-batch",
    "plain-batch",
  ]);
}

{
  const env = {
    MAIL_DB: makeDb([buildSeed("safe", "safe@icloud.com", 59)]),
    VIEW_TOKEN: "test-view-token",
  };
  const result = await readJson(
    "/logs?mail=safe@icloud.com&mail=evil%40icloud.com%27)%20OR%201%3D1--",
    env
  );

  assert.equal(result.response.status, 400);
  assert.equal(result.body, "Only @icloud.com email can be queried");
}

{
  const env = {
    MAIL_DB: makeDb(),
    VIEW_TOKEN: "change-this-view-token",
  };
  const result = await readJson("/logs?mail=farrago.mull-1u@icloud.com", env, {
    token: "change-this-view-token",
  });

  assert.equal(result.response.status, 503);
  assert.equal(result.body, "VIEW_TOKEN secret is not configured");
}

console.log("worker tests passed");
