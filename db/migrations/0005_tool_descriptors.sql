-- 0005_tool_descriptors.sql — the metadata a model needs to call a tool correctly (MCP).
--
-- tool_credentials already says where a tool lives and how to authenticate to it. That is everything
-- the gate needs and nothing a MODEL needs: an agent connecting over MCP is handed a list of tools
-- and has to decide which to call and with what arguments. Without a title, a description and an
-- input schema it is guessing, and a guessed argument is a denied call at best.
--
-- Nullable on purpose. A tool registered before this migration, or by an operator who only cares
-- about the HTTP side, still works for /v1/proxy — it simply does not appear over MCP, because
-- advertising a tool a model cannot call correctly is worse than not advertising it.

ALTER TABLE tool_credentials ADD COLUMN title        text;
ALTER TABLE tool_credentials ADD COLUMN description  text;
-- JSON Schema (draft 2020-12) for the tool's arguments, exactly as MCP's inputSchema expects it.
-- Stored as given: the gate does not interpret it, it forwards it.
ALTER TABLE tool_credentials ADD COLUMN input_schema jsonb;
