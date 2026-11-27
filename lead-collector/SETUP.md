# TGE Lead Collector – Setup (about 10 minutes)

This replaces Formspree. Each website signup is:

1. saved to the **TGE Lead List** sheet, in a new **Website Signups** tab (always first, so nothing is lost),
2. added to the **Leads** tab (your CRM). If she's already there, a note is added to her existing row instead,
3. added to the right **Sender group**, which starts that group's automation. If Sender is down, it retries every 10 minutes and emails you if a lead keeps failing.

## Step 1 – Create the script
1. Open the **TGE Lead List** Google Sheet → **Extensions → Apps Script**.
2. Delete everything in `Code.gs` and paste in the full contents of `lead-collector/Code.gs` from this repo.
3. Click the **⚙ Project Settings** icon:
   - tick **"Show appsscript.json manifest file in editor"**, then go back to the Editor, open `appsscript.json` and replace its contents with `lead-collector/appsscript.json`.
   - set **Time zone** to *(GMT+11:00) Sydney*.
4. Name the project **TGE Lead Collector** and click **Save**.

## Step 2 – Add your Sender token (only you do this)
1. In Sender: **Account settings → API access tokens → Create token**. Copy it.
2. In Apps Script: **⚙ Project Settings → Script properties → Add script property**:
   - Property: `SENDER_TOKEN`, Value: *(paste the token)*
   - Optional: `ALERT_EMAIL`, Value: the inbox where failure alerts should go.
3. Save.

## Step 3 – Run setup once
1. Back in the Editor, pick **setup** in the function dropdown → **Run**.
2. Google asks for permission → choose your account → **Advanced → Go to TGE Lead Collector → Allow**.
3. Open **Execution log**. It must say **"All good ✓ Sender token works and all … groups were found."**
   If it lists a missing group, fix the name in the new **Form Settings** tab of the sheet so it matches Sender exactly, then run `checkSender`.
4. Optional: run **testSignup**. It sends a test signup with your own email. Check the Website Signups tab, the Leads tab and the Sender group *Future trips*, then delete the test rows and remove yourself from the group.

## Step 4 – Publish it as a web app
1. **Deploy → New deployment → ⚙ Select type → Web app**.
2. Description: `v1`. **Execute as: Me**. **Who has access: Anyone**.
3. **Deploy** → copy the **Web app URL** (it ends in `/exec`).
4. Send that URL to Claude. It goes into `tge-forms.js` and the forms, then the pull request can be merged.

> Later code changes: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. This keeps the same URL.

## Where each form goes (edit any time in the "Form Settings" tab)

| Form | Sender group (starts emails) |
|---|---|
| Homepage VIP popup | Future trips |
| Bali popup + Register Interest | Bali brochure |
| Komodo popup + Register Interest | Komodo interest |
| Maldives popup + Register Interest | Maldives VIP / interest |
| All "Have a Question?" contact forms | Enquiries (activate the *4. Enquiry auto-reply* automation in Sender) |
| Travel Identity quiz (not booked) | Travel Identity |
| Travel Identity quiz (already booked) | Booked guests (no emails triggered) |

Every website lead is also added to **TGE Leads (all)**, your master list for campaigns. Booked guests are the exception.
