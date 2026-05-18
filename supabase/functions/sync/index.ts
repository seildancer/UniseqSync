// Uniseq sync service — Supabase Edge Function
// Implements the full HTTP interface described in SYNC_SERVICE.md.
//
// sync_root_url = https://<project-ref>.supabase.co/functions/v1/sync
//
// Storage layout: bucket "uniseq", key = {user_id}/{workspace_id}/{file_path}
// Conflict detection: file_metadata.version (UUID) changes on every accepted write.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BUCKET = 'uniseq'

// ── CORS ──────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': [
    'authorization', 'x-client-info', 'apikey', 'content-type',
    'x-uniseq-base-remote-version',
  ].join(', '),
  'Access-Control-Expose-Headers': 'x-uniseq-remote-version, x-uniseq-updated-at',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  })
}

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}

// Validate and extract the user from the Bearer token.
// Returns the user ID string or a 401 Response.
async function authenticate(req: Request): Promise<string | Response> {
  const h = req.headers.get('Authorization')
  if (!h?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)
  const token = h.slice(7)
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return json({ error: 'Unauthorized' }, 401)
  return user.id
}

// Strip the edge function prefix from the pathname.
// Supabase deployed functions receive /sync/... (gateway strips /functions/v1).
// Local dev via supabase CLI receives /functions/v1/sync/...
function routePath(url: URL): string {
  const p = url.pathname
  for (const prefix of ['/functions/v1/sync', '/sync']) {
    if (p.startsWith(prefix)) return p.slice(prefix.length) || '/'
  }
  return p || '/'
}

// Encode a workspace-relative file path for use as a Supabase Storage key.
// Storage rejects non-ASCII characters even when percent-encoded (it decodes
// before validating). Non-ASCII segments are base64url-encoded instead, which
// produces only [A-Za-z0-9_-] characters that the backend never decodes.
function encodeStoragePath(filePath: string): string {
  return filePath.split('/').map(segment => {
    if (!/[^\x00-\x7F]/.test(segment)) return segment
    const bytes = new TextEncoder().encode(segment)
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }).join('/')
}

// Workspace-relative file paths must be clean, forward-slash separated, no
// empty segments, no dot or dotdot components, no backslashes.
function validFilePath(path: string): boolean {
  if (!path || path.includes('\\')) return false
  if (path.startsWith('/') || path.endsWith('/')) return false
  return path.split('/').every(s => s.length > 0 && s !== '.' && s !== '..')
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleListWorkspaces(db: SupabaseClient, userId: string): Promise<Response> {
  const { data, error } = await db
    .from('workspaces')
    .select('id, name, updated_at')
    .eq('user_id', userId)
    .order('created_at')
  if (error) throw error
  return json(data)
}

async function handleCreateWorkspace(db: SupabaseClient, userId: string, req: Request): Promise<Response> {
  const body = await req.json().catch(() => null)
  if (!body?.name || typeof body.name !== 'string') {
    return json({ error: 'name is required' }, 400)
  }

  // Derive a URL-safe, stable ID from the name.
  let id = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!id) id = crypto.randomUUID().slice(0, 8)

  // Make the ID unique within this user's workspaces if needed.
  const { data: existing } = await db
    .from('workspaces')
    .select('id')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (existing) id = `${id}-${crypto.randomUUID().slice(0, 6)}`

  const { data, error } = await db
    .from('workspaces')
    .insert({ id, user_id: userId, name: body.name })
    .select('id, name, updated_at')
    .single()
  if (error) throw error
  return json(data, 201)
}

async function handleListFiles(db: SupabaseClient, userId: string, workspaceId: string): Promise<Response> {
  const { data, error } = await db
    .from('file_metadata')
    .select('path, version, size, updated_at')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
  if (error) throw error
  return json((data ?? []).map(f => ({
    path: f.path,
    remote_version: f.version,
    size: f.size,
    updated_at: f.updated_at,
  })))
}

async function handlePullFile(
  db: SupabaseClient, userId: string, workspaceId: string, filePath: string,
): Promise<Response> {
  const { data: meta, error: metaErr } = await db
    .from('file_metadata')
    .select('version, updated_at')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('path', filePath)
    .maybeSingle()
  if (metaErr) throw metaErr
  if (!meta) return json({ error: 'File not found' }, 404)

  const storageKey = `${userId}/${workspaceId}/${encodeStoragePath(filePath)}`
  const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(storageKey)
  if (dlErr) throw dlErr

  return new Response(await blob.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Uniseq-Remote-Version': meta.version,
      'X-Uniseq-Updated-At': meta.updated_at,
      ...CORS_HEADERS,
    },
  })
}

