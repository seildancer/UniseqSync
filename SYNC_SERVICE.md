# Uniseq Sync Service Interface

This document describes the HTTP interface a sync service must implement for Uniseq.

Uniseq is still a file-first app. The client writes normal workspace files locally, scans the workspace in the background, and syncs file bytes against a remote service. The sync service does not need to understand pages, blocks, references, journals, or editor semantics.

## Model

The service is rooted at an account or namespace URL:

```text
https://sync.example.com/johndoe
```

Under that root, the service exposes one or more remote workspaces:

```text
https://sync.example.com/johndoe/workspaces/personal
https://sync.example.com/johndoe/workspaces/research
```

The app stores this identity in `uniseq/sync-config.json` inside the local workspace:

```json
{
  "enabled": true,
  "provider": "custom",
  "sync_root_url": "https://sync.example.com/johndoe",
  "remote_workspace_id": "personal",
  "remote_workspace_name": "Personal",
  "auth": {
    "kind": "bearer"
  }
}
```

`remote_workspace_id` is the stable server-side identifier. It should be URL-safe and should not change when a workspace is renamed. `remote_workspace_name` is display text.

`uniseq/sync-config.json`, `uniseq/sync-auth.json`, and `uniseq/sync-state.json` are local client files. The Uniseq client excludes them from file sync. The bearer token, when present, is stored in `uniseq/sync-auth.json` and is never uploaded by the sync scanner.

## Service Discovery

Before listing workspaces, the client checks the account root for a discovery document:

```http
GET {sync_root_url}/.well-known/uniseq-sync
```

Unauthenticated services can return:

```json
{
  "version": 1,
  "auth": {
    "type": "none"
  }
}
```

Authenticated services should return:

```json
{
  "version": 1,
  "auth": {
    "type": "bearer",
    "login_url": "https://sync.example.com/johndoe/auth/login",
    "token_url": "https://sync.example.com/johndoe/auth/token",
    "instructions": "Sign in, create an access token, and paste it into Uniseq."
  }
}
```

`login_url`, `token_url`, and `instructions` are optional. The current client uses `login_url` as an external link and asks the user to paste a bearer token manually. Later clients may use `token_url` for a browser callback, device-code flow, or refresh flow.

For compatibility, a missing discovery endpoint (`404 Not Found`), an empty response body, or a JSON `null` response is treated as:

```json
{
  "version": 1,
  "auth": {
    "type": "none"
  }
}
```

Do not return a secret token from discovery. Discovery only tells the client how the service wants to authenticate.

## Auth

If discovery returns `"type": "bearer"`, the client sends the user-provided token on every workspace and file request:

```http
Authorization: Bearer <token>
```

This applies to:

- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/{workspace_id}/files`
- `GET /workspaces/{workspace_id}/files/{path}`
- `PUT /workspaces/{workspace_id}/files/{path}`
- `DELETE /workspaces/{workspace_id}/files/{path}`

Recommended status codes:

- `401 Unauthorized` when a token is missing, expired, malformed, or otherwise invalid.
- `403 Forbidden` when the token is valid but does not have access to the account root or workspace.

The token format is up to the service. A Supabase-backed service can validate a Supabase JWT, validate an opaque token stored server-side, or validate a signed token issued by the sync service. The client treats the token as an opaque string.

## Workspace Endpoints

### List Workspaces

```http
GET {sync_root_url}/workspaces
```

Response:

```json
[
  {
    "id": "personal",
    "name": "Personal",
    "updated_at": "2026-05-16T12:00:00Z"
  }
]
```

`updated_at` is optional.

### Create Workspace

```http
POST {sync_root_url}/workspaces
Content-Type: application/json

