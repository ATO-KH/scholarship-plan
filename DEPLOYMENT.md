# Operator runbook: Vercel and Supabase

This is the deployment procedure for the implemented private portal. A Vercel production deployment and Supabase project exist, but the chapter-managed login has not been activated. Canvas, Google Sheets, and complete hosted evidence workflows still require acceptance testing.

The chapter-managed login code is staged behind `AUTH_MODE=chapter`. The live site has **not** switched to it. Do not enable it until the chair account, invitation emails, password recovery, and member authorization pass the pilot below. The requested 16-word recovery key is not implemented yet.

The hosted architecture is Vercel's Node server entrypoint, Supabase PostgreSQL for application state, and a private Supabase Storage bucket for evidence. Local demo mode continues to use disposable SQLite and local fictional files. No member records or credentials belong in the repository.

## 1. Prepare the accounts and production boundary

Use the chapter's controlled Vercel and Supabase accounts. Import this **private** repository into a Vercel project. Set Node.js **24.x**; the repository pins pnpm and the dependency lockfile. Set `ENABLE_EXPERIMENTAL_COREPACK=1` in the Production environment so Vercel honors the pinned pnpm version, including when the install command is overridden. The install command is `pnpm install --frozen-lockfile`, and the build check is `pnpm check`. `server.mjs` is the Node entrypoint; `vercel.json` sets a 120-second invocation limit. See [Vercel's Corepack configuration](https://vercel.com/docs/builds/configure-a-build#corepack).

The deployment configuration excludes local environment files, Vercel caches, Git metadata, test fixtures, and working data from dependency tracing as well as uploads. Keep both exclusion lists when changing the build: tracing a local Vercel cache can break packaging or include files that do not belong in the server bundle.

Browser assets live in `web/`. Do not rename that directory to `dist/`, `build/`, or `output/`: Vercel's Node builder searches those directories after the build command and can mistake the browser's `app.js` for the compiled server. Verify the packaged server handler and asset inventory after changing deployment settings; a successful build alone does not prove that the correct program was packaged.

Vercel Hobby currently rejects Git integration with a private organization repository. Keep the source private. Use an authorized personal private repository or direct CLI deployments to the linked project; direct deployments do not enable automatic deployment on Git pushes. Confirm the linked account and project before deploying, and complete the database, storage, and identity setup below first.

Choose the final HTTPS hostname first. Set `PUBLIC_ORIGIN` to that exact origin, such as `https://scholarship.example.edu`, without a path, query, or credentials. Register the same origin's identity and Canvas callback URLs. A different temporary hostname is not interchangeable with the configured origin.

Enter the placeholders from [.env.vercel.example](.env.vercel.example) in **Vercel's Production environment only**. Do not copy production secrets to Preview or Development. This application rejects Vercel Preview mode and refuses hosted SQLite/local-file fallback. A private Git repository, deployment protection, and `noindex` headers do not replace member authentication.

Keep database passwords, identity client secrets, Storage keys, Canvas secrets, the encryption key, and the roster service-account private key in the provider's server-side secret store. Do not paste them into chat, screenshots, committed files, frontend variables, or support logs. Redeploy after changing production environment values.

## 2. Create and migrate the private database

In Supabase's **Connect** dialog, copy the actual connection details; do not construct the pooler hostname from the region. Use the transaction-pooler connection on port **6543** for Vercel's `DATABASE_URL`. You can omit the password from that URL and enter the raw password separately as a Production-only Secret named `DATABASE_PASSWORD`; this avoids manual URL encoding. Alternatively, keep the password in `DATABASE_URL` with special characters URL-encoded. Set only one password source. The application uses one PostgreSQL connection per warm instance and unnamed parameterized queries. Supabase recommends transaction pooling for serverless applications. [Connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres)

The driver requires verified TLS. If the connection needs Supabase's database root certificate, set `DATABASE_CA_CERT` to that certificate's PEM text; literal `\n` line breaks are accepted. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. `DATABASE_SSL=disable` is permitted only for explicit local loopback tests and is rejected in Vercel.

Run the migration deliberately from a trusted operator environment before the first production deployment:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
```

The command reads `DATABASE_URL` and optional `DATABASE_PASSWORD` from that environment or a local ignored `.env`. For the migration, use a direct PostgreSQL connection when available, or the session pooler when the operator network requires it. Restore the **transaction** pooler URL in Vercel afterward. Never put a password-bearing connection string or raw password in the command text or shell history. The migration requires a database role allowed to create the schema and perform its grants/revokes. The server checks schema readiness on startup; it does not run production migrations on every request.

The migration creates the `scholarship_private` schema, enables deny-by-default Row Level Security on its tables, and revokes schema/table/sequence access from `PUBLIC` and, when present, Supabase's `anon` and `authenticated` roles. It applies matching default-privilege revokes. Keep this schema out of Supabase's exposed Data API schemas. The portal uses server-side SQL and ownership checks; these revokes do not restrict the privileged server database account itself. Do not add broad browser grants or public access policies to work around a configuration problem.

This migration creates an empty live chapter. It does not import existing Google Forms submissions, point totals, or proof files. An import requires a separate reviewed mapping; preserve the original sheets until that migration is explicitly performed and reconciled.

## 3. Configure private evidence storage

Create a **private** standard Storage bucket named `scholarship-evidence`, or choose another valid name and match `SUPABASE_STORAGE_BUCKET`. Set its file-size limit to exactly **5,242,880 bytes (5 MiB)** and its allowed MIME types to exactly:

```text
application/pdf
image/png
image/jpeg
```

Do not make the bucket public, and do not add anonymous or general authenticated-user upload/download policies. The portal issues narrowly scoped signed upload URLs after its own authorization. Hosted startup and Storage operations check the private flag, size limit, and MIME allowlist; a mismatch fails closed.

Set `SUPABASE_URL` to the project's exact `https://PROJECT_REF.supabase.co` origin. Prefer a server-only `SUPABASE_SECRET_KEY` (`sb_secret_...`), or use a legacy `SUPABASE_SERVICE_ROLE_KEY` with the `service_role` claim. Leave the unused alternative blank. Publishable/anonymous keys are rejected by this integration. New secret keys are sent only in the `apikey` header; legacy service-role JWTs also use the authorization header. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)

The browser uploads directly to a random, member-bound quarantine path in Supabase. The portal then downloads the actual bytes server-side, checks the 5 MiB limit and PDF/PNG/JPEG signature, verifies the requested size/type, and writes those verified bytes to a separate immutable final key. Only the final record becomes usable proof. Filenames, browser metadata, and a successful upload response alone do not approve evidence or award points.

Authorized evidence downloads redirect to a signed attachment URL with a default **60-second** lifetime. Anyone holding that bearer URL can use it until it expires; logout or member deactivation does not revoke a URL already issued. Supabase upload grants last **two hours**, which is why reset cleanup accounts for outstanding grants. [Signed uploads](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl), [private downloads and signed-link lifetime](https://supabase.com/docs/guides/storage/serving/downloads)

Direct transfers keep 5 MiB proof files out of Vercel request and response bodies. Vercel's documented function payload ceiling is **4.5 MB**. This portal additionally refuses JSON and CSV responses larger than **4 MiB** with an error; it does not silently truncate them. Large histories/audits/exports therefore need pagination or a separate export implementation before expansion beyond the pilot. This is a limit, not a demonstrated capacity guarantee. [Vercel payload limits](https://vercel.com/docs/functions/limitations)

## 4. Register university identity and the first chair

For Microsoft Entra, register the approved university-tenant web application and configure:

- `MICROSOFT_TENANT_ID`: the exact tenant GUID.
- `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.
- Callback: `https://YOUR_HOST/auth/microsoft/callback`.
- The optional **acct** ID-token claim. This implementation accepts `acct=0` and rejects guest/personal identities and missing membership claims.

Set `BOOTSTRAP_PROVIDER=microsoft` and `BOOTSTRAP_SUBJECT=TENANT_GUID:oid:OBJECT_GUID`, using the chair's verified directory object ID in the configured university tenant. `BOOTSTRAP_NAME` and `BOOTSTRAP_EMAIL` are display/contact metadata; neither determines who becomes chair. Do not derive the subject from a name, phone number, guessed university address, or the first visitor.

The first successful login of that exact identity creates the chair **only if no chair already exists**. Merely changing the bootstrap environment does not promote another account once a chair is present. Preserve a documented operator recovery procedure for the trusted roster and directory binding. The Microsoft fallback subject, if no `oid` is issued, is `TENANT_GUID:sub:SUBJECT`; verify the actual provider output before provisioning it. See [Microsoft ID-token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).

Microsoft is the current default portal sign-in provider; the chapter-managed alternative below is staged but inactive. University approval may be required for Microsoft app registration or consent. Provider setup is not completed by committing these placeholders.

### Staged chapter-managed login pilot

The alternate `AUTH_MODE=chapter` uses Supabase Auth to verify email/password credentials and the portal's own membership database to authorize records. The chapter chair can invite a member, send a reset email, and deactivate access. Members may sign in using their verified email, assigned `KH-...` portal sign-in ID, or a chair-entered badge number. The immutable Portal Member ID remains the sheet eligibility key and never changes when a badge is assigned. No public self-registration or predictable temporary password is used.

Before enabling this mode, configure a custom SMTP sender in Supabase Auth and test delivery to an ordinary member address. Supabase's default sender is for limited testing and cannot deliver to arbitrary chapter members. Keep public signups disabled and email confirmation enabled. Set Supabase Auth's Site URL to the production origin and allowlist only `${PUBLIC_ORIGIN}/account/setup` and `${PUBLIC_ORIGIN}/account/reset` for this flow. The production project's current Site URL and these two redirect URLs have been configured; SMTP has not. [Supabase invitations](https://supabase.com/docs/guides/auth/users), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

Add `SUPABASE_PUBLISHABLE_KEY` in Vercel Production. Keep `SUPABASE_SECRET_KEY` server-side; the browser never receives it. Invite the first chair to Supabase Auth through its dashboard after SMTP works. Copy the **exact Auth user UUID** into `BOOTSTRAP_AUTH_USER_ID`, and set `BOOTSTRAP_EMAIL` to the same confirmed email. The first successful login of that exact pair creates the chair only if no chair exists. Do not infer it from an email pattern or the first visitor. Reconcile the existing Supabase Auth users before deciding whether any can be used; they are not automatically portal members.

Pilot with one chair and one fictional member: confirm invite delivery, password setup, login by all assigned aliases, own-record isolation, chair-only controls, reset delivery, deactivation of an existing session, and roster-sheet eligibility. Then set `AUTH_MODE=chapter` in Production and redeploy. The 16-word recovery-key feature must be implemented and separately tested before it is promised to members. The public fictional demo remains at [member view](https://matasvai.github.io/ato-scholarship-demo/?view=alex#overview) and [chair view](https://matasvai.github.io/ato-scholarship-demo/?view=chair#queue); it does not use live accounts or academic data.

## 5. Connect the roster eligibility sheet

The chair first creates each portal account with its verified stable identity. The portal assigns a **Portal Member ID**. The sheet is an additional active-membership allowlist; it does not create identity bindings, assign chair permissions, or infer accounts from existing contact details.

In the controlled roster sheet, add these columns, preserving any existing A–C contact columns:

| Column      | Header                       | Value                                                      |
| ----------- | ---------------------------- | ---------------------------------------------------------- |
| D           | `Portal Member ID`           | Exact portal-issued member ID copied from the chair roster |
| E           | `Active`                     | Explicit `TRUE` or `FALSE`                                 |
| F, optional | `Confirmed university email` | Human reference only; ignored for access                   |

Use at most **1,000 member rows**. The default range is `'Roster'!D1:E1002`: the extra row detects an over-limit roster rather than silently accepting truncation. The selected range must contain exactly the D/E headers and their two columns; adjust the tab name through `ROSTER_SHEET_RANGE` if necessary. Duplicate/missing IDs, ambiguous active flags, an empty roster, or an over-limit response are rejected. Optional column F must stay outside the authorization range.

Create a dedicated Google Cloud service account, enable the Google Sheets API, and share **only this spreadsheet** with that service-account address as **Viewer**. Do not enable domain-wide delegation. The connector requests only `spreadsheets.readonly`; sharing determines which spreadsheet it can read. Configure:

```text
ROSTER_REQUIRED=true
ROSTER_SHEET_ID=YOUR_PRIVATE_SPREADSHEET_ID
ROSTER_SHEET_RANGE='Roster'!D1:E1002
ROSTER_SERVICE_ACCOUNT_EMAIL=YOUR_SERVICE_ACCOUNT_ADDRESS
ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY=YOUR_SERVER_ONLY_PEM_KEY
```

Keep the real sheet link/ID and key in configuration, not this repository. In Vercel's value field, the range includes the single quotes around `Roster`; the PEM key can contain actual newlines or literal `\n` sequences. Setting any roster source field also enables the requirement, so partial configuration blocks ordinary-member access instead of disabling the check.

A snapshot is accepted for **15 minutes**. A shared 45-second refresh lease prevents simultaneous refreshes, and failures have a 30-second retry cooldown. The next member request after it becomes stale attempts a refresh; if current eligibility cannot be established, member access is blocked. Sheet changes can take up to that freshness interval to affect existing sessions unless the chair refreshes sooner through the roster control (`POST /api/admin/roster-sync`). Explicit portal deactivation remains available for immediate application access removal. The active chair bypasses the sheet eligibility check to repair a broken sheet or refresh failure; chair authentication and the portal's active-account check still apply. Do not remove that recovery path or use it to share evidence access with general officers.

## 6. Optional Canvas connection

Canvas requires the institution's OAuth developer key, not personal access tokens pasted by students. Set the exact HTTPS `CANVAS_BASE_URL`, client ID/secret, and callback `https://YOUR_HOST/auth/canvas/callback`. Enable **Allow Include Parameters** and these read scopes:

```text
url:GET|/api/v1/courses
url:GET|/api/v1/courses/:course_id/assignments
```

Generate `APP_ENCRYPTION_KEY` as 32 random bytes encoded in base64 and store it as a stable server secret. Back it up separately from the database. Changing or losing it makes previously encrypted Canvas tokens unreadable. Each member authorizes their own Canvas account separately from university portal sign-in. Imports are pending claims; the chair still verifies the activity category and awards points. Leave Canvas configuration blank until its registration is approved.

## 7. Change semesters and permanently clear live academic records

Use the chair's **Semester** screen. Enter the next semester's name, start date, three checkpoint dates, final target date, and submission closing date. Dates must be ordered; no checkpoint dates are guessed. Tier point targets stay unchanged. Claims for dates before the new start are rejected once that semester activates.

Review the old semester and deletion counts, then type `DELETE SEMESTER`. The preview token expires after ten minutes and binds the exact records shown; a changed or expired preview must be refreshed. Starting the reset immediately removes old submission/evidence access and freezes new academic writes. Member accounts, stable identity bindings, and account/security audit events remain. Old submission, evidence, and Canvas-import audit details are removed.

The deletion job persists the planned quarantine and final object keys before withdrawing access. **Resume cleanup** processes one object per request and keeps issuing bounded requests while work is available. It stops when finished, waiting, interrupted, or unable to verify deletion. Each object requires verified absence before it is counted as deleted. Provider failures keep the job incomplete and retryable; a terminated worker's lease expires after two minutes. Refreshing/redeploying does not discard the inventory. There is no automatic background scheduler in this version: return to the chair screen and resume when its next-attempt time arrives.

Hosted final files wait at least **five minutes after reset starts** to drain bounded in-flight finalizers. Recent quarantine grants, including grants for already-finalized files, wait until their two-hour lifetime plus five-minute grace has elapsed. The UI may therefore show a hold of up to approximately **two hours and five minutes**. New-semester submissions open only after every planned file deletion is verified. Do not bypass the hold, delete the manifest by hand, or report a partially finished reset as complete.

This is permanent deletion of **live application records and current Storage objects**. It does not immediately destroy previously retained provider backups, database point-in-time history, independent exports, or a user's downloaded copy. Document their retention periods separately; do not promise that this button erases those copies.

## 8. Backups, recovery, and the live acceptance gate

Back up three separate things under chapter-controlled access: the application database, actual private Storage object bytes, and `APP_ENCRYPTION_KEY` plus the server-secret recovery material. Supabase database backups contain Storage metadata but **not the object bytes**. Test restoration in an isolated project. [Supabase backup scope](https://supabase.com/docs/guides/platform/backups)

Record retention and destruction schedules for each backup/export location. A restore from before a completed semester wipe can resurrect old academic records; reapply the intended deletion policy before allowing member access. Resume incomplete purge jobs from their retained manifests. Preserve the encryption key alongside the matching encrypted-token database version; replacing it is not a transparent token migration.

Before accepting real academic documentation, run a fictional pilot on the actual production-shaped deployment:

1. Complete one real approved university OAuth round trip for the chair and two test members; verify unknown/foreign identities are denied.
2. Confirm each member can see only their own records and cannot access the other member's direct submission/evidence URLs; verify chair-only review and CSRF rejection.
3. Verify the roster sheet's explicit IDs, FALSE/removal behavior, stale-refresh failure, chair recovery, and reactivation.
4. Upload/download PDF, PNG, and JPEG evidence directly; test exactly 5 MiB, over-limit rejection, foreign access denial, grant replay, immutable final proof, and actual provider absence checks.
5. Submit, approve, deny with a reason, repeat an import, and confirm pending/rejected work never inflates approved totals. If Canvas is enabled, test university consent and a released zero grade as well as ordinary grades.
6. Interrupt a fictional reset mid-cleanup, resume after its holds/lease, verify both quarantine and final objects are absent, and confirm accounts remain with an empty new semester.
7. Restore a fictional database/object backup into an isolated environment and verify the matching encryption key and deletion-retention procedure.

Local and provider-mock tests support the implementation, but do not establish live Supabase semantics, Vercel interruption recovery, university permissions, or operational capacity. Keep the pilot small until those checks pass. No real-data wipe or production account creation is part of this runbook's verification.