async function handlePushFile(
  db: SupabaseClient,
  userId: string,
  workspaceId: string,
  filePath: string,
  req: Request,
): Promise<Response> {
  const baseVersion = req.headers.get('X-Uniseq-Base-Remote-Version')
  const content = await req.arrayBuffer()
  const newVersion = crypto.randomUUID()
  const now = new Date().toISOString()
  const size = content.byteLength

  if (baseVersion === null) {
    // Client has never seen this file on the server — attempt INSERT.
    const { error: insErr } = await db.from('file_metadata').insert({
      user_id: userId, workspace_id: workspaceId, path: filePath,
      version: newVersion, size, updated_at: now,
    })

    if (insErr) {
      if (insErr.code === '23505') {
        // Unique violation: the file already exists — conflict.
        const { data: cur } = await db.from('file_metadata')
          .select('version, size, updated_at')
          .eq('user_id', userId).eq('workspace_id', workspaceId).eq('path', filePath)
          .single()
        return json({
          status: 'conflict',
          current: { path: filePath, remote_version: cur.version, size: cur.size, updated_at: cur.updated_at },
        }, 409)
      }
      throw insErr
    }
  } else {
    // Client knows the current remote version — conditional UPDATE.
    const { data: updated, error: updErr } = await db.from('file_metadata')
      .update({ version: newVersion, size, updated_at: now })
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('path', filePath)
      .eq('version', baseVersion)  // atomic compare-and-set
      .select('id')
    if (updErr) throw updErr

    if (!updated?.length) {
      // Either version mismatch or the file was deleted concurrently.
      const { data: cur } = await db.from('file_metadata')
        .select('version, size, updated_at')
        .eq('user_id', userId).eq('workspace_id', workspaceId).eq('path', filePath)
        .maybeSingle()
      if (!cur) return json({ error: 'File not found' }, 404)
      return json({
        status: 'conflict',
        current: { path: filePath, remote_version: cur.version, size: cur.size, updated_at: cur.updated_at },
      }, 409)
    }
  }

  // DB row committed — now persist content. If this fails the client retries,
  // which re-runs the conditional update against the new version and re-uploads.
  const storageKey = `${userId}/${workspaceId}/${encodeStoragePath(filePath)}`
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(storageKey, content, { upsert: true, contentType: 'application/octet-stream' })
  if (upErr) throw upErr

  return json({ status: 'accepted', remote_version: newVersion, updated_at: now })
}

async function handleDeleteWorkspace(
  db: SupabaseClient, userId: string, workspaceId: string,
): Promise<Response> {
  const { data: ws, error: wsErr } = await db
    .from('workspaces')
    .select('id')
    .eq('user_id', userId)
    .eq('id', workspaceId)
    .maybeSingle()
  if (wsErr) throw wsErr
  if (!ws) return json({ error: 'Workspace not found' }, 404)

  const { data: files, error: listErr } = await db
    .from('file_metadata')
    .select('path')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
  if (listErr) throw listErr

  if (files && files.length > 0) {
    const keys = files.map(f => `${userId}/${workspaceId}/${encodeStoragePath(f.path)}`)
    const { error: rmErr } = await db.storage.from(BUCKET).remove(keys)
    if (rmErr) throw rmErr
  }

  const { error: metaErr } = await db
    .from('file_metadata')
    .delete()
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
  if (metaErr) throw metaErr

  const { error: delErr } = await db
    .from('workspaces')
    .delete()
    .eq('user_id', userId)
    .eq('id', workspaceId)
  if (delErr) throw delErr

  return json({ status: 'deleted' })
}

