# Member account and email rollout

The portal's **Roster** page is the recipient list. Do not upload a second mailing list into Vercel or Supabase. The connected sheet supplies eligible active and new members. The Chair can send invitations together and adjust account details afterward; individual account preparation is optional. The sheet is read-only to the portal.

## What each service does

| Location | Responsibility |
| --- | --- |
| Chapter roster sheet | Names, membership status and the correct school email for each member. |
| Portal → Roster | Select unsent recipients and send setup emails with one batch confirmation. Accounts are created automatically when needed; member details can be edited before or after sending. |
| Supabase Authentication | Store sign-in identities and passwords; send setup and password-reset links through the configured SMTP sender. |
| Supabase Authentication → Emails | Sender/SMTP settings and the hosted invite/reset templates. |
| Supabase Authentication → URL Configuration | Production site address and allowed setup/reset destinations. |
| Vercel → Project Settings → Environment Variables | Server configuration and the switch that enables email actions. No recipient addresses or email password belong in application source code. |

## Optional account setup before sending

1. Sign in as the Scholarship Chair and open **Roster**.
2. Refresh the roster. Correct missing, duplicate or mistyped school emails in the source sheet, then refresh again. Include both active members and new members.
3. If the GPA file is available, import it, select its GPA and 900-number columns, and review the proposed matches and tiers. This can happen before or after invitations. The source GPA and 900 numbers are used temporarily for matching; the portal retains the assigned tier.
4. To configure someone ahead of time, choose **Edit / prepare account**, adjust their details, then **Save without sending email**. This is optional: the bulk invitation action also creates accounts automatically. Members without a badge receive a separate portal sign-in ID.
5. Use **Manage member** to correct existing account details. Saving member details and checking account setup are separate from sending a setup email.

For a new member, account preparation creates and binds an unconfirmed sign-in identity without a password email. It is not evidence that the member has received anything or can already sign in. An interrupted preparation can be checked and resumed without sending mail. Avoid using a 900 number as a badge or portal username. The sign-in email is read-only in account settings: changing it requires a separate reviewed identity update because it binds the account to the roster and Supabase.

## Before the first authorized email

- Confirm the chapter controls the sender inbox and its recovery access. The SMTP password is a dedicated Google App Password entered privately in Supabase, not the normal inbox password.
- Review both hosted email templates against [invite.html](../supabase/email-templates/invite.html) and [recovery.html](../supabase/email-templates/recovery.html). Editing these files in Git does not install them in Supabase. Saving a template sends no email.
- Deploy the portal's token-hash account-link handler before installing these templates. Links open the portal directly; the one-time token is exchanged only after the member submits a valid chosen password. Email link previews and security scanners therefore do not consume the link by opening it. Older access-token links remain supported until they expire.
- The unused setup-link lifetime is seven days (`604800` seconds). On November 10, 2026, the Scholarship Plan project's Supabase `mailer_otp_exp` was changed from one hour to seven days and independently read back through the authorized management connection. This provider setting also controls password-reset links, which the portal uses for setup emails to already-confirmed accounts. JWT/session lifetime and all other settings were left unchanged. Used links and links superseded by a resend can become invalid earlier. A code deployment alone does not change this provider setting; verify it again if the hosted configuration changes.
- Confirm the production Site URL and the exact `/account/setup` and `/account/reset` redirect URLs. Keep public signups disabled and email confirmation enabled.
- Confirm `CHAPTER_EMAIL_READY=true` in Vercel Production and deploy any configuration change. This switch means sending is enabled; it does not prove SMTP delivery works.
- Check **Supabase Authentication → Rate Limits → Email sending** and the sender's own allowance before a full rollout. Supabase initially limits custom SMTP to 30 emails per hour; see [its SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp). The portal does not change this limit.
- Choose an authorized test recipient and separately authorize sending their setup email. No email is automatically authorized by adding a name to the roster or preparing an account.

The application can check its own configuration and account status. It cannot establish inbox delivery merely by checking those settings. The remaining acceptance test uses a real recipient inbox and must be authorized before any message is sent.

## Send and verify deliberately

Under **Account setup & emails**, choose **Review setup email** and separately confirm sending to that recipient. Have the recipient check inbox and spam, open the one-time link, choose a password, save their recovery key, sign out and sign in again. Separately authorize and test password-reset delivery. Only then proceed to an approved small pilot and the remaining approved recipients.

## Send several invitations with one review

1. Open **Roster → Account setup & emails**. Eligible members appear even if they do not have accounts yet. Refresh the roster if necessary.
2. Choose **Select all unsent**, or check individual recipients. Search/status filters narrow what the select-all button adds; previously selected recipients remain selected until cleared.
3. Choose **Send invitations**. One confirmation lists every selected name and email, including selections hidden by a filter. No individual preparation or approval is required.
4. Confirm the batch. The portal creates any missing accounts and sends each member a separate personal setup link. Existing account settings and imported tier assignments are preserved. New accounts without an assigned tier start at Tier 1 with 15 credit hours, matching the existing account-preparation defaults; these are starting values, not verified GPA or enrollment data. New members always start in Tier 1. The Chair can adjust names, badge aliases, tiers and eligible credit settings later through **Manage member**; approved classes determine credit hours once class-based tracking applies.
5. Keep the page open until the batch finishes. Results are saved per recipient. **Stop remaining**, closing the window, or leaving the page stops further requests; an email already being processed may still complete.

The batch excludes previous sends, uncertain deliveries, and known confirmed accounts. It stops at the first error, including a sender limit, instead of automatically retrying. After resolving the issue, refresh and select the remaining ready recipients. A definite rate-limit rejection becomes eligible again after its displayed waiting period; an uncertain result must be checked individually before an explicit resend. Provider acceptance is not proof of inbox delivery.

| Status | Meaning and next step |
| --- | --- |
| Account ready | Account preparation completed. It does not establish that an email has been sent. |
| Email service accepted | The provider accepted the send request. Verify receipt in the recipient's inbox. |
| Delivery unknown | A timeout or interruption obscured the result. Check the inbox before choosing to resend. |
| Preparation interrupted | Check account setup to resume safely; this check does not send email. |

Repeated preparation or status checks must not send a second email. Sending/resending remains an explicit action with a cooldown; there is no automatic background email retry. For an already confirmed account, the setup action uses the password-reset template to reach the same setup page.

Use the broader [launch checklist](LAUNCH-CHECKLIST.md) for the Chair's policy decisions, member privacy checks, syllabus approvals and operational readiness. Email delivery alone does not establish that the portal is ready for the whole chapter.
