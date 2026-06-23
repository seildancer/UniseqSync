<p align="center">
  <img src="promo/uniseq.svg" alt="Uniseq logo" width="120">
</p>

<h1 align="center">UniseqSync</h1>

<p align="center">
  A minimal Supabase-based sync backend for Uniseq.
</p>

UniseqSync implements the HTTP sync contract used by the Uniseq client. It stores workspace files remotely, tracks per-file version tokens for conflict detection, and stays deliberately unaware of note semantics. It does not parse pages, blocks, journals, or Markdown structure. It syncs bytes.

## What It Includes

- a Supabase Edge Function at `supabase/functions/sync/index.ts`
- a PostgreSQL migration at `supabase/migrations/00001_init.sql`
- the compatibility contract in [SYNC_SERVICE.md](SYNC_SERVICE.md)

## Design

The current implementation uses:

- Supabase Auth for bearer-token authentication
- Supabase Postgres for workspace and file metadata
- Supabase Storage for file bytes

Storage keys are organized as:

```text
{user_id}/{workspace_id}/{workspace_relative_path}
```

Each file has an opaque `remote_version` token that changes on every accepted write. The Uniseq client uses that token for compare-and-set sync and conflict detection.

## Repo Layout

```text
supabase/
  functions/
    sync/
      index.ts
  migrations/
    00001_init.sql
SYNC_SERVICE.md
```

## Required Environment

The edge function expects these environment variables:

```env
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

It uses a private storage bucket named `uniseq`.

## Current Auth Model

This backend currently expects:

- a Supabase user session access token as the bearer token
- the account segment in the sync URL to match the authenticated user's ID

In other words, the sync root looks like:

```text
https://<project-ref>.supabase.co/functions/v1/sync/<user_id>
```

Discovery is exposed at:

```text
GET /<user_id>/.well-known/uniseq-sync
```

## API Contract

The full backend contract is documented in [SYNC_SERVICE.md](SYNC_SERVICE.md).

That file is the important reference if you want to:

- run this backend against the current Uniseq client
- build another compatible backend
- change the protocol without breaking client behavior

## Status

UniseqSync is intentionally small and implementation-driven. It is a practical backend for Uniseq's current file sync model, not a general-purpose sync platform.
