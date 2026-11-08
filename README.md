# Foundly Online

Foundly Online is the shared, multi-device version of the lost-and-found app. A person can post a lost item from one laptop and another person can post a found item from a different laptop. Both browsers use the same Supabase project, so listings, match scores, chats, and opt-in phone sharing are available on the shared board.

The earlier laptop-only version is kept separately in `outputs/foundly-offline`. This folder is the new online project.

## What it includes

- Separate community and admin sign-in pages.
- Lost and found listings with compressed item photos and searchable descriptions.
- Automatic local clue scoring plus optional Gemini photo and description analysis. Scores are fit estimates, not probabilities or proof of ownership.
- Private chat between the owners of a matched lost/found pair.
- Finder phone numbers remain private unless that finder shares the number for a specific pair. The lost-item owner can then call; the finder can revoke access.
- Admin view for user contact details and all listings, with hide/reopen/delete actions and CSV export.
- Shared updates across browsers through Supabase Realtime.

## Before using it on two laptops

The project files are local, but the *app data* is stored in one Supabase cloud project. Both laptops must open the same deployed website and use the same Supabase project settings. Running the website on `localhost` on two laptops creates two separate browser addresses; it does not connect those laptops to each other.

The online app needs an internet connection. Existing accounts, posts, chats, and photos from the offline version do not copy themselves into Supabase. This new project starts with an empty online board.

## 1. Create the shared Supabase project

1. Create a project at [Supabase](https://supabase.com/dashboard).
2. In the project **SQL Editor**, run the full contents of [`supabase/migrations/0001_foundly.sql`](supabase/migrations/0001_foundly.sql). This creates the tables, access rules, public listing-photo bucket, and user signup trigger.
3. In **Authentication → URL Configuration**, set the Site URL to the site URL you will deploy. Add that URL and its auth callback URL to the allowed redirect URLs. While developing locally, also allow `http://localhost:5173/**`.
4. Copy the project URL and publishable key from **Project Settings → API**. A publishable key is intended for the browser; never use a service-role/secret key in the website.

The database uses row-level security. Users can read public listings and their own profile. Only admins can read the private account table. The listing photos are in a public bucket because listing photos appear on the public board; do not upload sensitive images. Phone and email are in a separate private table.

## 2. Run the website locally

Install Node.js 20.19+ (or Node.js 22+) and open PowerShell in this folder:

```powershell
npm install
Copy-Item .env.example .env.local
```

Open `.env.local` and replace the sample values with your Supabase project URL and publishable key. Then run:

```powershell
npm run dev
```

Vite prints a local address, usually `http://localhost:5173`. The local server is for development on this laptop. To use the app across different networks, deploy the site in the next section.

## 3. Enable Gemini matching

Gemini is optional. Without a Gemini key, the server still generates local match suggestions from the category, color, place, description, and dates. With Gemini, the Supabase Edge Function also sends candidate item photos and listing clues to Google for image-aware scoring. Account names, email addresses, and phone numbers are not included in that request.

Deploy the function using the [Supabase CLI](https://supabase.com/docs/guides/cli):

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy match-report
```

Then, in the Supabase dashboard, add `GEMINI_API_KEY` under **Edge Functions → Secrets**. Optionally add `GEMINI_MODEL` to choose another supported Gemini model. The function defaults to `gemini-3.8-flash`. Keep the Gemini key in Supabase secrets; do not put it in `.env.local`, a `VITE_` variable, or GitHub.

## 4. Create the separate admin account

1. Sign up from the community page using the email address you want to use as admin. Confirm the email if Supabase email confirmation is enabled.
2. In Supabase **SQL Editor**, open [`supabase/bootstrap-admin.sql`](supabase/bootstrap-admin.sql), replace `admin@example.com` with that account's exact email, and run it.
3. Sign in at `/admin.html`. The admin page checks the server-side role; changing the page URL does not grant admin access.

Only the project owner should run the bootstrap SQL. Admins can see personal contact details to manage the community, so choose a trusted account.

## 5. Deploy so both laptops can use it

This is a static Vite site and includes a Netlify build file. For example, create a Netlify site from the GitHub repository, then set these build environment variables in Netlify:

- `VITE_SUPABASE_URL` — the Supabase project URL
- `VITE_SUPABASE_PUBLISHABLE_KEY` — the Supabase publishable key

Build command: `npm run build`  
Publish directory: `dist`

After deployment, set the deployed site URL in Supabase **Authentication → URL Configuration** and add it to the allowed redirect URLs. Open that same deployed URL on both laptops, create/sign into accounts, and add listings. New listings trigger the match function and both browsers receive shared board updates.

## GitHub

This folder is initialized as a Git repository with a local first commit. `.env.local`, dependency folders, build output, and Supabase local secrets are ignored by Git. Create an empty GitHub repository, then connect and push it from PowerShell in this folder:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/foundly-online.git
git push -u origin main
```

Replace the example URL with the new repository's URL. Do not commit API secrets, personal user data, or private photos.

## Data and privacy notes

- Listing descriptions, locations, usernames, and listing photos are visible to people who can access the public board. Ask users not to put home addresses or sensitive information in listings.
- Listing photos are public URLs so they can be displayed on the board. The Supabase bucket restricts uploads to each signed-in user's folder.
- Email and phone are stored separately from public listings. Community users can read their own contact record; admins can review accounts. The finder phone RPC returns a phone number only to the owner of the paired lost listing after the finder opted in.
- Chats are readable only by the two report owners. Messages and phone shares are stored in Supabase, shared across devices, and tied to report ownership.
- Gemini receives only candidate listing details and photos. The app asks users not to include contact information in public descriptions, and its Gemini prompt omits account contact fields.
- Match scores are suggestions to help people review possible matches. Confirm distinctive marks or ownership details in chat before arranging a handoff.
