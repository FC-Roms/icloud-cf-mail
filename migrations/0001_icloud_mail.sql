CREATE TABLE IF NOT EXISTS mail_messages (
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
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_worker_received
  ON mail_messages(worker_id, received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS mail_message_recipients (
  worker_id TEXT NOT NULL,
  email TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (worker_id, email, message_id)
);
