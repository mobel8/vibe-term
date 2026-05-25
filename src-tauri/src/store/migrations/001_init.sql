-- Migration 001: initial schema
-- Mirrors section D of the implementation plan (sessions, blocks, images,
-- block_images, ai_conversations, ai_exchanges + indexes).

BEGIN;

-- A `session` is a logical workspace: one open tab in the UI maps to one row.
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- A `block` is a unit of terminal history (command, output chunk, AI message…).
-- `sequence` is monotonically increasing per session to preserve order even
-- when `created_at` collides on millisecond boundaries.
CREATE TABLE IF NOT EXISTS blocks (
    id          TEXT    PRIMARY KEY,
    session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pty_id      TEXT,
    kind        TEXT    NOT NULL, -- 'command' | 'output' | 'ai_user' | 'ai_assistant' | 'system'
    content     TEXT    NOT NULL,
    ansi_raw    BLOB,
    exit_code   INTEGER,
    duration_ms INTEGER,
    created_at  INTEGER NOT NULL,
    sequence    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_blocks_created ON blocks(created_at);

-- An `image` is a deduplicated blob on disk (sha256 unique).
CREATE TABLE IF NOT EXISTS images (
    id         TEXT    PRIMARY KEY,                -- e.g. img_xxxxxx
    sha256     TEXT    NOT NULL UNIQUE,            -- dedup key
    path       TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,
    source     TEXT    NOT NULL,                   -- 'clipboard' | 'screenshot' | 'drop' | 'terminal'
    ocr_text   TEXT,                               -- populated lazily
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);

-- Many-to-many between blocks and images, with display order.
CREATE TABLE IF NOT EXISTS block_images (
    block_id TEXT    NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    image_id TEXT    NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (block_id, image_id)
);

CREATE INDEX IF NOT EXISTS idx_block_images_image ON block_images(image_id);

-- AI conversations are scoped to a session (one tab = one conversation by default).
CREATE TABLE IF NOT EXISTS ai_conversations (
    id         TEXT    PRIMARY KEY,
    session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title      TEXT,
    model      TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_conv_session ON ai_conversations(session_id, created_at);

-- One exchange = one role-tagged message in a conversation.
-- `content_json` is the full multimodal payload (text + image refs) serialized.
CREATE TABLE IF NOT EXISTS ai_exchanges (
    id              TEXT    PRIMARY KEY,
    conversation_id TEXT    NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL,             -- 'user' | 'assistant' | 'system'
    content_json    TEXT    NOT NULL,
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    created_at      INTEGER NOT NULL,
    sequence        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exch_conv ON ai_exchanges(conversation_id, sequence);

COMMIT;