{
  "name": "Personal"
}
```

Response:

```json
{
  "id": "personal",
  "name": "Personal",
  "updated_at": "2026-05-16T12:00:00Z"
}
```

If the requested name cannot be used as the ID, the server should generate a stable ID and return it.

## File Paths

All file paths are workspace-relative paths using `/` separators:

```text
pages/A.md
journals/2026_05_16.md
assets/photo.jpg
uniseq/page-order.json
```

The client percent-encodes path segments in URLs. A file path like:

```text
pages/My Note.md
```

is requested as:

```text
.../files/pages/My%20Note.md
```

Reject paths containing empty segments, `.`, `..`, or backslashes.

The service should store and sync all normal workspace files. The client intentionally does not sync local runtime state such as `uniseq/sync-state.json`, page transaction folders, or temporary transaction files.

## File Metadata

Every remote file must expose an opaque version string:

```json
{
  "path": "pages/A.md",
  "remote_version": "etag-or-version-123",
  "size": 42,
  "updated_at": "2026-05-16T12:00:00Z"
}
```

`remote_version` is required. It must change whenever the remote file content changes. It can be a storage ETag, object generation, revision ID, incrementing version, or another stable opaque value.

Do not rely on client-side modified times for correctness.

## File Endpoints

All file endpoints live under:

```text
{sync_root_url}/workspaces/{workspace_id}/files
```

### List Files

```http
GET {sync_root_url}/workspaces/{workspace_id}/files
```

Response:

```json
[
  {
    "path": "pages/A.md",
    "remote_version": "v1",
    "size": 12,
    "updated_at": "2026-05-16T12:00:00Z"
  }
]
```

Return all currently existing files in the remote workspace. Deleted files do not need to appear in this MVP.

### Pull File

```http
GET {sync_root_url}/workspaces/{workspace_id}/files/{path}
```

Preferred response is raw file bytes with metadata headers:

```http
200 OK
Content-Type: application/octet-stream
X-Uniseq-Remote-Version: v1
X-Uniseq-Updated-At: 2026-05-16T12:00:00Z

<file bytes>
```

`X-Uniseq-Remote-Version` is required for raw byte responses. `X-Uniseq-Updated-At` is optional.

The current client can also accept a JSON response:

```json
{
  "path": "pages/A.md",
  "remote_version": "v1",
  "size": 12,
  "updated_at": "2026-05-16T12:00:00Z",
  "content": [35, 32, 72, 101, 108, 108, 111]
}
```

Raw bytes are recommended.

### Push File

```http
PUT {sync_root_url}/workspaces/{workspace_id}/files/{path}
X-Uniseq-Base-Remote-Version: v1
Content-Type: application/octet-stream

<file bytes>
```

`X-Uniseq-Base-Remote-Version` is optional. It is omitted when the client is creating a file that it has never seen on the server.

The server should accept the write when:

- the file does not exist and no base version was supplied, or
- the file exists and the supplied base version matches the current remote version.

Accepted response:

```json
{
  "status": "accepted",
  "remote_version": "v2",
  "updated_at": "2026-05-16T12:01:00Z"
}
```

Conflict response:

```http
409 Conflict
Content-Type: application/json

{
  "status": "conflict",
  "current": {
    "path": "pages/A.md",
    "remote_version": "v3",
    "size": 18,
    "updated_at": "2026-05-16T12:02:00Z"
  }
}
```

The client will show the user a local-vs-remote conflict UI.

### Delete File

```http
DELETE {sync_root_url}/workspaces/{workspace_id}/files/{path}
X-Uniseq-Base-Remote-Version: v1
Content-Type: application/json

{
  "base_remote_version": "v1"
}
```

The client sends the base version both as a header and JSON body for backend convenience. A service may use either.

Accepted and conflict responses use the same shape as `PUT`.

## Conflict Rules

The service only needs compare-and-set behavior:

1. Read the current remote version for the path.
2. Compare it with the supplied base version.
3. If they match, write/delete and return a new `remote_version`.
4. If they do not match, return `409 Conflict` with current metadata.

The service does not need to merge Markdown. The app handles conflicts by letting the user choose local or remote content.

## Status Codes

Recommended status codes:

- `200 OK` for successful list, pull, push, delete, and create responses with JSON bodies.
- `201 Created` for created workspaces or files.
- `204 No Content` is tolerated for accepted push/delete, but JSON with the new `remote_version` is strongly preferred.
- `400 Bad Request` for invalid paths or invalid payloads.
- `404 Not Found` for missing workspace or file.
- `409 Conflict` for version mismatches.
- `500` or `503` for server/storage failures.

## Minimal Supabase Storage Mapping

A simple Supabase Storage implementation can use:

```text
bucket: uniseq
object key: {account_id}/{workspace_id}/{workspace_relative_path}
```

Use object metadata, ETag, generation, or a custom metadata field as `remote_version`. The only strict requirement is that it changes on every accepted write.

You can implement `GET /workspaces` and `POST /workspaces` with a small metadata file if you do not want a database yet, for example:

```text
{account_id}/workspaces.json
```

A database table becomes useful later for auth, sharing, billing, workspace rename/delete, and tombstones, but it is not required for the MVP interface.

For bearer auth without a full database, a minimal service can:

- use Supabase Auth JWTs and derive `account_id` from the authenticated user, or
- store hashed access tokens in a small metadata file outside the synced workspace object prefix.

Never expose Supabase service-role keys to the Uniseq client.
