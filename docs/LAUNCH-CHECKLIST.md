# Launch checklist

This is a working acceptance checklist, not a claim that version 1.0 is approved. Keep member emails, grades, passwords, recovery keys and private backup paths out of this public repository. Record the Chair's real decisions and test-recipient addresses in a chapter-controlled location.

## Weekly tomatoes and unified startup — November 10, 2026

- Released commit `3af69a0c9c1a9a4b71bcdeafc8b99ed25169d28e` to [the live portal](https://scholarship-ato-kh.vercel.app/) through staged production deployment `dpl_FnXU6hAYdS8f8gnacTasGZjZ7Xz4` (`scholarship-ato-hkept0gz1-ato-kh.vercel.app`). Vercel independently confirmed the intended project, commit, production target and `pdx1` region. Previous deployment `dpl_fidqXYcNSwNwxLVFgHbXrSFti9v8` is available for rollback.
- Members with exactly zero approved points strictly after checkpoint one now get a fresh tomato barrage on every page refresh. It starts at 3 and adds 2 per completed week; checkpoint two increases the starting amount and adds 4 weekly; checkpoint three increases it again and doubles weekly. Rendering is capped at 96 tomatoes, and later checkpoints do not restart the growth. With the current checkpoint dates, the phase starts are 3, 14 and 32, followed by 64 and 96 after the third checkpoint.
- Splats scatter across the viewport, linger, slide downward and fade over roughly 15–16 seconds. Controls remain clickable; ordinary typing does not dismiss the effect. Escape, navigation and page hiding clear it. Dashboard redraws do not replay it, and reduced motion suppresses it.
- The newer clockwise arm animation is the single startup screen for the live portal and demo. Requests load during a 2.5-second minimum, counting time already spent signing in; slower requests keep the same screen until ready. There is no second-spinner handoff. Errors reveal a retry screen, stale account responses cannot reveal a former account, and reduced motion skips the extra delay.
- The [first-place member demo](https://scholarship-ato-kh.vercel.app/demo/?account=test2#overview) uses the fictional 90-point leader and its personal ATO trophy panel.
- Validation: **337 tests passed, 0 failed, 0 skipped**, locally and in [GitHub's checks for the released commit](https://github.com/ATO-KH/scholarship-plan/actions/runs/42854770701), including isolated PostgreSQL, refresh replay, weekly progression/cap, cleanup, reduced motion, fast/slow startup, error recovery and session protection. Source checks passed. **30 staged and 30 public HTTP checks** verified 18 matching assets, production configuration and private API/file protection.
- The initial runtime error/fatal query returned no records. No schema migration, Auth-setting change, real emails, live member/academic writes or paid upgrades were required. Seven-day invitation expiry remains unchanged.
- Browser surfaces were unavailable. Actual animation appearance, rendered desktop/mobile layout and real-member acceptance remain unverified; DOM and HTTP checks do not establish those outcomes.

## Podium leaderboard and dashboard update — November 10, 2026

- Released commit `e2c0fd16f6b404c649bd9fcc09bc718272ab8a7a` to [the live portal](https://scholarship-ato-kh.vercel.app/) through staged production deployment `dpl_fidqXYcNSwNwxLVFgHbXrSFti9v8` (`scholarship-ato-oe0v5d7fx-ato-kh.vercel.app`). Vercel independently confirmed the intended project, commit, production target and `pdx1` region. Previous deployment `dpl_86AkYoinFmBjUW9Cthn7EvwKWEWb` is available for rollback.
- Added an authenticated chapter leaderboard: gold/silver/bronze podium for the first three places, names/points only below, shared places for ties and no medals at zero. Approved awards and manual adjustments count; corrections appear on refresh. Responses exclude contact and academic details, inactive accounts, non-roster production members and pilot identities. Positive first-place members get a personal ATO trophy panel, including shared-lead wording.
- Starting hours now display N/A until class approval, preserving stored scoring baselines and historical awards; approved zero remains 0. Activity search and selection share one browser-native suggestion field. Reviewed submission rows expose Edit decision / points directly.
- Added an ATO startup entrance with no forced delay. Members with exactly zero approved points strictly after a checkpoint date get a brief SVG tomato throw/splat on Overview, once per browser/member/semester/checkpoint. It clears on input/navigation or within 2.4 seconds, does not intercept clicks, and honors reduced motion.
- Validation: **330 tests passed, 0 failed, 0 skipped**, including SQLite, isolated two-process PostgreSQL 17, authorization, corrected/adjusted leaderboard totals, private response fields, podium ties, empty/error states, starting-hours behavior and animation triggers. GitHub's test check passed for the exact released commit. Source checks passed. **27 staged and 27 public HTTP checks** verified 15 matching assets, production configuration and private API/file protection, including unauthenticated leaderboard rejection.
- Initial runtime error/fatal query returned no records. No schema migration, Auth-setting change, real emails, live member/academic writes or paid upgrades were required. Seven-day invitation expiry remains unchanged.
- Browser inventory remained empty. Rendered desktop/mobile layout, actual datalist scrollbar interaction, animation appearance and real-member/Chair acceptance remain unverified. DOM tests and HTTP checks do not establish those outcomes.

## Grouped reviews, email corrections and activity picker — November 10, 2026

- Released commit `f800cf4522cc09be698506567cea85c1c5a2adc7` to [the live portal](https://scholarship-ato-kh.vercel.app/) through staged production deployment `dpl_86AkYoinFmBjUW9Cthn7EvwKWEWb` (`scholarship-ato-nqaaxbzlq-ato-kh.vercel.app`). The immediately preceding deployment, `dpl_7YXKU3y93dwVgBb6xu1KTMbXpp3u`, contains the grouped-review/email changes with the earlier activity picker and remains available for rollback.
- Classes are grouped by member identity, with selection of that member's pending classes, confirmation of up to 20 approvals, combined credit totals, and atomic stale-version protection. A single saved review opens the same member's next pending class. Filtering and other class saves preserve unfinished review hours and notes while the screen remains open.
- Invitations support reviewed email corrections for eligible members. Corrections preserve member records and aliases, revoke old portal access and recovery keys, survive sheet refreshes, and require a fresh invitation to verify the corrected address. An unrelated pre-existing identity is never automatically adopted. Corrected addresses that conflict with the sheet fail closed and show a warning.
- The activity type picker now uses a native select with optional search. Searching retains a chosen type and entered grade until the member explicitly changes it; Enter in the search cannot submit a claim. The custom floating list and its dismissal handlers were removed. The yellow banner is hidden in production; the fictional demo retains its identification.
- Reused already-loaded chapter state for authorization and writes. Added and independently verified the member-identity and upload-owner indexes through Supabase migration `index_member_identity_and_evidence_lookups`; the missing-foreign-key-index advisory cleared. Vercel confirms the deployed function uses `pdx1`, near the project's `us-west-2` database. No production Chair latency benchmark was performed.
- The current Supabase plan was verified as Free. Its [published allowances](https://supabase.com/pricing) are 500 MB database and 1 GB file storage, with bandwidth accounted for separately. Files remain private with the existing 5 MB per-file limit. The audit found no current storage-capacity pressure or quarantined files. No plan upgrade, file deletion or retention change was performed.
- Validation: **319 tests passed, 0 failed, 0 skipped**, including SQLite, isolated two-process PostgreSQL 17 concurrency, atomic class batches, email-correction authorization/replay checks, and DOM workflow tests. Both GitHub checks passed for the release commit. Source and deployment checks passed. Twenty staged HTTP checks and twenty public-domain checks matched the exact updated assets, verified production configuration and checked private API/file protections.
- The initial runtime error/fatal query returned zero records. No log drains are configured, and percentile-duration queries require a paid observability feature; monitoring and workload latency remain limited. Seven-day invitation expiry and other Auth settings were unchanged. No real emails, passwords, member records or academic decisions were changed for testing.
- Browser control still reported no available surfaces. Actual scrollbar dragging, rendered desktop/mobile layouts and real-inbox/member/Chair acceptance remain unverified; native controls, DOM tests and HTTP checks do not establish those outcomes.

## Chair management and invitation update — November 10, 2026

- Released commit `6d69d3a842508e58c5eca485663b1a167c409344` to [the live portal](https://scholarship-ato-kh.vercel.app/) through staged production deployment `dpl_r6Q7kK1C913VhRfG4jcHYG3ZKf5T` (`scholarship-ato-8lf7ma8k2-ato-kh.vercel.app`). The previous deployment is `dpl_FxkA3i5q5vouwxaXFVVo75KcAQ6e` for rollback.
- Roster now separates Members, Invitations and Roster sheet. Searchable member rows expose point adjustments, class-credit management and account settings. Point saves update the displayed balance without reloading submission history.
- Class decisions return the affected member's current class list, credit total and pending estimates. The queue advances immediately without re-fetching the entire list. Approved and denied submissions/classes can be corrected with a required reason, retained history and stale-version protection. Class-hour changes preserve past assignment awards.
- Invitations show verified account acceptance, awaiting links and seven-day expiry. Reviewed batches can include first invitations and pending-only resends. Each resend rechecks acceptance, skips confirmed accounts and rejects stale/replayed requests. Status lookup failures disable resends. Sending limits still apply; no automatic retries.
- Validation: **308 tests passed, 0 failed, 0 skipped**, including SQLite, two-process PostgreSQL 17 concurrency, authorization, acceptance-after-selection, replay rejection, credit recalculation and DOM interaction tests. Both GitHub checks passed for the release commit. Source and deployment-file checks passed.
- Seventeen staged HTTP checks and seventeen public-domain checks verified production configuration, exact updated source assets, account setup/reset routes, private API sign-in requirements and private source-file protection. The initial post-release runtime error query returned zero records.
- The hosted invitation expiry was independently read back as **604800 seconds** and the production Site URL matched. No Auth settings were changed for this release. No real emails, passwords, member accounts or academic decisions were changed for testing.
- Browser control returned no available browser surfaces. Rendered desktop/mobile layout and real-inbox/member/chair acceptance remain unverified; automated DOM and HTTP checks do not establish those outcomes.

## Workflow and audit release — November 10, 2026

- Commit `df625803c43aa87065898745388983966835c5bc` was built with production settings, checked at its staged deployment, and promoted to [the live portal](https://scholarship-ato-kh.vercel.app/). Vercel deployment: `dpl_FxkA3i5q5vouwxaXFVVo75KcAQ6e`.
- The full suite passed 293 tests with no failures or skips, including isolated PostgreSQL concurrency checks. Both GitHub checks passed for the released commit.
- The production configuration endpoint confirmed database access and configured chapter authentication. Thirteen staged HTTP checks and ten public-domain checks passed: delivered pages/assets matched the tested source, private APIs required sign-in, production demo APIs were disabled, and private server/configuration files were not served. The post-release runtime error scan returned no errors.
- After promotion, the invitation and password-reset template bodies were installed in Supabase and independently read back against the release files. Seven-day email-link expiry (`604800` seconds) and all other Auth settings remained unchanged. No real emails were sent or accounts, academic decisions, or semester settings changed for testing.
- Browser surfaces were unavailable. Desktop/mobile rendering, real member/Chair sign-in and submission/review flows, and inbox delivery remain acceptance checks below; HTTP and DOM tests do not establish those outcomes.

## Direct roster invitations — November 6, 2026

- 260 automated tests passed without failures or skips, including isolated PostgreSQL and automatic roster-account creation, first-send protection, authorization, and later account editing.
- A fictional Chair browser session selected one prepared and two unprepared members together. One confirmation created the missing accounts and processed three invitations through a fake email provider. The reviewed Tier 4 assignment, existing Tier 3 / 12-credit account and badge, and new-member Tier 1 default were preserved.
- The Chair then changed an automatically created account's name and tier. The portal ID stayed the same and the fake email count stayed at three. Browser errors were empty. The confirmation had no horizontal overflow at a 390-pixel viewport; physical iPhone acceptance remains outstanding.
- Individual account preparation is optional. No real accounts were created and no real email was sent during these tests. Authorized inbox delivery testing and sender allowance checks remain necessary for rollout.

## Bulk invitation controls — October 30, 2026

- 247 automated tests passed without failures or skips, including isolated PostgreSQL and first-invitation replay, concurrency, role, eligibility, rate-limit and interruption checks.
- A fictional Chair browser session selected two prepared accounts, reviewed one recipient list, and completed the batch against a fake email provider. Both accounts then became unavailable for bulk selection. Browser errors were empty. No real email was sent.
- Previous or uncertain sends and confirmed accounts cannot be bulk-selected. A definite provider rate-limit rejection requires a later manual selection; it cannot turn a previously uncertain send into a new first invitation.
- Before a full rollout, check the actual Supabase and SMTP email allowances and complete the authorized inbox test below. Follow the [bulk invitation steps](EMAIL-ROLLOUT.md#send-several-invitations-with-one-review).

## Excel imports and no-email roster editing — October 30, 2026

- 230 automated tests passed without failures or skips, including isolated PostgreSQL, account preparation/editing, student-ID validation and Excel workbook tests.
- Fictional browser checks opened both `.xlsx` and `.xls` files, selected a different worksheet, rebuilt its column mapping, required a new confirmation, skipped an invalid student-ID row, and applied only the reviewed tiers. Numeric GPA 2.699 stayed 2.699 even when Excel displayed 2.70; exact student IDs survived scientific display formatting. No workbook was uploaded.
- With email sending disabled, the Chair prepared an account and edited a member’s name and tier from Roster. The new-member preparation form kept Tier 1 locked. The provider fixture recorded zero mail attempts. Account changes preserve the permanent portal ID and use separate explicit sending controls.
- Invalid or duplicate student IDs affect only their own import rows. “900 number” does not require a literal 900 prefix. Correct source roster errors before importing affected members.
- These checks use fictional data and mocked providers. Real inbox delivery, physical iPhone acceptance, and the remaining Chair policy decisions below are still outstanding.

## Email template maintenance — October 25, 2026

- The hosted Supabase reset template was updated to remove the old authenticator instruction, then saved, reloaded and previewed. No emails were sent. Inbox delivery and completion of a real setup/reset flow still require an explicitly authorized recipient test.

## Password-only Chair login and GPA layout — October 23, 2026

- 202 automated tests passed without failures or skips, including isolated PostgreSQL checks. Authenticator enrollment and challenges were removed at the chapter's request; role checks, password verification, CSRF, rate limits and session revocation remain.
- A fictional browser session signed in directly as Chair, selected reordered GPA and 900-number columns, rejected a duplicate column mapping, saved the layout and applied the correct tiers to two fictional roster entries. No invitations were prepared or sent. The form had no page-level horizontal overflow at the browser's 533-pixel width; physical mobile-browser acceptance remains outstanding.
- Provider mocks cover password changes and resets for accounts with and without previously enrolled factors. Real Chair sign-in/reset still requires acceptance testing. The updated recovery-email source was subsequently installed in Supabase on October 25; future repository changes still require a separate hosted template update.

## Pre-meeting verification — October 11, 2026

- 200 automated tests passed, with no failures or skips, using SQLite and an isolated PostgreSQL instance. Source/deployment-file checks and the production dependency audit passed.
- Fictional browser checks covered Chair verification, incorrect-code rejection, resuming verification after reload, direct sign-out, member recovery-key acknowledgment after an interrupted first login, and account repair without sending mail. The Chair verification and member profile layouts were checked at 390 pixels wide.
- The operational rehearsal passed all six backup, restore, interrupted-wipe and retention checks using disposable records and actual fictional file bytes.
- Class-hour API and sandbox checks cover approval, denial, replacements, removals, stale/concurrent reviews, total limits and recalculated pending point estimates. A fictional browser flow verified approval to 3 hours, preserved hours during a removal request, and 0 hours after Chair approval. Class forms fit the 390-pixel layout.
- File previews retain a centered loading cross through image transfer and decoding, omit displayed filenames and support retry. Delayed/cached images and mobile layout were checked. The in-app browser’s PDF fallback was checked; native inline PDF rendering and physical Safari still require acceptance testing.
- Invitation and password-reset email templates were installed in Supabase, previewed, and verified after reloading the settings. Saving templates sent no emails; recipient inbox delivery remains untested.
- These checks used local provider mocks. They do not establish hosted email delivery, real Chair password login/reset, physical iPhone behavior, or production backup/restore readiness. Those remain explicit acceptance items below. No real invitation or reset email was sent during this work.

## Work that does not require the Chair

- Run the automated suite with an isolated PostgreSQL database as well as local SQLite. Include role/ownership checks, syllabus approval, scoring, stale edits, invitations, password recovery and Chair sign-in.
- Run `node scripts/rehearse-operations.mjs`. It must report all checks passing and remove its temporary data. It includes actual evidence-file bytes, interrupted deletion, account retention and restoring a backup taken before a wipe.
- Exercise member and Chair screens with fictional data on a narrow screen. Check native activity/class selection, image/PDF upload and preview, cropping, long file names, keyboard navigation, error/retry states, sign-out and loading indicators. Browser emulation does not prove Safari on a physical iPhone.
- Prepare and preview the [invite template](../supabase/email-templates/invite.html) and [reset template](../supabase/email-templates/recovery.html). Installing either template is separate from sending an email.
- Prepare eligible accounts and correct member details through **Roster** without sending an invitation. Follow the [email rollout guide](EMAIL-ROLLOUT.md); the existing roster is the recipient list, so no duplicate mailing list is needed in Supabase or Vercel. Use **Roster → Invitations** to distinguish account acceptance, an awaiting link, expiry, and uncertain email delivery.
- Review the [member instructions and FAQ drafts](MEMBER-GUIDE.md). Do not replace Chair-edited live FAQ entries automatically.
- Agree who will operate backups and restore the service, using the [backup runbook](BACKUP-RESTORE.md). A completed rehearsal does not mean scheduled production backups exist.

## Chair meeting: decisions and access

1. **Account and inbox.** Verify the dedicated Chair office login, chapter control of its inbox, password reset and a documented transition/recovery process. The previous officeholder's access must end at handoff. Never share the password in a meeting note or chat.
2. **Semester.** Confirm semester name, start date, three checkpoint dates, final point deadline and submission closing date. Preview all dates in the portal before saving; do not use semester reset merely to adjust a deadline if real records should remain.
3. **Roster.** Refresh the read-only sheet, confirm active and new members, detect duplicates/mistyped emails, and review deactivated access. Prepare the desired accounts and use **Manage member** to review names, badges, tiers and credits. Refreshing the roster, preparing accounts and saving member settings do not send invitations. Use **Invitations → Correct email** for address mistakes, then explicitly send a fresh invitation. Records stay with the member; old portal sessions and recovery keys lose access.
4. **Tiers and credits.** The Chair imports their private GPA Excel workbook or CSV, selects its worksheet and maps its rows/columns, reviews matches and resulting tiers, and applies them. Use the page 5 policy. The portal stores tiers rather than the source GPA sheet or 900 numbers. Members submit credit hours with each class syllabus, and the Chair approves both in **Classes**. Check all classes before reviewing point claims: the first class-hours approval replaces any old manually entered total with the sum of approved classes. Confirm any points earned before rollout.
5. **Rules.** Confirm point categories, checkpoint quotas, evidence requirements and syllabus approval before graded assignments. Confirm who will review submissions and handle denials/corrections.
6. **Privacy and retention.** Choose who can access operational backups, how long backups remain, when old exports are destroyed, and who is responsible for recovery. Semester reset removes live academic records and uploaded files; separately retained backups/downloads follow their own retention schedule.
7. **Pilot recipients.** Select two or three consenting testers with inboxes they control. Separately authorize one invitation and password-reset email test before any bulk rollout. No recipient is implicitly authorized by appearing in the roster.

## Pilot acceptance

Use fictional academic records with the actual hosted workflow. Record pass/fail and the deployed commit privately; do not paste setup links or tokens in screenshots.

- [ ] One authorized recipient receives the invitation with the correct sender, wording and site link; check spam as well as inbox.
- [ ] Preparing and editing another fictional pilot account sends no email. Its permanent sign-in ID stays unchanged after a badge edit, and the old badge no longer signs in.
- [ ] Recipient chooses a password, saves/acknowledges their recovery key, signs out and signs in again with supported aliases.
- [ ] Expired, interrupted and repeated setup/recovery attempts have clear recovery paths; old sessions cannot retain access after a password reset.
- [ ] The authorized recipient's reset email arrives and completes successfully. The Chair can sign in with the office email and password.
- [ ] A member adds a class with credit hours and a syllabus; a pending or denied syllabus blocks graded assignments. Chair approval unlocks the class and updates the account total. Pending replacements and removal requests preserve the previously approved hours until reviewed. Verify the resulting credit-load multiplier before approving point claims.
- [ ] A mistaken approval or denial can be corrected with a reason; verify replacement points, class-credit totals, stale-edit rejection and retained decision history.
- [ ] Invitation acceptance updates after account setup. A member who accepts after selection is skipped by pending-only resend; expired links show their date.
- [ ] Correct a fictional recipient's email, confirm that points/classes remain and old access ends, then separately authorize a fresh invitation. Refreshing the roster retains the correction; conflicting source entries show a warning and cannot grant access.
- [ ] A member submits fictional evidence; the Chair sees the file and original syllabus inline, approves or denies, and the member sees the correct notes and totals.
- [ ] A member starts from **My classes**, closes and restores a draft, and uses **Submit & add another**. The next form keeps the activity/class/date, clears the grade/title/evidence, and cannot send twice while saving. Check a failed replacement upload and a class that loses approval before draft restoration.
- [ ] The Chair searches and filters the assignment queue, opens pending work from **Member progress**, and reviews successive assignments without losing the filter. A conflict offers current details; failure to open the next assignment cannot repeat a saved decision. Check evidence beside the form on desktop and stacked on a narrow screen.
- [ ] Class review search and status changes retain the loaded queue. After a decision, the next pending class opens within the search and assignment estimates reflect the approved credit hours.
- [ ] Classes appear together under their member, including members with equal names. Select a member's pending classes, confirm their hours, and approve them together. Hidden selections remain explicit at confirmation. Review notes survive filtering and another class save. A stale batch saves no decisions.
- [ ] The other member cannot open the first member's direct submission, syllabus, profile-picture or evidence URLs.
- [ ] Test on a physical iPhone/Safari: dropdowns, file picker/camera, portrait/landscape, dialogs, previews and sign-out. Also test desktop.
- [ ] Restore a separate fictional hosted database/object backup in an isolated project; confirm authentication bindings, encryption material, files and post-wipe retention rules. Never run a wipe test against the chapter's live data.
- [ ] Confirm production error monitoring and an operator contact, working backup schedule, and a tested previous-deployment rollback route.

## Version 1.0 decision

Invite the small pilot first. Resolve failed checks, have the Chair accept the policy/date/roster settings, then authorize the remaining invitations in batches compatible with the actual sender limits. Keep a way to pause sending and deactivate mistaken accounts. SMTP configuration and a successful deployment alone do not establish delivery or launch readiness.
