# Exact setup: use Foundly on two laptops

This guide sets up one online copy of Foundly. Both laptops will open the same website and use the same Supabase cloud project for accounts, photos, reports, matches, and chats.

## Storage and photo permission

Foundly does **not** need full access to either laptop's storage. When someone posts an item, they click **Add a photo** and choose one image in the browser's file picker. The browser grants access to that selected image only. Foundly previews and compresses the image, then uploads it to Supabase Storage in the signed-in person's folder.

The SQL setup creates a bucket named `item-photos`. The bucket is public so photos can appear on the community board; anyone with a photo URL can view that image. Uploads and deletes are restricted by database policies. Do not upload private or sensitive photos. Emails and phone numbers are kept in a separate private table, and a finder must choose to share their phone for an individual match.

If you meant access for Codex to a different laptop folder, this project folder is already accessible. Provide the exact folder path if you need work on files outside this project; full-disk access is not needed to run Foundly.

## One-time setup

### 1. Push this project to GitHub

Create a new **empty** GitHub repository named `foundly-online`. Do not initialize it with a README, license, or `.gitignore` because this project already has those files.

Open PowerShell and copy/paste these commands. Replace `YOUR-USERNAME` with your GitHub username:

```powershell
Set-Location "C:\Users\bprak\Documents\Codex\2026-11-08\i-w\outputs\foundly-online"
git status --short
git remote add origin https://github.com/YOUR-USERNAME/foundly-online.git
git push -u origin main
```

The `git status` command should show no changed files. If Git says `remote origin already exists`, use this instead of `git remote add`:

```powershell
git remote set-url origin https://github.com/YOUR-USERNAME/foundly-online.git
git push -u origin main
```

GitHub may open a browser sign-in or ask you to authenticate. Complete that prompt in the browser.

### 2. Create the shared database and photo bucket

