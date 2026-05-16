-- Workspaces: one per (user, id) pair
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT        NOT NULL,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

-- File metadata: tracks version and size for conflict detection
-- version changes on every accepted write (UUID v4, never reused)
CREATE TABLE IF NOT EXISTS file_metadata (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id TEXT        NOT NULL,
  path         TEXT        NOT NULL,
  version      UUID        NOT NULL DEFAULT gen_random_uuid(),
  size         BIGINT      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, workspace_id, path),
  FOREIGN KEY (user_id, workspace_id) REFERENCES workspaces(user_id, id) ON DELETE CASCADE
);

-- Auto-bump workspaces.updated_at on any update
CREATE OR REPLACE FUNCTION _update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION _update_updated_at();

-- RLS: edge function uses service-role key, so these policies are a
-- defence-in-depth layer rather than the primary enforcement point.
ALTER TABLE workspaces   ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspaces_owner   ON workspaces    USING (user_id = auth.uid());
CREATE POLICY file_metadata_owner ON file_metadata USING (user_id = auth.uid());

-- Storage bucket for file content
-- Object keys: {user_id}/{workspace_id}/{workspace_relative_path}
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('uniseq', 'uniseq', false, null, null)
ON CONFLICT (id) DO NOTHING;
