# Pinpoint

A zero-build web app for Figma-style review comments on HTML pages, PDFs,
Word docs and PowerPoint decks — shared **live** with your whole team.

The app itself is plain static files, so it can be hosted for free on
GitHub Pages. Everything that has to be shared between people — the
projects, the uploaded files and the comments — lives in a free
[Supabase](https://supabase.com) project. When anyone adds, resolves or
deletes a comment, every other open browser updates within a second.

> **First time?** Follow `SETUP-GUIDE` (the step-by-step guide that came
> with these files). It takes about 20 minutes and needs no coding.

## What it does

1. **Open a review link — that's it.** Every **Share** link carries the
   team passcode (`#/project/<id>?key=<passcode>`), which signs the reviewer
   into a shared `reviewers@…` account automatically. No account or email
   needed. Each browser asks for a display name once. Alternatively, people
   can type the passcode, or sign in with their own email (company domain or
   the `allowed_emails` guest list) via a one-click email link.
2. **Dashboard** — every project the team has created, with file type,
   number of open comments, who created it, and dates. Updates live.
3. **+ New Project** — name it and upload an `.html`, `.pdf`, `.docx` or
   `.pptx` (up to 50 MB). It's stored in Supabase, so the whole team sees it.
4. **Viewer** — HTML runs live in a sandboxed iframe, PDFs render page by
   page (pdf.js), DOCX is converted to HTML (mammoth.js), PPTX gets a
   best-effort text/image preview.
5. **Comment mode** — click anywhere to drop a numbered pin and type a note.
   Pins stick to the spot you clicked: on HTML pages they scroll with the
   page; on PDFs/slides they stick to the page or slide.
6. **Live** — the green “Live” dot means you're connected. New comments
   from teammates pop in with a notification; resolves and deletes sync too.
7. **Share** — copies a link straight to the project. Teammates open it,
   sign in once, and land on the project.
8. **Export for Claude (.md)** — a clean, numbered summary of every comment
   (author, position, element, page) to paste into a Claude chat with
   “please make these edits”. **Export JSON** / **Import** are still there
   for moving comments between workspaces.

## Files

```
index.html          app shell: sign-in, dashboard and viewer screens
app.js              all logic (auth, routing, rendering, pins, live sync, export/import)
styles.css          styling
config.js           ← your Supabase URL + publishable key go here (the only file you edit)
supabase-setup.sql  run once in Supabase's SQL Editor: tables, access rules, storage, live updates
sample/sample.html  optional demo page for the "Use the sample page" button
README.md
```

## How sharing works now

| Thing | Where it lives |
|---|---|
| Projects | Supabase table `projects` |
| Uploaded files | Supabase Storage bucket `review-files` (private) |
| Comments | Supabase table `comments` |
| Live updates | Supabase Realtime on both tables |
| Who can get in | Anyone holding a review link / the team passcode (shared Supabase user), plus email sign-in for your company domain and the `allowed_emails` guest list. Change the passcode by recreating the shared user — old links stop working |

The Supabase URL and publishable key in `config.js` are meant to be public.
What protects your documents is the sign-in plus the row-level-security
rules in `supabase-setup.sql`: without a signed-in company account, the
database returns nothing and refuses every write. Never put the *secret*
(or `service_role`) key in `config.js`.

## Moving over from the old, browser-only version

The old version kept projects in each browser's IndexedDB and comments in
localStorage, which is why comments never showed up for anyone else.

When someone who used the old version signs in, the dashboard shows a
banner: **“Found N project(s) saved only in this browser.”** Clicking
**Upload to shared workspace** uploads those files and comments. If the
project already exists in the shared workspace, only the missing comments
are added. Ask anyone who left comments in the old version (e.g. your
reviewer) to open the new site and click it once.

If your site still has an old hosting bundle deployed (`projects.json`,
`content/`, `comments/`), the banner picks those up too. Once everything is
uploaded you can delete those three from the repository.

## Running it locally

Serve the folder over http (sign-in links and live updates don't work from
`file://`):

```bash
python -m http.server 8080
```

Then open `http://localhost:8080` and add `http://localhost:8080/**` to the
Redirect URLs in Supabase (Authentication → URL Configuration).

## Free-plan limits worth knowing

- **Sign-in emails:** Supabase's built-in email sender only allows a couple
  of emails per hour for the whole project. Each person only needs one per
  browser (they stay signed in), but if you onboard several people at once,
  set up custom SMTP (Authentication → Emails → SMTP Settings) with any
  transactional email provider.
- **Pausing:** free Supabase projects pause after a week with no activity.
  If the app says it can't reach Supabase, open the Supabase dashboard and
  click **Restore project**.
- **Storage:** 1 GB total, 50 MB per file.

## Format support & limitations

| Type | Rendering | Fidelity |
|------|-----------|----------|
| HTML | Sandboxed `<iframe srcdoc>` — scripts, CSS, links, scroll all work | Very high |
| PDF  | pdf.js renders each page to a canvas | High |
| DOCX | mammoth.js converts to HTML | Approximate — fine for text/structure review |
| PPTX | JSZip parses slide XML for text + first image per slide | Approximate only — a banner says so |

## Data model

`projects`: `id, name, file_name, file_type, file_path, created_by, created_at, updated_at`

`comments`: `id, project_id, number, x, y, page, anchor, text, author, author_email, element_selector, status, created_at, updated_at`

`anchor` says how `x`/`y` are measured:

- `html` — `x` is % of the page width, `y` is pixels from the top of the HTML page
- `page` — `x`/`y` are % of PDF page / PPTX slide number `page`
- `content` (or empty) — `x`/`y` are % of the whole content area (DOCX, and comments from the old version)

Comment numbers are assigned by the database, so two people commenting at
the same moment never get the same number.

## Libraries (CDN, no build step)

- [supabase-js v2](https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2) — database, storage, realtime, sign-in
- [pdf.js 3.11.174](https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js)
- [mammoth.js 1.6.0](https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js)
- [JSZip 3.10.1](https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js)
