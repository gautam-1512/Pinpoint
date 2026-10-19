/* =========================================================================
   Pinpoint — configuration
   -------------------------------------------------------------------------
   This is the ONLY file you need to edit after setting up Supabase.
   Paste your two values between the quotes below, save, and upload this
   file to GitHub together with the others.

   Where to find them in Supabase:
     Project Settings → API Keys (or the green "Connect" button at the top)
       • Project URL            → looks like https://abcdefghij.supabase.co
       • Publishable key        → starts with  sb_publishable_
         (older projects call it the "anon public" key, starts with eyJ...)

   Both values are SAFE to put on a public website. Your data is protected
   by the sign-in + access rules created by supabase-setup.sql, not by
   hiding these values.

   NEVER paste the "secret" key or the "service_role" key here.
   ========================================================================= */

window.PINPOINT_CONFIG = {
  // 1) Your Supabase Project URL
  SUPABASE_URL: "https://yvyqyatslvwhpfjvjbgx.supabase.co",

  // 2) Your Supabase publishable (or "anon public") key
  SUPABASE_KEY: "sb_publishable_nTDQ0zuEpwXMEBE_gB_Xxw_hVbt9dji",

  // 3) Your company email domain. Only used for hints on the sign-in
  //    screen — who can actually get in is decided by the database
  //    (the domain in supabase-setup.sql + the allowed_emails guest list).
  ALLOWED_EMAIL_DOMAIN: "sureshield.ai",

  // 4) The shared "reviewers" account you create in Supabase
  //    (Authentication → Users → Add user). Review links sign people in
  //    with this account automatically, so they don't need their own login.
  //    Only the EMAIL goes here — never the passcode. Leave it empty ("")
  //    to turn link-only access off and make everyone sign in by email.
  SHARED_LOGIN_EMAIL: "reviewers@sureshield.ai",
};