async function handleDeleteFile(
  db: SupabaseClient,
  userId: string,
  workspaceId: string,
  filePath: string,
  req: Request,
): Promise<Response> {
  // Accept base version from header or JSON body (spec allows either).
  const headerVersion = req.headers.get('X-Uniseq-Base-Remote-Version')
  let baseVersion = headerVersion
  try {
    const body = await req.json()
    baseVersion = body?.base_remote_version ?? headerVersion
  } catch { /* body absent or not JSON — fall back to header */ }

  const { data: cur, error: selErr } = await db.from('file_metadata')
    .select('version, size, updated_at')
    .eq('user_id', userId).eq('workspace_id', workspaceId).eq('path', filePath)
    .maybeSingle()
  if (selErr) throw selErr
  if (!cur) return json({ error: 'File not found' }, 404)

  if (baseVersion && baseVersion !== cur.version) {
    return json({
      status: 'conflict',
      current: { path: filePath, remote_version: cur.version, size: cur.size, updated_at: cur.updated_at },
    }, 409)
  }

  const storageKey = `${userId}/${workspaceId}/${encodeStoragePath(filePath)}`
  const { error: rmErr } = await db.storage.from(BUCKET).remove([storageKey])
  if (rmErr) throw rmErr

  const { error: delErr } = await db.from('file_metadata')
    .delete()
    .eq('user_id', userId).eq('workspace_id', workspaceId).eq('path', filePath)
  if (delErr) throw delErr

  return json({
    status: 'accepted',
    remote_version: crypto.randomUUID(),
    updated_at: new Date().toISOString(),
  })
}

// ── Router ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Preflight
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  const url = new URL(req.url)
  // After stripping the /sync function prefix, paths are /:account/...
  const full = routePath(url)

  // Extract /:account and the rest of the path
  const accountMatch = full.match(/^\/([^/]+)(\/.*)?$/)
  if (!accountMatch) return json({ error: 'Not found' }, 404)

  const account = accountMatch[1]
  const subpath = accountMatch[2] || '/'

  // ── Discovery — unauthenticated, account segment is informational only ───
  if (subpath === '/.well-known/uniseq-sync' && req.method === 'GET') {
    return json({
      version: 1,
      auth: {
        type: 'bearer',
        instructions: 'Sign in to Uniseq and copy your user ID from the account settings. Use your Supabase session access token as the bearer token.',
      },
    })
  }

  // ── All other routes require a valid Supabase JWT ────────────────────────
  const authResult = await authenticate(req)
  if (authResult instanceof Response) return authResult
  const userId = authResult

  // The account segment must match the authenticated user's ID.
  if (account !== userId) return json({ error: 'Forbidden' }, 403)

  const db = admin()

  try {
    // /:account/workspaces
    if (subpath === '/workspaces') {
      if (req.method === 'GET') return await handleListWorkspaces(db, userId)
      if (req.method === 'POST') return await handleCreateWorkspace(db, userId, req)
    }

    // /:account/workspaces/:id
    const wsOnlyMatch = subpath.match(/^\/workspaces\/([^/]+)$/)
    if (wsOnlyMatch) {
      const workspaceId = decodeURIComponent(wsOnlyMatch[1])
      if (req.method === 'DELETE') return await handleDeleteWorkspace(db, userId, workspaceId)
    }

    // /:account/workspaces/:workspaceId/files[/:path]
    const m = subpath.match(/^\/workspaces\/([^/]+)\/files(\/.*)?$/)
    if (m) {
      const workspaceId = decodeURIComponent(m[1])
      const rawFilePart = m[2] ?? ''

      // Verify the workspace belongs to this user.
      const { data: ws, error: wsErr } = await db
        .from('workspaces')
        .select('id')
        .eq('user_id', userId)
        .eq('id', workspaceId)
        .maybeSingle()
      if (wsErr) throw wsErr
      if (!ws) return json({ error: 'Workspace not found' }, 404)

      // /:account/workspaces/:id/files  — list
      if ((!rawFilePart || rawFilePart === '/') && req.method === 'GET') {
        return await handleListFiles(db, userId, workspaceId)
      }

      // /:account/workspaces/:id/files/:path  — pull / push / delete
      if (rawFilePart && rawFilePart !== '/') {
        const filePath = decodeURIComponent(rawFilePart.slice(1)) // strip leading /
        if (!validFilePath(filePath)) return json({ error: 'Invalid file path' }, 400)

        if (req.method === 'GET') return await handlePullFile(db, userId, workspaceId, filePath)
        if (req.method === 'PUT') return await handlePushFile(db, userId, workspaceId, filePath, req)
        if (req.method === 'DELETE') return await handleDeleteFile(db, userId, workspaceId, filePath, req)
      }
    }

    return json({ error: 'Not found' }, 404)

  } catch (err) {
    console.error('[sync]', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
