-- 1. Create the account through the regular Foundly sign-up flow first.
-- 2. Replace the email below with that account's exact email and run this in
--    the Supabase SQL Editor while signed in as the project owner.
-- Admin role changes are deliberately unavailable from the browser client.
update public.profiles_private
set role = 'admin'
where lower(email) = lower('admin@example.com');
