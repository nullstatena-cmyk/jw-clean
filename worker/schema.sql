-- J.W. Cleaning — D1 schema
-- Every submission lands here first and is only marked 'sent' once the
-- home dashboard confirms it. Nothing is deleted; 'sent' is a flag, not a
-- removal, so the Cloudflare dashboard stays a complete fallback record.

CREATE TABLE IF NOT EXISTS submissions (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('bid', 'review')),
  status      TEXT NOT NULL DEFAULT 'unsent' CHECK (status IN ('unsent', 'sent')),
  received_at TEXT NOT NULL,
  sent_at     TEXT,
  payload     TEXT NOT NULL,
  source_ip   TEXT
);

CREATE INDEX IF NOT EXISTS idx_status   ON submissions (status, received_at);
CREATE INDEX IF NOT EXISTS idx_kind     ON submissions (kind, received_at DESC);

-- Reviews need moderation before they appear on the site. Publishing is a
-- separate decision from receiving, so it gets its own table rather than
-- another status column on the one above.
CREATE TABLE IF NOT EXISTS review_status (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  decided_at    TEXT,
  note          TEXT
);
