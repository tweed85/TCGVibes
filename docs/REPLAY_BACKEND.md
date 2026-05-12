# Cloud replay backend (Supabase)

Setup recipe for the cloud-aggregation backend that receives opt-in replay
uploads from the TCGVibes client. Replay capture and the determinism
contract are documented in [REPLAY.md](REPLAY.md); this file covers the
human-deploy half.

## What this is for

Phase D of the cloud-replay plan ships an opt-in pipeline that uploads
completed games to a shared Supabase project. The corpus exists so the AI
can later be trained / tuned against real human play (see Phase E in the
plan: state-fingerprint → move frequency tables that plug into
`src/engine/aiArchetype.ts` before the existing greedy loop).

The client side is `src/data/replayUpload.ts` (lazy-loaded so the
`@supabase/supabase-js` dep doesn't land in the boot bundle).

## One-time setup

1. **Create a Supabase project** at https://supabase.com (free tier is
   plenty for hobby volume — single-row inserts of <10KB JSON, no realtime,
   no auth).
2. **Apply the migration** at
   [`supabase/migrations/0001_replays.sql`](../supabase/migrations/0001_replays.sql).
   Either:
   - Paste the SQL into the SQL editor on the Supabase Dashboard and run it.
   - Or use the Supabase CLI: `supabase db push` from the repo root after
     `supabase link --project-ref YOUR-PROJECT`.
3. **Copy your project URL and anon key** from Project Settings → API.
4. **Configure env vars** for the client:
   ```bash
   cp .env.example .env.local
   # edit .env.local with your URL + anon key
   ```
   `.env.local` is gitignored. The Vite dev server picks up env vars on
   restart; for production builds, the same vars must be in the build
   environment.

The dev cycle is: edit code, `npm run dev`, end a game with cloud upload
toggled on, watch the row appear in the Supabase Dashboard's table editor.

## Schema

```sql
create table replays (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,                -- anonymous device id
  schema_version int not null,            -- pinned to 2 by CHECK constraint
  app_version text not null,
  data_version text not null,
  created_at timestamptz not null,
  completed_at timestamptz,
  winner text,                            -- 'p1' | 'p2' | NULL (draw / aborted)
  game_mode text not null,                -- 'vsCPU' | 'local'
  p1_archetype text,                      -- best-effort, nullable
  p2_archetype text,
  turn_count int,
  replay jsonb not null                   -- the full GameReplayV2
);
```

CHECK constraints enforce `schema_version = 2`, valid winner / game_mode,
and a 200KB JSONB size cap. The RLS policy applies the same checks at the
insert boundary. See the migration file for the canonical definition.

## Privacy and what's NOT in the schema

- No name, email, IP address, sign-in token. No auth in v1.
- The `client_id` is a UUID generated once on the user's device
  (`localStorage["tcgvibes.clientId.v1"]`) and lost on reinstall — by design.
- Decklists are stored as **card IDs**, not deck names. The recorder
  schema has no field for a custom deck label.
- Local-side deletion does NOT propagate to the cloud. To remove a row a
  user emails and you delete it manually:
  ```sql
  delete from replays where id = 'THE-ROW-UUID';
  ```
  A self-serve deletion-token flow is documented as a Phase E follow-up.

## Querying the corpus (offline ETL)

Anon clients cannot SELECT — only inserts. Pull the corpus via the
service-role key (Project Settings → API → `service_role`). The
service-role key is **server-only**: never bundle it into the client.

Example offline pull (Node script):

```ts
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
const { data } = await sb
  .from("replays")
  .select("*")
  .gt("created_at", "2026-05-01")
  .eq("game_mode", "vsCPU")
  .not("winner", "is", null);
// `data` is the corpus slice; feed into your ETL.
```

Phase E of the plan describes the AI-training side — building
state-fingerprint → move frequency tables and plugging them into
`src/engine/aiArchetype.ts` as a lookup before the existing greedy step.

## Manual smoke verification

After config is in place:

1. Toggle cloud upload ON in the Game menu (consent modal must appear; click
   "I understand").
2. Start a game vs CPU and play it to a winner.
3. Open the Supabase Dashboard → Table Editor → `replays`. The new row
   should have the expected `winner`, `game_mode`, `replay` JSON.
4. From a different browser tab or via the Supabase JS client with the
   anon key, attempt `select` on `replays` — should return 0 rows (RLS
   blocks anon SELECT). This proves the policy is correct.
5. Toggle cloud upload OFF, end another game, confirm no row appears.

## Cost / scale

The free tier (500MB DB, 5GB egress, 50K rows/month) covers a small hobby
corpus. At ~5KB per replay JSONB, 50K rows is ~250MB raw — well under the
free DB cap. If volume grows past the free tier, add a daily archive job
that exports older rows to S3/R2 and trims the live table.
