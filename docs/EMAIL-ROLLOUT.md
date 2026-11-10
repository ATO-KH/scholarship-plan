# Member account and email rollout

The portal's **Roster** page is the recipient list. Do not upload a second mailing list into Vercel or Supabase. The connected sheet supplies eligible active and new members. The Chair can send invitations together and adjust account details afterward; individual account preparation is optional. The sheet is read-only to the portal.

## What each service does

| Location | Responsibility |
| --- | --- |
| Chapter roster sheet | Names, membership status and the correct school email for each member. |
| Portal → Roster → Invitations | Select recipients and send or resend setup emails with one batch confirmation. Accounts are created automatically when needed; member details can be edited before or after sending. |
| Supabase Authentication | Store sign-in identities and passwords; send setup and password-reset links through the configured SMTP sender. |
| Supabase Authentication → Emails | Sender/SMTP settings and the hosted invite/reset templates. |
| Supabase Authentication → URL Configuration | Production site address and allowed setup/reset destinations. |
| Vercel → Project Settings → Environment Variables | Server configuration and the switch that enables email actions. No recipient addresses or email password belong in application source code. |

## Optional account setup before sending

1. Sign in as the Scholarship Chair and open **Roster → Roster sheet**.
2. Refresh the roster. Correct missing, duplicate or mistyped school emails in the source sheet, then refresh again. Include both active members and new members.
3. If the GPA file is available, import it, select its GPA and 900-number columns, and review the proposed matches and tiers. This can happen before or after invitations. The source GPA and 900 numbers are used temporarily for matching; the portal retains the assigned tier.
4. To configure someone ahead of time, choose **Edit / prepare account**, adjust their details, then **Save without sending email**. This is optional: the bulk invitation action also creates accounts automatically. Members without a badge receive a separate portal sign-in ID.
5. Use **Roster → Members → Account settings** to correct existing account details. Saving member details and checking account setup are separate from sending a setup email.

For a new member, account preparation creates and binds an unconfirmed sign-in identity without a password email. It is not evidence that the member has received anything or can already sign in. An interrupted preparation can be checked and resumed without sending mail. Avoid using a 900 number as a badge or portal username. The sign-in email is read-only in account settings: changing it requires a separate reviewed identity update because it binds the account to the roster and Supabase.

## Before the first authorized email

- Confirm the chapter controls the sender inbox and its recovery access. The SMTP password is a dedicated Google App Password entered privately in Supabase, not the normal inbox password.
- Review both hosted email templates against [invite.html](../supabase/email-templates/invite.html) and [recovery.html](../supabase/email-templates/recovery.html). Both templates were installed and independently read back on November 10, 2026, after the compatible portal handler was promoted. Only the two template bodies changed; seven-day expiry and other Auth settings were preserved. Editing these files in Git does not install future changes in Supabase. Saving a template sends no email.
- Deploy the portal's token-hash account-link handler before installing these templates. Links open the portal directly; the one-time token is exchanged only after the member submits a valid chosen password. Email link previews and security scanners therefore do not consume the link by opening it. Older access-token links remain supported until they expire.
- The unused setup-link lifetime is seven days (`604800` seconds). On November 10, 2026, the Scholarship Plan project's Supabase `mailer_otp_exp` was changed from one hour to seven days and independently read back through the authorized management connection. This provider setting also controls password-reset links, which the portal uses for setup emails to already-confirmed accounts. JWT/session lifetime and all other settings were left unchanged. Used links and links superseded by a resend can become invalid earlier. A code deployment alone does not change this provider setting; verify it again if the hosted configuration changes.
- Confirm the production Site URL and the exact `/account/setup` and `/account/reset` redirect URLs. Keep public signups disabled and email confirmation enabled.
- Confirm `CHAPTER_EMAIL_READY=true` in Vercel Production and deploy any configuration change. This switch means sending is enabled; it does not prove SMTP delivery works.
- Check **Supabase Authentication → Rate Limits → Email sending** and the sender's own allowance before a full rollout. Supabase initially limits custom SMTP to 30 emails per hour; see [its SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp). The portal does not change this limit.
- Choose an authorized test recipient and separately authorize sending their setup email. No email is automatically authorized by adding a name to the roster or preparing an account.

The application can check its own configuration and account status. It cannot establish inbox delivery merely by checking those settings. The remaining acceptance test uses a real recipient inbox and must be authorized before any message is sent.

## Send and verify deliberately

Under **Roster → Invitations**, choose **Review invitation** or **Review resend** and separately confirm sending to that recipient. Have the recipient check inbox and spam, open the one-time link, choose a password, save their recovery key, sign out and sign in again. Separately authorize and test password-reset delivery. Only then proceed to an approved small pilot and the remaining approved recipients.

## Send several invitations with one review

1. Open **Roster → Invitations**. Eligible members appear even if they do not have accounts yet. Refresh the roster if necessary.
2. Choose **Select all unsent**, **Select all not accepted**, **Select all expired**, or check individual recipients. Search/status filters narrow what the select-all button adds; previously selected recipients remain selected until cleared.
3. Choose **Review N emails**. One confirmation lists every selected name and email, including selections hidden by a filter. No individual preparation or approval is required.
4. Confirm the batch. The portal creates any missing accounts and sends each member a separate personal setup link. Existing account settings and imported tier assignments are preserved. New accounts without an assigned tier start at Tier 1 with 15 credit hours, matching the existing account-preparation defaults; these are starting values, not verified GPA or enrollment data. New members always start in Tier 1. The Chair can adjust names, badge aliases, tiers and eligible credit settings later through **Members → Account settings**; approved classes determine credit hours once class-based tracking applies.
5. Keep the page open until the batch finishes. Results are saved per recipient. **Stop remaining**, closing the window, or leaving the page stops further requests; an email already being processed may still complete.

The batch distinguishes first invitations from resends and lists both before confirmation. Confirmed accounts are excluded; each pending-only resend checks the account again and skips a member who accepted after selection. Resends never become password-reset emails for confirmed members. A stale reviewed invitation cannot be replayed, even after the sending cooldown. The batch stops at the first error or rate limit without automatic retry. Refresh status and review the remaining recipients before continuing. Uncertain deliveries may already have arrived, so check the inbox before explicitly selecting a resend. Sending does not prove inbox delivery.

| Status | Meaning and next step |
| --- | --- |
| Not invited | Eligible for a first invitation; the account can be created automatically. |
| Awaiting acceptance | A link was issued and has not expired. The account email has not been verified. |
| Accepted | Supabase reports a verified account email. This is not an email-open tracker or proof the member completed every onboarding step. No invitation reminder is needed. |
| Expired | An unaccepted link is at least seven days old. Review a resend for a fresh link. |
| Delivery uncertain | A timeout or interruption obscured the email result. Check the inbox before explicitly resending. |
| Check setup / Needs attention | Check the account connection; this operation sends no email. |

Status checks use one paginated server-side Auth listing, restricted to existing chapter identity bindings. If that read fails, pending resends are disabled and previously recorded acceptance stays visible. Refreshing status never sends mail. Password resets for already accepted members remain a separate action under **Members → Access options**.

Use the broader [launch checklist](LAUNCH-CHECKLIST.md) for the Chair's policy decisions, member privacy checks, syllabus approvals and operational readiness. Email delivery alone does not establish that the portal is ready for the whole chapter.
