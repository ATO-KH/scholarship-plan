# Backup and restore runbook

Production backups and disaster recovery are operator tasks. The local rehearsal below has no production credentials and cannot configure a provider backup schedule. Do not store real database exports, file archives, keys or private backup locations in this repository.

## Verified rehearsal

```sh
node scripts/rehearse-operations.mjs
node private-tests/operations-rehearsal.test.mjs
```

The first command creates an isolated temporary SQLite database, one local evidence file, and quarantine/final files behind a filesystem-backed Storage mock. It closes the database before copying it, copies every object's actual bytes, hashes all files, and restores them into a separate directory. It uses the application semester-reset implementation and the production Storage deletion client with a local mock transport. It also checks:

- A crash after physical deletion and before database commit resumes after restart and lease expiry.
- Quarantine cleanup waits for issued upload grants to drain.
- Academic records and academic audit details are removed; accounts, identity bindings and FAQ remain.
- A restored encrypted token needs the matching encryption key; a replacement key fails.
- Restoring a pre-wipe backup resurrects old records, so the restored environment stays offline until the intended wipe is reapplied.
- Deleting live evidence does not delete an independent backup; backup disposal is separate.
- Missing/corrupt objects and unexpected manifest paths fail before creating any restored files.

The fictional run was executed successfully on October 10, 2026. It does not verify the real Supabase Storage service, Vercel interruption behavior, a production backup schedule or a hosted disaster restore. The separate real PostgreSQL 17 test also passed locally with two Node instances sharing sessions and serializing conflicting approvals; it does not establish live Supabase behavior.

## Production inventory to arrange

An operator and the Chair must record the owner, protected destination, frequency, retention and deletion date for each item in a chapter-controlled location:

| Item | Why it is needed |
| --- | --- |
| Application PostgreSQL schema and records | Chapter state, members, identity bindings, upload references and reset manifests |
| Supabase Auth account/recovery plan | An application-schema backup alone does not recreate password hashes, factors or matching Auth user IDs |
| Every private Storage object's bytes and its original object path | Database metadata alone cannot restore uploaded evidence or syllabi |
| Provider configuration and exact project/bucket references | Rebuild private bucket restrictions, email redirect allowlist and authentication configuration |
| Matching encryption/security material | Restore encrypted integrations and required server settings; keep this separately access-controlled |
| Independent deletion/retention record | Prevent an older backup from reviving records already designated for deletion |

Supabase database backups exclude Storage object bytes. Consult the configured project's available backup/restore options, including its plan and current retention, rather than assuming a schedule from a default. [Supabase backup scope](https://supabase.com/docs/guides/platform/backups)

## Consistent backup procedure

1. Arrange a maintenance window that prevents new portal writes, invitations and upload grants. Drain existing uploads/finalizers. Record whether a semester purge is idle, in progress or complete; preserve an in-progress manifest.
2. Take a consistent provider-supported database backup and separately capture all private object bytes, including quarantine objects still covered by upload grants and any objects referenced by an in-progress purge manifest. Record size and checksum for each object, with its exact original path. Do not use a public bucket for this.
3. Save provider/Auth recovery information and matching encrypted-data keys under chapter-controlled access. Do not put secret values into the ordinary manifest, public notes, chat or Git.
4. Validate the complete inventory and hashes before calling the backup successful. A copy that contains only upload rows is incomplete. Apply the agreed encryption/access restrictions and retention/deletion schedule to every copy.
5. Resume service only when the captured state is consistent and the maintenance window is complete. Record success or failure privately without logging academic records, signed URLs or credentials.

## Restore procedure

1. Restore first into an isolated project with real-email sending disabled and no public/member traffic. Check that it is not the live project before any destructive operation.
2. Restore the matching database, Auth accounts and identity bindings, private object bytes, provider restrictions and encryption material. Check hashes and references, not just row counts. Revoke old sessions/tokens as part of recovery; do not let copied sessions authenticate visitors.
3. Compare against the independently retained deletion record. If the backup predates a completed semester wipe, reapply that deletion before opening access. If it contains an interrupted purge, resume its manifest; keep academic writes blocked until every planned object is absent.
4. With fictional accounts, test sign-in, role boundaries, another member's direct-file denial, syllabus/evidence display, current point totals, and interrupted cleanup. Verify that old setup/reset links and sessions do not regain access unexpectedly.
5. Only after isolated acceptance, plan the production cutover and reissue authentication/setup material as needed. Record the restored version and losses since the backup. Keep rollback separate from resurrecting deleted academic records.

## Semester cleanup and retention

The Chair's reset button deletes live academic records and verified Storage objects while keeping accounts. It may hold cleanup for roughly two hours and five minutes to drain upload grants. Provider backups, point-in-time history, independent exports and downloaded copies remain subject to their own retention periods. Do not bypass the waiting period or manually erase a deletion manifest. Never rehearse a wipe using real academic data.
