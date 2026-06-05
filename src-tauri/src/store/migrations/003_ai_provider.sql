-- Persist the AI provider per conversation.
--
-- Previously only `model` was stored and the provider was re-inferred from the
-- model id on restore. That heuristic is ambiguous (e.g. several llama/qwen ids
-- are offered by both Groq and Cerebras), so a restored conversation could come
-- back on the wrong provider and route a continuation to the wrong API/key.
-- Storing the provider removes the guesswork; legacy rows default to anthropic,
-- which is the only provider that existed before this column.
BEGIN;
ALTER TABLE ai_conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic';
COMMIT;
