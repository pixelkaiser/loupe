# ExecPlans

Plans as first-class, versioned artifacts: complex work gets a checked-in
**execution plan** with a progress log and a decision log, so any agent or
human can pick the work up mid-flight and know why it looks the way it does.
Known technical debt lives co-located in [debt.md](debt.md).

## When to write one

Write an ExecPlan when the work is **complex**: multiple sessions, multiple
packages, a behavior change others depend on, or a decision worth recording.
For small changes, skip the ceremony — plan ephemerally in the conversation
and just make the change.

## Lifecycle

1. **Open** — copy [TEMPLATE.md](TEMPLATE.md) to
   `active/NNNN-short-slug.md`. `NNNN` is zero-padded and monotonic: one
   more than the highest number across `active/` **and** `completed/`.
2. **Fill in** — Context (with links via the
   [knowledge map](../knowledge-map.md)), goals/non-goals, and a Plan whose
   steps each name their own verification command where possible.
3. **Work** — set `status: active`. Tick steps, append dated entries to the
   Progress log, and record decisions in the Decision log **when made**,
   with the why and the alternative rejected.
4. **Close** — every step checked, the Verification section shows the
   commands that pass, `status: completed`, then `git mv` the file to
   `completed/`. Abandoned work closes the same way with
   `status: abandoned` plus a final decision-log line saying why.
5. **Index** — list the plan in the [knowledge map](../knowledge-map.md);
   the verifier requires every plan file to be indexed.

Update `updated:` whenever you touch the file.

## Frontmatter contract

| Key | Value |
| --- | --- |
| `id` | the `NNNN` from the filename |
| `title` | short, imperative |
| `status` | `draft`, `active`, `completed`, or `abandoned` |
| `created` / `updated` | `YYYY-MM-DD`; `updated` must not precede `created` |
| `owner` | GitHub handle, or `agent` |

## Enforcement

`scripts/verify-knowledge.ts` (in `task check` and CI) validates: filename
shape, the frontmatter contract, `status` matching the directory
(`draft`/`active` → `active/`, `completed`/`abandoned` → `completed/`),
required headings (`## Context`, `## Plan`, `## Decision log`,
`## Verification`), and no unchecked steps in a completed plan. Every
failure prints a `fix:` line.

## Tech debt

Debt that needs no plan yet goes in [debt.md](debt.md) as a row. When it
graduates to work, open an ExecPlan that references the `DEBT-NNN` id and
mark the row paid when that plan completes.
