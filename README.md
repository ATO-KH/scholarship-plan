# ATO Scholarship Portal — private edition

The fuller server-backed version of the Kappa Eta scholarship workflow. The separate public proof of concept is at [ato-scholarship-demo](https://github.com/matasvai/ato-scholarship-demo), with [member](https://matasvai.github.io/ato-scholarship-demo/?view=alex#overview) and [chair](https://matasvai.github.io/ato-scholarship-demo/?view=chair#queue) demonstrations.

This repository is **private**. It contains application code and fictional sample fixtures, not university credentials or real chapter records. A private repository does not itself authenticate visitors to a deployed application.

## What is implemented

- Member submission forms, review status, notes, and approved point totals.
- Scholarship Chair review queue, approval/denial, CSV export, member progress, roster controls, and audit history.
- Private PDF/JPEG/PNG evidence uploads and authenticated downloads.
- Server-side ownership and chair-role checks, session cookies, and CSRF validation.
- Microsoft Entra ID and Google OpenID Connect authorization-code integrations with PKCE and signed-token verification.
- Chapter membership bound to a stable verified provider identity, not a user-entered email or role.
- Canvas OAuth connection, encrypted token storage, refresh handling, and read-only import of the consenting member's released numeric grades.
- Duplicate import protection, chair-controlled point awards, and explicit handling of undefined multiplier rounding.
- A demo mode for testing without university accounts and a production mode with no demo identity switch.

**Live identity-provider and Canvas connections have not been tested against a university tenant.** They require approved app registrations, correct environment values, and an HTTPS deployment. The automated provider tests use signed local token fixtures and mocked Canvas responses; those tests are not proof of a successful university connection.

## Local setup

Use Node.js 24 or newer. Install the pinned dependency graph with pnpm:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm start
```

Open <http://127.0.0.1:4175>. Demo mode starts with fictional members; choose **View as** to test the member and chair workflows. Use only fictional files and records while in demo mode.

```sh
pnpm test
```

The package uses the Node built-in SQLite module and the `jose` library for JWT validation. No external database service is needed for the local version.

## Main workflows

**Member:** submit an activity with evidence → await review → see the decision and approved total. A pending estimate never contributes to the approved total.

**Chair:** inspect evidence → enter a whole-point award or a denial reason → review history and totals update from the same submission record. Point totals are computed, not kept in a second manually edited sheet.

**Canvas:** connect through the university's OAuth authorization page → select released assignments → confirm each activity category → import as pending claims → chair reviews. The portal never changes Canvas grades or submits coursework.

**Roster:** the chair adds members using their provider and stable verified identity ID. Deactivation blocks further portal access while preserving the review history. The initial chair is configured on the server, not selected by the first visitor.

## Configure Microsoft or Google sign-in

Set production configuration only on the server. `.env` and generated databases/files are ignored by Git. `.env.example` contains blank placeholders only.

### Microsoft Entra ID

1. Register an application for the approved university tenant.
2. Set `MICROSOFT_TENANT_ID` to the exact tenant GUID, and provide the client ID and secret.
3. Register `https://YOUR_HOST/auth/microsoft/callback` as the web callback.
4. Add the optional **acct** ID-token claim. This implementation requires signed `acct=0` and rejects guest/personal identities and missing membership claims.
5. Configure the initial chair using `BOOTSTRAP_PROVIDER=microsoft` and the verified stable subject `TENANT_GUID:oid:OBJECT_GUID`. The fallback when no `oid` is issued is `TENANT_GUID:sub:SUBJECT`.

Microsoft email and `preferred_username` are mutable metadata. They are not used as proof of chapter membership. Authorization binds provider + stable subject to the roster.

### Google university accounts

1. Configure a Google OAuth web client for the chapter portal.
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the exact `GOOGLE_HOSTED_DOMAIN`.
3. Register `https://YOUR_HOST/auth/google/callback`.
4. The server requires the exact signed hosted-domain claim and `email_verified=true`. Use the verified Google `sub` as the roster subject.

For both providers, the flow uses state, nonce, PKCE, an expiring server-side transaction, signature verification, issuer/audience/expiry checks, and a server session. No provider access token is returned to browser code. The university may need to approve app registration or consent.

## Configure Canvas

A multi-user Canvas application needs an institution-issued **OAuth developer key**. Do not ask members to paste personal access tokens.

Set:

- `CANVAS_BASE_URL` to the exact HTTPS Canvas origin.
- `CANVAS_CLIENT_ID` and `CANVAS_CLIENT_SECRET` to the approved developer-key values.
- Callback: `https://YOUR_HOST/auth/canvas/callback`.
- `APP_ENCRYPTION_KEY` to 32 random bytes encoded as base64. Keep this secret stable and securely backed up. Rotating it without migration makes stored Canvas tokens unreadable.

Enable these read scopes on the developer key:

```text
url:GET|/api/v1/courses
url:GET|/api/v1/courses/:course_id/assignments
```

Enable **Allow Include Parameters** so the assignments response can include the current student's submission. The connector follows safe same-origin pagination and never forwards a token to a different origin or follows a cross-origin redirect.

The connector retains numeric zero grades, excludes null/unposted/excused grades, and derives percentages from numeric scores and positive possible points. Eligibility calculations use the **unrounded** ratio; formatting the display does not change the score used by the server.

A Canvas group weight is not the individual assignment's course weight. The member selects the category and the chair verifies it. Canvas current percentages also do not establish transcript GPA.

Microsoft or Google login is independent of Canvas authorization. A member connects Canvas separately. Disconnecting removes locally stored Canvas tokens and invalidates pending connections; already-reviewed scholarship records remain in the portal's history. Revoke the application in Canvas settings to remove the Canvas-side authorization.

## Deployment and storage

This edition requires a Node server, HTTPS, and persistent storage. **It cannot run as a GitHub Pages backend.** GitHub Pages hosts the separate browser-only demo.

- Set `APP_MODE=production` and `PUBLIC_ORIGIN` to the exact external HTTPS origin.
- Set a verified bootstrap identity or provision the roster before member use.
- Put a TLS reverse proxy in front of the loopback Node listener.
- Preserve the application database and private upload directory on a persistent volume. Restrict filesystem permissions and arrange backups and a retention policy before storing live academic records.
- Store secrets in the hosting provider's secret configuration. Do not put them in frontend code or commits.
- Production mode starts without sample members and rejects demo-persona switching.
- Evidence files are outside the public web directory. Downloads check membership and ownership or chair role and use attachment responses.

This remains an implementation for review and deployment preparation. A live university OAuth round trip, deployment-specific HTTPS/session behavior, and operational handling of real academic records still need verification.

## API surfaces

The original submission/points endpoints remain compatible with the public demo's local backend. The private edition adds:

| Method   | Path                                   | Purpose                                       |
| -------- | -------------------------------------- | --------------------------------------------- |
| GET      | `/api/config`                          | Non-secret mode/provider availability         |
| GET      | `/api/session`                         | Authenticated user and CSRF token             |
| POST     | `/api/logout`                          | End current session                           |
| GET      | `/auth/microsoft`, `/auth/google`      | Start university identity flow                |
| GET      | `/auth/:provider/callback`             | Validate callback and create session          |
| POST     | `/api/uploads`                         | Store owner-bound evidence                    |
| GET      | `/api/uploads/:id`                     | Authenticated evidence download               |
| GET/POST | `/api/roster`                          | Chair roster listing and creation             |
| POST     | `/api/roster/:id/deactivate`           | Deactivate member access                      |
| GET      | `/api/audit`                           | Chair audit history                           |
| POST     | `/api/integrations/canvas/connect`     | Start member-authorized Canvas OAuth          |
| POST     | `/api/integrations/canvas/disconnect`  | Remove stored Canvas authorization            |
| GET      | `/api/integrations/canvas/assignments` | Fetch current member's eligible assignments   |
| POST     | `/api/integrations/canvas/import`      | Import selected assignments as pending claims |

Authenticated mutations send `X-CSRF-Token` and are checked against the configured origin. API activity redacts token, CSRF, secret, and file-payload fields. Production identity comes from the server session, never from the demo selector or a body parameter.

## Scholarship policy decisions still needed

Based on the supplied 2026 scholarship plan; the original PDF is not committed:

- Tier 3/4 GPA ranges conflict between pages. Use assigned tiers until the chair resolves the boundaries.
- Multipliers can produce decimals, while the plan prohibits fractional awards and does not define rounding. Require an explicit integer award and a reason for adjustments.
- The demo uses Monday–Sunday weeks and reserves weekly capacity for pending claims; the chapter must confirm this convention.
- Grade-posting date in America/New_York is the import claim date. Confirm that interpretation of the 14-day window.
- The final submission closing date is configurable through `SEMESTER_END_DATE` (the closing date itself, not the end of finals). If unset, there is no automatic semester closure.
- The Fall 2026 point target date is `SEMESTER_TARGET_DATE`. Update dates and policy for a new semester before taking submissions.
- Exact 5% individual course weight is not automatically major or minor.
- Study-night attendance requirements remain separate from points; this portal does not impose sanctions.
- The current policy accepts Google Forms or physical evidence. Approve this portal as a submission channel before replacing that process.
- Academic evidence access stays narrower than general officer access.

## References

- [Microsoft OpenID Connect](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
- [Microsoft ID-token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Canvas OAuth](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth)
- [Canvas developer keys](https://developerdocs.instructure.com/services/canvas/oauth2/file.developer_keys)
- [Canvas assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments)
- [Canvas pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination)

The design follows [ato.org](https://ato.org/). This is an unofficial chapter workflow project, not an official ATO, Florida Tech, Canvas, Google, or Microsoft product.
