-- Migration 002: FTS5 virtual tables + triggers
--
-- We use the "external content" FTS5 pattern (`content='blocks'` /
-- `content='images'`) so the index stays in sync with the canonical table
-- without duplicating the payload. Triggers keep the index up-to-date on
-- INSERT / UPDATE / DELETE.

BEGIN;

-- Full-text index over block content. `porter` stemming + `unicode61`
-- tokenizer handles accents and basic English inflections well.
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    content,
    content='blocks',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Sync triggers for blocks_fts.
CREATE TRIGGER IF NOT EXISTS blocks_ai AFTER INSERT ON blocks BEGIN
    INSERT INTO blocks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS blocks_ad AFTER DELETE ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS blocks_au AFTER UPDATE ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO blocks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Full-text index over OCR text extracted from images.
CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
    ocr_text,
    content='images',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Sync triggers for images_fts. We only index rows that have non-NULL
-- ocr_text — the index entry is inserted/refreshed lazily once OCR runs.
CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images
WHEN new.ocr_text IS NOT NULL BEGIN
    INSERT INTO images_fts(rowid, ocr_text) VALUES (new.rowid, new.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images
WHEN old.ocr_text IS NOT NULL BEGIN
    INSERT INTO images_fts(images_fts, rowid, ocr_text) VALUES('delete', old.rowid, old.ocr_text);
END;

CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE ON images BEGIN
    -- Remove stale entry if there was one.
    INSERT INTO images_fts(images_fts, rowid, ocr_text)
        SELECT 'delete', old.rowid, old.ocr_text WHERE old.ocr_text IS NOT NULL;
    -- Insert refreshed entry if the new row has OCR text.
    INSERT INTO images_fts(rowid, ocr_text)
        SELECT new.rowid, new.ocr_text WHERE new.ocr_text IS NOT NULL;
END;

COMMIT;
