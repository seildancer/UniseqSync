-- Tables
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT        NOT NULL,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

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

-- Auto-bump updated_at on workspaces
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE OR REPLACE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS (defence-in-depth; service_role bypasses it anyway)
ALTER TABLE workspaces    ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner" ON workspaces    FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "owner" ON file_metadata FOR ALL USING (auth.uid() = user_id);

-- Grants for the service_role used by the edge function
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspaces    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.file_metadata TO service_role;

-- Storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('uniseq', 'uniseq', false)
ON CONFLICT (id) DO NOTHING;