1. Go to [Supabase Dashboard](https://supabase.com/dashboard) and create a project. Save the database password somewhere private; Foundly does not need that password in its website.
2. In the Supabase project, open **SQL Editor → New query**.
3. In a second PowerShell window, copy the project migration to your clipboard:

   ```powershell
   Set-Location "C:\Users\bprak\Documents\Codex\2026-11-08\i-w\outputs\foundly-online"
   Get-Content ".\supabase\migrations\0001_foundly.sql" -Raw | Set-Clipboard
   ```

4. Click the SQL Editor, paste with **Ctrl+V**, then click **Run**. Run this migration once. It creates the tables, row access rules, Storage bucket and upload rules, and realtime settings. The storage bucket is public for board photos.
5. In Supabase, open **Project Settings → API Keys** (or the project's **Connect** dialog). Copy the **Project URL** and **Publishable key**. Do not copy a secret key for the website.

### 3. Deploy matching and keep the Gemini key private

In PowerShell, from the Foundly Online folder, run these commands one at a time:

```powershell
Set-Location "C:\Users\bprak\Documents\Codex\2026-11-08\i-w\outputs\foundly-online"
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy match-report
```

Replace `YOUR_PROJECT_REF` with the project reference shown in your Supabase project URL. For example, in `https://abc123.supabase.co`, the project reference is `abc123`.

For Gemini photo matching, get a Gemini key from [Google AI Studio](https://aistudio.google.com/app/apikey). In Supabase, open **Edge Functions → Secrets**, add a secret named `GEMINI_API_KEY`, paste the key as its value, and save. Do not add the Gemini key to the website, `.env.local`, GitHub, or Netlify. Gemini is optional; the app still calculates local match suggestions without it.

### 4. Publish the website on Netlify

1. Sign in to [Netlify](https://app.netlify.com/) and choose **Add new site → Import an existing project**.
2. Connect GitHub, choose the `foundly-online` repository, and authorize access if asked.
3. In the site's build settings, the project should use:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Before deploying, add these two variables under **Site configuration → Environment variables**:
   - Name: `VITE_SUPABASE_URL` · Value: your Supabase Project URL
   - Name: `VITE_SUPABASE_PUBLISHABLE_KEY` · Value: your Supabase Publishable key
5. Click **Deploy**. Wait until Netlify shows the site as published. Copy the website address; it will look like `https://your-site-name.netlify.app`.

Netlify reads the same build command and `dist` publish folder from this project's `netlify.toml` file. ([Netlify Vite setup](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/))

### 5. Allow sign-in redirects for the deployed website

1. Return to Supabase and open **Authentication → URL Configuration**.
2. Set **Site URL** to your Netlify website address, for example `https://your-site-name.netlify.app`.
3. Add this to **Redirect URLs**:

   ```text
   https://your-site-name.netlify.app/**
   ```

4. Save the settings. Use your real Netlify address, not the example above.

## Use the same live app on both laptops

1. On laptop one, open the Netlify website address and select **Sign in → Create account**. Use an email you can confirm if email confirmation is enabled.
2. On laptop one, select **Add an item**, choose **Lost**, pick a photo, enter the item name, category, color, place, date, and useful distinguishing details, then post it.
3. On laptop two, open the **same Netlify website address** and create a separate account.
4. On laptop two, add the item as **Found**, choose its photo, and fill in matching clues. Post it.
5. Open **Matches** on either laptop. Foundly shows the fit score and clues; it may take a moment for Gemini to update the local score if Gemini is configured.
6. Open the likely match and send a message. The finder can select **Share my number** for that pair. Until the finder does that, the lost-item owner cannot see their phone number.

Both laptops need internet access and should use the same deployed website address. You do not need to install Node.js on the second laptop; a browser is enough.

## Create the admin account

1. First, create a normal account on the live Foundly website using the email address you want as admin. Confirm the email if required.
2. In PowerShell, open the admin bootstrap SQL file in Notepad:

   ```powershell
   Set-Location "C:\Users\bprak\Documents\Codex\2026-11-08\i-w\outputs\foundly-online"
   notepad ".\supabase\bootstrap-admin.sql"
   ```

3. Replace `admin@example.com` with the exact email you just signed up with. Save the file and close Notepad.
4. Copy the edited SQL to the clipboard:

   ```powershell
   Get-Content ".\supabase\bootstrap-admin.sql" -Raw | Set-Clipboard
   ```

5. In Supabase **SQL Editor → New query**, paste with **Ctrl+V** and click **Run**.
6. Open `https://your-site-name.netlify.app/admin.html` and sign in using that account. Only run the bootstrap SQL for an account you trust: admins can view user contact details.

## Optional: preview from this laptop

This is useful while editing the project. In PowerShell:

```powershell
Set-Location "C:\Users\bprak\Documents\Codex\2026-11-08\i-w\outputs\foundly-online"
npm install
Copy-Item .env.example .env.local
notepad .env.local
```

In Notepad, replace the sample values with your Supabase Project URL and Publishable key:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_PASTE_YOUR_KEY_HERE
```

Save and close Notepad, then run:

```powershell
npm run dev
```

Open the local address Vite prints, usually `http://localhost:5173`. `.env.local` is ignored by Git. Do not put the Gemini key in it.

## Common fixes

- **“Connect Supabase” or setup banner:** check the two `VITE_...` variables in Netlify, then trigger **Deploys → Trigger deploy → Clear cache and deploy site**.
- **Sign-up redirects to an error page:** check Supabase **Authentication → URL Configuration** and add the exact deployed Netlify URL to Redirect URLs.
- **Photo upload fails:** confirm you ran `0001_foundly.sql`, are signed in, and selected a JPG, PNG, or WebP photo under 10 MB. The app compresses it before upload.
- **Local matches show but Gemini does not:** confirm `match-report` is deployed and `GEMINI_API_KEY` exists in Supabase **Edge Functions → Secrets**.
- **“This account does not have admin access”:** rerun the bootstrap SQL with the exact email for the signed-up account.
- **Old offline posts are missing:** the old app stored them on that laptop. This online project starts with a new cloud database; old posts are not automatically imported.
