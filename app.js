/* =========================================================================
   Pinpoint — app.js  (shared, real-time version)
   Vanilla JS. No build step. Hosted as static files (e.g. GitHub Pages);
   all shared data lives in Supabase:

     • projects     → Supabase table  public.projects
     • the files    → Supabase Storage bucket  "review-files"
     • comments     → Supabase table  public.comments
     • live updates → Supabase Realtime (postgres_changes)
     • sign-in      → Supabase Auth magic link, company email domain only

   Settings come from config.js (window.PINPOINT_CONFIG).

   Also handles:
     - hash routing: '#/' (or empty) = dashboard, '#/project/<id>' = viewer
     - file rendering per type (HTML / PDF / DOCX / PPTX)
     - comment-mode pin dropping + popovers + sidebar
     - export comments as Markdown (for Claude) or JSON; import JSON
     - one-click upload of projects left in a browser by the old,
       browser-only version (IndexedDB + localStorage, or a deployed
       projects.json bundle)
   ========================================================================= */

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants / state
  // ---------------------------------------------------------------------
  const CFG = window.PINPOINT_CONFIG || {};
  const BUCKET = "review-files";
  const MAX_FILE_BYTES = 50 * 1024 * 1024; // Supabase free-plan per-file limit

  const LS_AUTHOR = "cr_author_name";
  const LS_COMMENTS_PREFIX = "cr_comments_";      // legacy (old version) comments, + projectId
  const LS_MIGRATED_IDS = "pp_migrated_project_ids";
  const LS_RETURN_HASH = "pp_return_hash";
  const LS_TEAM_KEY = "pp_team_key";       // team passcode, remembered so Share links can carry it
  const LS_CLIENT_ID = "pp_client_id";     // per-browser id, tells people on the shared account apart
  const SS_MIGRATE_DISMISSED = "pp_migrate_dismissed";
  const LEGACY_DB_NAME = "comment-review-db";
  const LEGACY_STORE = "projects";

  let sb = null;            // Supabase client
  let user = null;          // signed-in Supabase user
  let channel = null;       // realtime channel
  let liveState = "connecting";
  let hadLiveDrop = false;
  let routeWired = false;
  let dashRefreshTimer = null;
  let legacyCandidates = [];
  let lastOtpEmail = "";

  const blobCache = new Map(); // projectId -> Blob (downloaded file)

  const state = {
    view: null,            // 'dashboard' | 'viewer'
    projectId: null,
    projectName: null,
    fileName: null,
    fileType: null,        // 'html' | 'pdf' | 'docx' | 'pptx'
    filePath: null,        // storage path of the file currently shown
    fileBlob: null,
    comments: [],
    mode: "browse",        // 'browse' | 'comment'
    currentPage: 1,
    totalPages: 1,
    pendingPin: null,      // { pin, pop, coords }
    openPopoverId: null,
    openToken: 0,
    cleanup: [],           // functions to run before re-rendering content
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------
  function uid(prefix) {
    return (prefix || "c") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function extToType(name) {
    const ext = (name || "").split(".").pop().toLowerCase();
    if (ext === "html" || ext === "htm") return "html";
    if (ext === "pdf") return "pdf";
    if (ext === "docx") return "docx";
    if (ext === "pptx") return "pptx";
    return null;
  }

  const MIME = {
    html: "text/html",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };

  const TYPE_META = {
    html: { label: "HTML", color: "#3457d5", icon: "🌐" },
    pdf: { label: "PDF", color: "#d6453e", icon: "📕" },
    docx: { label: "DOCX", color: "#2b579a", icon: "📘" },
    pptx: { label: "PPTX", color: "#d24726", icon: "📙" },
  };

  function toast(msg, ms) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.remove("show"), ms || 2600);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function download(filename, blob) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function slug(name) {
    return (name || "file").replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  }

  // Storage object names must be simple; keep the extension.
  function safeFileName(name) {
    const m = (name || "file").match(/^(.*?)(\.[^.]+)?$/);
    const base = (m[1] || "file").normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
    const ext = (m[2] || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
    return base.slice(0, 80) + ext;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function timeAgo(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return d.toLocaleDateString();
  }

  function allowedDomain() {
    return String(CFG.ALLOWED_EMAIL_DOMAIN || "").trim().replace(/^@/, "").toLowerCase();
  }

  function sharedEmail() {
    const e = String(CFG.SHARED_LOGIN_EMAIL || "").trim().toLowerCase();
    return e && !e.includes("paste") ? e : "";
  }

  function isSharedAccount() {
    return !!(user && sharedEmail() && String(user.email || "").toLowerCase() === sharedEmail());
  }

  function clientId() {
    let id = localStorage.getItem(LS_CLIENT_ID);
    if (!id) { id = uid("u"); localStorage.setItem(LS_CLIENT_ID, id); }
    return id;
  }

  // A review link looks like  …/#/project/<id>?key=<passcode>
  // Pull the passcode out of the address bar (so it isn't left on screen or
  // in browser history) and return it.
  function takeKeyFromUrl() {
    const h = location.hash || "";
    const m = h.match(/[?&#]key=([^&]*)/);
    if (!m) return null;
    let key = "";
    try { key = decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (e) { key = m[1]; }
    let clean = h.replace(/[?&]key=[^&]*/, "").replace(/^#key=[^&]*&?/, "#").replace(/\?$/, "");
    if (clean === "#" || clean === "") clean = "#/";
    history.replaceState(null, "", location.pathname + location.search + clean);
    return key || null;
  }

  function notAllowedMessage(email) {
    const d = allowedDomain();
    return `${email} isn't on the Pinpoint access list.` +
      (d ? ` Use your @${d} address, or` : "") +
      " ask whoever runs Pinpoint to add this address to the guest list.";
  }

  // The database is the single source of truth for who may use Pinpoint
  // (company domain + guest list). If the check itself can't run (older
  // setup file, network blip) we let the person in; the database rules
  // still block anything they're not allowed to see.
  async function isAllowedByDatabase() {
    try {
      const { data, error } = await sb.rpc("is_team_member");
      if (error) return true;
      return data !== false;
    } catch (e) {
      return true;
    }
  }

  function emailLocalPart(email) {
    const local = String(email || "").split("@")[0] || "";
    return local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }

  // Turn Supabase / network errors into something a non-developer can act on.
  function friendlyError(err) {
    const msg = String((err && (err.message || err.error_description || err.error)) || err || "");
    const low = msg.toLowerCase();
    if (low.includes("failed to fetch") || low.includes("networkerror") || low.includes("load failed")) {
      return "Can't reach Supabase. Check your internet connection. If nobody has used Pinpoint for a week, the free Supabase project may be paused — open supabase.com/dashboard and click “Restore project”.";
    }
    if (low.includes("row-level security") || low.includes("violates row-level") || low.includes("permission denied")) {
      return "Your account isn't allowed to do that. Make sure you signed in with your company email.";
    }
    if (low.includes("bucket not found")) {
      return "The file storage bucket is missing. Run supabase-setup.sql again in the Supabase SQL Editor.";
    }
    if ((low.includes("relation") && low.includes("does not exist")) || low.includes("could not find the table")) {
      return "The Pinpoint tables don't exist yet. Run supabase-setup.sql in the Supabase SQL Editor.";
    }
    if (low.includes("payload too large") || low.includes("exceeded the maximum allowed size") || low.includes("entity too large")) {
      return "That file is too big. The free Supabase plan allows files up to 50 MB.";
    }
    if (low.includes("jwt expired")) {
      return "Your session expired. Refresh the page and sign in again.";
    }
    return msg || "Something went wrong.";
  }

  // ---------------------------------------------------------------------
  // Row <-> app-object mapping
  // ---------------------------------------------------------------------
  function projectFromRow(r) {
    return {
      id: r.id,
      name: r.name,
      fileName: r.file_name,
      fileType: r.file_type,
      filePath: r.file_path,
      createdBy: r.created_by || "",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  function commentFromRow(r) {
    let anchor = r.anchor || "content";
    let el = null;
    if (anchor.indexOf("el:") === 0) {
      try { el = JSON.parse(anchor.slice(3)); } catch (e) { el = null; }
      anchor = el && el.r === "html" ? "html" : "content";
    }
    return {
      id: r.id,
      projectId: r.project_id,
      number: r.number,
      x: Number(r.x),
      y: Number(r.y),
      page: r.page == null ? null : Number(r.page),
      anchor,
      anchorRaw: r.anchor || null,
      el,
      text: r.text,
      author: r.author || emailLocalPart(r.author_email) || "Anonymous",
      authorEmail: r.author_email || "",
      authorId: r.author_id || "",
      elementSelector: r.element_selector || "",
      status: r.status || "open",
      timestamp: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function configProblem() {
    const url = String(CFG.SUPABASE_URL || "").trim();
    const key = String(CFG.SUPABASE_KEY || "").trim();
    if (!window.PINPOINT_CONFIG) return "config.js is missing. Upload config.js next to index.html.";
    if (!url || url.includes("PASTE_")) return "Open <code>config.js</code> and paste your Supabase <b>Project URL</b> into <code>SUPABASE_URL</code>.";
    if (!/^https:\/\/.+/.test(url)) return "<code>SUPABASE_URL</code> in config.js should start with <code>https://</code> (for example <code>https://abcdefghij.supabase.co</code>).";
    if (!key || key.includes("PASTE_")) return "Open <code>config.js</code> and paste your Supabase <b>publishable</b> key into <code>SUPABASE_KEY</code>.";
    if (/^sb_secret_/.test(key)) return "You pasted the <b>secret</b> key into config.js. Never put that on a website — use the <b>publishable</b> key (starts with <code>sb_publishable_</code>) instead, and consider rotating the secret key in Supabase.";
    return null;
  }

  const BUILD = "2026-10-20.1";
  window.__PINPOINT_BUILD = BUILD;

  // index.html, app.js and styles.css must come from the same upload. If one
  // of them is stale (not uploaded, or GitHub/browser still serving an old
  // copy) things break in confusing ways, so say so plainly.
  function checkBuild() {
    const metaEl = document.querySelector('meta[name="pinpoint-build"]');
    const htmlBuild = metaEl ? metaEl.content : "(missing)";
    const cssBuild = getComputedStyle(document.documentElement).getPropertyValue("--pinpoint-build").trim().replace(/^["']|["']$/g, "") || "(missing)";
    if (htmlBuild === BUILD && cssBuild === BUILD) return;
    const stale = [htmlBuild !== BUILD ? "index.html" : null, cssBuild !== BUILD ? "styles.css" : null].filter(Boolean);
    const bar = document.createElement("div");
    bar.setAttribute("role", "alert");
    bar.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:9999;background:#b3261e;color:#fff;font:600 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;padding:10px 16px;text-align:center";
    bar.textContent = "Pinpoint files are out of sync (" + stale.join(" and ") + (stale.length > 1 ? " don't" : " doesn't") + " match app.js). Upload index.html, app.js and styles.css together, wait 2 minutes, then press Ctrl+F5.";
    document.body.appendChild(bar);
    console.warn("Pinpoint build mismatch", { app: BUILD, html: htmlBuild, css: cssBuild });
  }

  async function boot() {
    checkBuild();
    wireAuthScreen();
    wireDashboard();
    wireViewerScreen();
    wirePinOverlay();
    wireProjectModal();

    const problem = configProblem();
    if (problem) { showSetupNeeded(problem); return; }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      showSetupNeeded("The Supabase library couldn't load (it comes from cdn.jsdelivr.net). Check your internet connection or ask IT whether that site is blocked, then refresh.");
      return;
    }

    const urlError = readAuthErrorFromUrl();

    sb = window.supabase.createClient(String(CFG.SUPABASE_URL).trim(), String(CFG.SUPABASE_KEY).trim(), {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
    });

    let session = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data && data.session;
    } catch (e) {
      console.warn("getSession failed", e);
    }

    sb.auth.onAuthStateChange((event, s) => {
      // Never await Supabase calls inside this callback (can deadlock) — defer.
      if (event === "INITIAL_SESSION") return; // handled by getSession() above
      setTimeout(() => {
        if (event === "SIGNED_OUT" || !s) { if (user) onSignedOut(); return; }
        if (!user && s && s.user) onSignedIn(s);
        else if (s && s.user) user = s.user;
      }, 0);
    });

    const linkKey = sharedEmail() ? takeKeyFromUrl() : null;

    if (session && session.user) {
      if (linkKey) localStorage.setItem(LS_TEAM_KEY, linkKey);
      await onSignedIn(session);
    } else if (linkKey) {
      const ok = await passcodeSignIn(linkKey);
      if (!ok) showSignIn("This review link's passcode doesn't work any more. Ask for a new link, or enter the current team passcode.");
    } else {
      showSignIn(urlError);
    }
  }

  // Sign in to the shared reviewers account with the team passcode.
  async function passcodeSignIn(pass) {
    if (!sharedEmail() || !pass) return false;
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email: sharedEmail(), password: pass });
      if (error) throw error;
      localStorage.setItem(LS_TEAM_KEY, pass);
      if (data && data.session && !user) await onSignedIn(data.session);
      return true;
    } catch (err) {
      const m = String((err && err.message) || err).toLowerCase();
      if (!m.includes("invalid login") && !m.includes("invalid credentials")) {
        showSignIn(friendlyError(err));
        return true; // a real error was already shown
      }
      return false;
    }
  }

  // Supabase puts sign-in errors (e.g. an expired link) into the URL.
  function readAuthErrorFromUrl() {
    const raw = (location.hash || "").replace(/^#/, "") + "&" + (location.search || "").replace(/^\?/, "");
    const params = new URLSearchParams(raw);
    const desc = params.get("error_description");
    if (!desc) return null;
    history.replaceState(null, "", location.pathname);
    const code = params.get("error_code") || "";
    if (code === "otp_expired" || /expired|invalid/i.test(desc)) {
      return "That sign-in link has expired or was already used. Enter your email to get a new one.";
    }
    return desc.replace(/\+/g, " ");
  }

  // ---------------------------------------------------------------------
  // Auth screens
  // ---------------------------------------------------------------------
  function hideAllScreens() {
    $("#auth-screen").classList.add("hidden");
    $("#dashboard-screen").classList.add("hidden");
    $("#viewer-screen").classList.remove("active");
  }

  function showSetupNeeded(html) {
    hideAllScreens();
    $("#auth-screen").classList.remove("hidden");
    $("#auth-signin").classList.add("hidden");
    $("#auth-setup").classList.remove("hidden");
    $("#auth-setup-msg").innerHTML = html + "<br><br>Follow the setup guide, then refresh this page.";
  }

  function showSignIn(message, isError) {
    hideAllScreens();
    $("#auth-screen").classList.remove("hidden");
    $("#auth-setup").classList.add("hidden");
    $("#auth-signin").classList.remove("hidden");
    $("#code-form").classList.toggle("hidden", !lastOtpEmail);
    showAuthPanel(sharedEmail() && !lastOtpEmail ? "pass" : "email");
    const msg = $("#auth-msg");
    msg.textContent = message || "";
    msg.className = "auth-msg" + (message ? (isError === false ? " ok" : " err") : "");
    const d = allowedDomain();
    $("#auth-email").placeholder = d ? "you@" + d : "you@company.com";
  }

  function showAuthPanel(which) {
    const hasShared = !!sharedEmail();
    const pass = which === "pass" && hasShared;
    $("#pass-panel").classList.toggle("hidden", !pass);
    $("#email-panel").classList.toggle("hidden", pass);
    $("#show-pass-signin").classList.toggle("hidden", !hasShared);
    setTimeout(() => (pass ? $("#auth-pass") : $("#auth-email")).focus(), 50);
  }

  function wireAuthScreen() {
    $("#show-email-signin").addEventListener("click", () => { $("#auth-msg").textContent = ""; showAuthPanel("email"); });
    $("#show-pass-signin").addEventListener("click", () => { $("#auth-msg").textContent = ""; showAuthPanel("pass"); });

    $("#pass-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!sb) return;
      const pass = $("#auth-pass").value;
      const msg = $("#auth-msg");
      if (!pass) return;
      const btn = $("#pass-submit");
      btn.disabled = true;
      btn.textContent = "Opening…";
      msg.className = "auth-msg";
      msg.textContent = "";
      const ok = await passcodeSignIn(pass);
      btn.disabled = false;
      btn.textContent = "Open Pinpoint";
      if (!ok) {
        msg.className = "auth-msg err";
        msg.textContent = "That passcode isn't right. Check with whoever sent you the link.";
      } else {
        $("#auth-pass").value = "";
      }
    });

    $("#auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!sb) return;
      const email = $("#auth-email").value.trim().toLowerCase();
      const msg = $("#auth-msg");
      if (!email) { msg.className = "auth-msg err"; msg.textContent = "Enter your email address."; return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        msg.className = "auth-msg err";
        msg.textContent = "That doesn't look like an email address.";
        return;
      }
      // Remember where the person was heading (e.g. a shared project link).
      const h = location.hash || "";
      if (/^#\/project\//.test(h)) localStorage.setItem(LS_RETURN_HASH, h);

      const btn = $("#auth-submit");
      btn.disabled = true;
      btn.textContent = "Sending…";
      msg.className = "auth-msg";
      msg.textContent = "";
      try {
        const { error } = await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true },
        });
        if (error) throw error;
        lastOtpEmail = email;
        $("#code-form").classList.remove("hidden");
        msg.className = "auth-msg ok";
        msg.innerHTML = `✅ Check your inbox for <b>${escapeHtml(email)}</b> and click the link in the email. You can close this tab.<br><span class="auth-hint">Nothing after 2 minutes? Check spam/junk.</span>`;
      } catch (err) {
        const m = String(err.message || err).toLowerCase();
        msg.className = "auth-msg err";
        if (m.includes("rate limit") || err.status === 429) {
          msg.textContent = "Too many sign-in emails were sent in the last hour (Supabase's free email limit). Wait a while and try again, or set up custom SMTP (see the setup guide).";
        } else if (m.includes("database error saving new user") || m.includes("access list") || m.includes("only @")) {
          msg.textContent = notAllowedMessage(email);
        } else if (m.includes("signups not allowed")) {
          msg.textContent = "New sign-ups are turned off in Supabase. Turn on “Allow new users to sign up” (see the setup guide).";
        } else {
          msg.textContent = friendlyError(err);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = "Send sign-in link";
      }
    });

    // Sign in with the numeric code from the email (works even when a mail
    // scanner has already "clicked" the link and used it up).
    $("#code-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!sb) return;
      const token = $("#auth-code").value.replace(/\s+/g, "");
      const email = lastOtpEmail || $("#auth-email").value.trim().toLowerCase();
      const msg = $("#auth-msg");
      if (!/^\d{6,10}$/.test(token)) {
        msg.className = "auth-msg err";
        msg.textContent = "Enter the numeric code from the email.";
        return;
      }
      const btn = $("#code-submit");
      btn.disabled = true;
      try {
        const { data, error } = await sb.auth.verifyOtp({ email, token, type: "email" });
        if (error) throw error;
        if (data && data.session && !user) await onSignedIn(data.session);
      } catch (err) {
        msg.className = "auth-msg err";
        msg.textContent = /expired|invalid/i.test(String(err.message || err))
          ? "That code is wrong or has expired. Request a new email and use the newest code."
          : friendlyError(err);
      } finally {
        btn.disabled = false;
      }
    });

    $("#sign-out-btn").addEventListener("click", async () => {
      localStorage.removeItem(LS_TEAM_KEY);
      try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
      onSignedOut();
    });
  }

  async function onSignedIn(session) {
    const u = session.user;
    user = u; // set early so the auth listener doesn't run this twice
    if (!(await isAllowedByDatabase())) {
      try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
      user = null;
      showSignIn(notAllowedMessage(u.email));
      return;
    }
    $("#user-email-label").textContent = isSharedAccount()
      ? "Team access" + (localStorage.getItem(LS_AUTHOR) ? " · " + localStorage.getItem(LS_AUTHOR) : "")
      : u.email;

    // Clean leftover sign-in tokens from the URL and restore a saved destination.
    const saved = localStorage.getItem(LS_RETURN_HASH);
    if (/access_token|refresh_token|type=magiclink|type=signup/.test(location.hash)) {
      history.replaceState(null, "", location.pathname + (saved || "#/"));
    } else if (saved && (!location.hash || location.hash === "#/" || location.hash === "#")) {
      history.replaceState(null, "", location.pathname + saved);
    }
    localStorage.removeItem(LS_RETURN_HASH);

    startRealtime();

    if (!routeWired) {
      routeWired = true;
      window.addEventListener("hashchange", route);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && user) resync();
      });
    }
    await route();
  }

  function onSignedOut() {
    user = null;
    stopRealtime();
    blobCache.clear();
    state.projectId = null;
    showSignIn("You're signed out.", false);
  }

  // ---------------------------------------------------------------------
  // Realtime (live updates from everyone)
  // ---------------------------------------------------------------------
  function startRealtime() {
    stopRealtime();
    setLive("connecting");
    channel = sb
      .channel("pinpoint-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, onCommentChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, onProjectChange)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setLive("live");
          if (hadLiveDrop) { hadLiveDrop = false; resync(); }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          hadLiveDrop = true;
          setLive("offline");
        } else if (status === "CLOSED") {
          setLive("offline");
        }
      });
  }

  function stopRealtime() {
    if (channel && sb) {
      try { sb.removeChannel(channel); } catch (e) { /* ignore */ }
    }
    channel = null;
  }

  function setLive(s) {
    liveState = s;
    const label = s === "live" ? "Live" : s === "connecting" ? "Connecting" : "Reconnecting";
    const title = s === "live"
      ? "Live — new comments from your team appear instantly"
      : s === "connecting" ? "Connecting to live updates…" : "Live updates interrupted — retrying. Refresh if this persists.";
    ["#dash-live-dot", "#viewer-live-dot"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.dataset.state = s;
      el.title = title;
    });
    const pill = $("#viewer-live-pill");
    if (pill) { pill.dataset.state = s; pill.title = title; }
    const lbl = $("#viewer-live-label");
    if (lbl) lbl.textContent = label;
  }

  function onCommentChange(payload) {
    const type = payload.eventType;
    const row = type === "DELETE" ? payload.old : payload.new;
    if (!row) return;

    if (state.view === "dashboard") { scheduleDashboardRefresh(); return; }
    if (state.view !== "viewer") return;

    if (type === "DELETE") {
      const before = state.comments.length;
      state.comments = state.comments.filter((c) => c.id !== row.id);
      if (state.comments.length !== before) { renderPins(); renderSidebar(); }
      return;
    }
    if (row.project_id !== state.projectId) return;

    const c = commentFromRow(row);
    const isNew = !state.comments.some((x) => x.id === c.id);
    upsertLocalComment(c);
    renderPins();
    renderSidebar();
    if (type === "INSERT" && isNew && user && !isMine(c)) {
      if (!isSidebarOpen()) $("#comments-toggle-btn").classList.add("has-new");
      toast(`💬 ${c.author} added comment #${c.number}`, 3500);
    }
  }

  function onProjectChange(payload) {
    const type = payload.eventType;
    const row = type === "DELETE" ? payload.old : payload.new;
    if (!row) return;
    if (state.view === "dashboard") { scheduleDashboardRefresh(); return; }
    if (state.view === "viewer" && row.id === state.projectId) {
      if (type === "DELETE") {
        toast("This project was deleted by a teammate.", 3500);
        goToDashboard();
      } else if (type === "UPDATE" && row.name) {
        state.projectName = row.name;
        $("#viewer-filename").textContent = row.name;
        if (row.file_path && row.file_path !== state.filePath) loadNewVersion(projectFromRow(row), true);
      }
    }
  }

  function scheduleDashboardRefresh() {
    clearTimeout(dashRefreshTimer);
    dashRefreshTimer = setTimeout(() => { if (state.view === "dashboard") renderDashboard(true); }, 300);
  }

  // Re-fetch whatever is on screen (after a dropped connection or returning to the tab).
  async function resync() {
    if (!user) return;
    if (state.view === "dashboard") renderDashboard(true);
    else if (state.view === "viewer" && state.projectId) {
      const id = state.projectId;
      try {
        const list = await fetchComments(id);
        if (state.projectId !== id) return;
        state.comments = list;
        renderPins();
        renderSidebar();
      } catch (e) { /* keep what we have */ }
    }
  }

  // ---------------------------------------------------------------------
  // Data access (Supabase)
  // ---------------------------------------------------------------------
  async function fetchProjects() {
    const { data, error } = await sb.from("projects").select("*").order("updated_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(projectFromRow);
  }

  async function fetchProject(id) {
    const { data, error } = await sb.from("projects").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? projectFromRow(data) : null;
  }

  async function fetchOpenCounts() {
    const { data, error } = await sb.from("comments").select("project_id,status");
    if (error) throw error;
    const counts = new Map();
    (data || []).forEach((r) => {
      if (r.status === "resolved") return;
      counts.set(r.project_id, (counts.get(r.project_id) || 0) + 1);
    });
    return counts;
  }

  async function fetchComments(projectId) {
    const { data, error } = await sb.from("comments").select("*").eq("project_id", projectId).order("number", { ascending: true });
    if (error) throw error;
    return (data || []).map(commentFromRow);
  }

  async function getProjectBlob(project) {
    if (blobCache.has(project.id)) return blobCache.get(project.id);
    const { data, error } = await sb.storage.from(BUCKET).download(project.filePath);
    if (error) throw error;
    blobCache.set(project.id, data);
    return data;
  }

  async function uploadProject({ id, name, fileName, fileType, blob, createdAt }) {
    const path = `${id}/${safeFileName(fileName)}`;
    const up = await sb.storage.from(BUCKET).upload(path, blob, {
      contentType: MIME[fileType] || "application/octet-stream",
      upsert: true,
    });
    if (up.error) throw up.error;
    const row = { id, name, file_name: fileName, file_type: fileType, file_path: path };
    if (createdAt) row.created_at = createdAt;
    const { data, error } = await sb.from("projects").insert(row).select().single();
    if (error) {
      try { await sb.storage.from(BUCKET).remove([path]); } catch (e) { /* ignore */ }
      throw error;
    }
    blobCache.set(id, blob);
    return projectFromRow(data);
  }

  // Which of these comment ids already exist? (chunked to keep URLs short)
  async function existingCommentIds(ids) {
    const have = new Set();
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await sb.from("comments").select("id").in("id", ids.slice(i, i + 150));
      if (error) throw error;
      (data || []).forEach((r) => have.add(r.id));
    }
    return have;
  }

  function isMine(c) {
    if (c.authorId) return c.authorId === clientId();
    return !isSharedAccount() && !!user && !!c.authorEmail && c.authorEmail === user.email;
  }

  function upsertLocalComment(c) {
    const i = state.comments.findIndex((x) => x.id === c.id);
    if (i === -1) state.comments.push(c);
    else state.comments[i] = c;
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, "");
    const m = h.match(/^project\/([^/?&]+)/);
    if (m) return { view: "project", id: decodeURIComponent(m[1]) };
    return { view: "dashboard" };
  }

  async function route() {
    if (!user) return;
    if (sharedEmail() && /[?&#]key=/.test(location.hash)) {
      const k = takeKeyFromUrl(); // a review link pasted into an already-open tab
      if (k) localStorage.setItem(LS_TEAM_KEY, k);
    }
    const r = parseHash();
    if (r.view === "project") {
      const ok = await openProjectById(r.id);
      if (ok === false) location.hash = "#/";
    } else {
      showDashboard();
    }
  }

  function goToDashboard() { location.hash = "#/"; }
  function goToProject(id) { location.hash = "#/project/" + encodeURIComponent(id); }

  // ---------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------
  function wireDashboard() {
    $("#new-project-btn").addEventListener("click", openProjectModal);
    $("#empty-new-project-btn").addEventListener("click", openProjectModal);
    $("#migrate-btn").addEventListener("click", migrateLegacyProjects);
    $("#migrate-dismiss-btn").addEventListener("click", () => {
      sessionStorage.setItem(SS_MIGRATE_DISMISSED, "1");
      $("#migrate-banner").classList.add("hidden");
    });
    document.addEventListener("click", () => $$(".card-menu").forEach((m) => m.classList.add("hidden")));
  }

  function showDashboard() {
    state.view = "dashboard";
    state.openToken++;
    state.projectId = null;
    closePendingComposer();
    runCleanup();
    $("#auth-screen").classList.add("hidden");
    $("#viewer-screen").classList.remove("active");
    $("#dashboard-screen").classList.remove("hidden");
    renderDashboard(false);
  }

  async function renderDashboard(quiet) {
    const grid = $("#project-grid");
    const empty = $("#dash-empty");
    const loading = $("#dash-loading");
    if (!quiet && !grid.children.length) loading.classList.remove("hidden");

    let projects, counts;
    try {
      [projects, counts] = await Promise.all([fetchProjects(), fetchOpenCounts()]);
    } catch (err) {
      loading.classList.add("hidden");
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      empty.querySelector("h2").textContent = "Couldn't load projects";
      empty.querySelector("p").textContent = friendlyError(err);
      return;
    }
    if (state.view !== "dashboard") return;
    loading.classList.add("hidden");

    if (!projects.length) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      empty.querySelector("h2").textContent = "No projects yet";
      empty.querySelector("p").textContent = "Create your first project to upload a file and start collecting comments.";
    } else {
      empty.classList.add("hidden");
      grid.innerHTML = "";
      projects.forEach((p) => grid.appendChild(renderProjectCard(p, counts.get(p.id) || 0)));
    }

    checkLegacyLocalData(projects);
  }

  function renderProjectCard(p, count) {
    const meta = TYPE_META[p.fileType] || { label: String(p.fileType || "").toUpperCase(), color: "#666", icon: "📄" };

    const card = document.createElement("div");
    card.className = "project-card";
    card.style.setProperty("--type-color", meta.color);
    card.innerHTML = `
      <div class="card-thumb">
        <span class="thumb-icon">${meta.icon}</span>
        <span class="type-badge">${escapeHtml(meta.label)}</span>
        ${count > 0 ? `<span class="comment-count-badge">${count} open</span>` : ""}
        <button class="card-menu-btn" title="More options">⋯</button>
        <div class="card-menu hidden">
          <button data-act="copy">🔗 Copy link</button>
          <button data-act="replace">⟳ Replace file</button>
          <button data-act="delete" class="danger">🗑 Delete project</button>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(p.name)}</div>
        <div class="card-sub">${escapeHtml(p.fileName)}${p.createdBy ? ` · ${escapeHtml(emailLocalPart(p.createdBy))}` : ""}</div>
        <div class="card-dates">
          <span>Created ${fmtDate(p.createdAt)}</span>
          <span>Updated ${fmtDate(p.updatedAt)}</span>
        </div>
      </div>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest(".card-menu") || e.target.closest(".card-menu-btn")) return;
      goToProject(p.id);
    });

    const menuBtn = card.querySelector(".card-menu-btn");
    const menu = card.querySelector(".card-menu");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasHidden = menu.classList.contains("hidden");
      $$(".card-menu").forEach((m) => m.classList.add("hidden"));
      if (wasHidden) menu.classList.remove("hidden");
    });

    menu.querySelector('[data-act="replace"]').addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.add("hidden");
      pickReplacementFile(p);
    });
    menu.querySelector('[data-act="copy"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.classList.add("hidden");
      await copyProjectLink(p.id);
    });
    menu.querySelector('[data-act="delete"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.classList.add("hidden");
      if (!confirm(`Delete "${p.name}" for EVERYONE? This removes the file and all its comments for the whole team. It can't be undone.`)) return;
      try {
        if (p.filePath) await sb.storage.from(BUCKET).remove([p.filePath]);
      } catch (err) { /* file cleanup is best-effort */ }
      const { error } = await sb.from("projects").delete().eq("id", p.id);
      if (error) { alert(friendlyError(error)); return; }
      blobCache.delete(p.id);
      toast("Project deleted.");
      renderDashboard(true);
    });

    return card;
  }

  // ---------------------------------------------------------------------
  // New project modal
  // ---------------------------------------------------------------------
  let pendingNewFile = null; // { blob, name, type }

  function wireProjectModal() {
    const dz = $("#project-dropzone");
    const fileInput = $("#project-file-input");

    dz.addEventListener("click", () => fileInput.click());
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      if (e.dataTransfer.files.length) pickProjectFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files.length) pickProjectFile(fileInput.files[0]);
    });

    $("#project-load-sample-btn").addEventListener("click", async () => {
      try {
        const res = await fetch("sample/sample.html", { cache: "no-store" });
        if (!res.ok) throw new Error("missing");
        const blob = await res.blob();
        pendingNewFile = { blob, name: "sample.html", type: "html" };
        $("#project-file-chosen").textContent = "Using: sample.html";
        $("#project-file-chosen").style.display = "block";
        if (!$("#project-name-input").value.trim()) $("#project-name-input").value = "Sample project";
      } catch (e) {
        alert("Couldn't load sample/sample.html. Make sure the sample folder is uploaded next to index.html.");
      }
    });

    $("#project-cancel-btn").addEventListener("click", closeProjectModal);
    $("#project-create-btn").addEventListener("click", createProjectFromModal);
  }

  function pickProjectFile(file) {
    const type = extToType(file.name);
    if (!type) {
      alert("Unsupported file type. Please upload .html, .pdf, .docx, or .pptx");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      alert(`That file is ${(file.size / 1048576).toFixed(1)} MB. The free Supabase plan allows up to 50 MB per file.`);
      return;
    }
    pendingNewFile = { blob: file, name: file.name, type };
    $("#project-file-chosen").textContent = "Using: " + file.name;
    $("#project-file-chosen").style.display = "block";
    if (!$("#project-name-input").value.trim()) {
      $("#project-name-input").value = file.name.replace(/\.[^.]+$/, "");
    }
  }

  function openProjectModal() {
    pendingNewFile = null;
    $("#project-name-input").value = "";
    $("#project-file-chosen").style.display = "none";
    $("#project-file-input").value = "";
    $("#project-modal").classList.remove("hidden");
    $("#project-name-input").focus();
  }

  function closeProjectModal() {
    $("#project-modal").classList.add("hidden");
  }

  async function createProjectFromModal() {
    if (!pendingNewFile) {
      alert("Choose a file to upload (or use the sample page) first.");
      return;
    }
    const btn = $("#project-create-btn");
    const name = $("#project-name-input").value.trim() || pendingNewFile.name.replace(/\.[^.]+$/, "");
    const id = uid("p");
    btn.disabled = true;
    btn.textContent = "Uploading…";
    try {
      await uploadProject({ id, name, fileName: pendingNewFile.name, fileType: pendingNewFile.type, blob: pendingNewFile.blob });
    } catch (err) {
      alert("Couldn't create the project: " + friendlyError(err));
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = "Create project";
    }
    closeProjectModal();
    toast("Project created — your team can see it now.");
    goToProject(id);
  }

  // ---------------------------------------------------------------------
  // Replace a project's file with a new version (comments are kept)
  //   New versions are stored under a new name, <id>/r<timestamp>-<file>,
  //   so every browser fetches the new copy, and comments made before that
  //   timestamp can be labelled "earlier version".
  // ---------------------------------------------------------------------
  let replaceTarget = null;

  function pickReplacementFile(project) {
    replaceTarget = project;
    $("#replace-file-input").click();
  }

  function fileVersionTime(filePath) {
    const m = String(filePath || "").match(/\/r(\d{12,14})-/);
    return m ? Number(m[1]) : 0;
  }

  function isFromEarlierVersion(c) {
    const t = fileVersionTime(state.filePath);
    return !!t && !!c.timestamp && new Date(c.timestamp).getTime() < t;
  }

  async function replaceProjectFile(project, file) {
    const type = extToType(file.name);
    if (!type) { alert("Unsupported file type. Please choose a .html, .pdf, .docx or .pptx file."); return; }
    if (file.size > MAX_FILE_BYTES) {
      alert(`That file is ${(file.size / 1048576).toFixed(1)} MB. The free Supabase plan allows up to 50 MB per file.`);
      return;
    }
    const sure = confirm(
      `Replace the file in "${project.name}" with "${file.name}"?\n\n` +
      "Everyone will see the new version right away. All comments are kept — open ones stay open " +
      "so you can check them against the new version, and they'll be marked \"earlier version\"."
    );
    if (!sure) return;

    const btn = $("#replace-file-btn");
    btn.disabled = true;
    const label = btn.innerHTML;
    btn.innerHTML = '⟳<span class="btn-label"> Uploading…</span>';
    toast("Uploading new version…", 6000);
    const newPath = `${project.id}/r${Date.now()}-${safeFileName(file.name)}`;
    try {
      const up = await sb.storage.from(BUCKET).upload(newPath, file, {
        contentType: MIME[type] || "application/octet-stream",
        upsert: false,
      });
      if (up.error) throw up.error;
      const { data, error } = await sb.from("projects")
        .update({ file_name: file.name, file_type: type, file_path: newPath })
        .eq("id", project.id).select().single();
      if (error) {
        try { await sb.storage.from(BUCKET).remove([newPath]); } catch (e) { /* ignore */ }
        throw error;
      }
      // Old copy is no longer needed (best effort).
      if (project.filePath && project.filePath !== newPath) {
        sb.storage.from(BUCKET).remove([project.filePath]).catch(() => {});
      }
      blobCache.set(project.id, file);
      toast("New version uploaded — everyone sees it now.", 3500);
      if (state.view === "viewer" && state.projectId === project.id) await loadNewVersion(projectFromRow(data), false);
      else if (state.view === "dashboard") renderDashboard(true);
    } catch (err) {
      alert("Couldn't replace the file: " + friendlyError(err));
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  // Swap the file shown in the viewer for a newer version, keeping comments.
  async function loadNewVersion(project, fromTeammate) {
    if (state.view !== "viewer" || state.projectId !== project.id) return;
    if (project.filePath === state.filePath && !fromTeammate) { /* already showing */ }
    const token = state.openToken;
    let blob;
    try {
      if (fromTeammate) blobCache.delete(project.id);
      blob = await getProjectBlob(project);
    } catch (err) {
      toast("A new version was uploaded, but it couldn't be loaded. Refresh the page.", 5000);
      return;
    }
    if (token !== state.openToken || state.projectId !== project.id) return;
    state.fileName = project.fileName;
    state.fileType = project.fileType;
    state.filePath = project.filePath;
    state.fileBlob = blob;
    closePendingComposer();
    $("#viewer-filetype").textContent = (TYPE_META[project.fileType] || {}).label || String(project.fileType).toUpperCase();
    await renderContent(token);
    renderSidebar();
    if (fromTeammate) toast("📄 A new version of this file was just uploaded.", 4000);
  }

  // ---------------------------------------------------------------------
  // Open a project into the viewer
  // ---------------------------------------------------------------------
  async function openProjectById(id) {
    const token = ++state.openToken;
    state.view = "viewer";
    state.projectId = id;
    state.comments = [];
    state.openPopoverId = null;
    closePendingComposer();
    runCleanup();

    $("#auth-screen").classList.add("hidden");
    $("#dashboard-screen").classList.add("hidden");
    $("#viewer-screen").classList.add("active");
    $("#viewer-filename").textContent = "Loading…";
    $("#viewer-filetype").textContent = "";
    $("#warning-banner").classList.remove("show");
    setMode("browse");
    setSidebar(false);
    $("#comments-toggle-btn").classList.remove("has-new");
    showContentMessage("⏳ Loading file…");
    renderSidebar();

    let project, comments, blob;
    try {
      project = await fetchProject(id);
      if (token !== state.openToken) return null;
      if (!project) {
        toast("That project doesn't exist (it may have been deleted).", 3500);
        return false;
      }
      [comments, blob] = await Promise.all([fetchComments(id), getProjectBlob(project)]);
    } catch (err) {
      if (token !== state.openToken) return null;
      showContentMessage("⚠ " + friendlyError(err));
      return true;
    }
    if (token !== state.openToken) return null;

    state.projectName = project.name;
    state.fileName = project.fileName;
    state.filePath = project.filePath;
    state.fileType = project.fileType;
    state.fileBlob = blob;
    state.currentPage = 1;
    state.comments = comments;

    $("#viewer-filename").textContent = project.name;
    $("#viewer-filetype").textContent = (TYPE_META[project.fileType] || {}).label || String(project.fileType).toUpperCase();

    await renderContent(token);
    if (token !== state.openToken) return null;
    renderSidebar();
    return true;
  }

  function showContentMessage(text) {
    const inner = $("#content-inner");
    Array.from(inner.children).forEach((el) => { if (el.id !== "pin-overlay") el.remove(); });
    inner.style.height = "";
    const msg = document.createElement("div");
    msg.className = "empty-state content-msg";
    msg.textContent = text;
    inner.insertBefore(msg, inner.firstChild);
    renderPins();
  }

  function runCleanup() {
    state.cleanup.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    state.cleanup = [];
  }

  // ---------------------------------------------------------------------
  // Author name (stored on the user's account so it follows them)
  // ---------------------------------------------------------------------
  function getAuthorName() {
    // On the shared reviewers account the name lives only in this browser,
    // otherwise everyone on that account would overwrite each other's name.
    if (isSharedAccount()) return (localStorage.getItem(LS_AUTHOR) || "").trim();
    const meta = (user && user.user_metadata) || {};
    return (meta.full_name || localStorage.getItem(LS_AUTHOR) || "").trim();
  }

  function ensureAuthorName(cb) {
    const existing = getAuthorName();
    if (existing) { cb(existing); return; }
    const modal = $("#name-modal");
    modal.classList.remove("hidden");
    $("#name-input").value = isSharedAccount() ? "" : emailLocalPart(user && user.email);
    $("#name-input").focus();
    $("#name-input").select();
    const finish = (val) => {
      modal.classList.add("hidden");
      const fallback = isSharedAccount() ? "Reviewer" : emailLocalPart(user && user.email);
      const name = (val || "").trim() || fallback || "Anonymous";
      localStorage.setItem(LS_AUTHOR, name);
      if (isSharedAccount()) $("#user-email-label").textContent = "Team access · " + name;
      if (sb && val && !isSharedAccount()) {
        sb.auth.updateUser({ data: { full_name: name } }).then(({ data }) => {
          if (data && data.user) user = data.user;
        }).catch(() => { /* non-fatal */ });
      }
      cb(name);
    };
    $("#name-save-btn").onclick = () => finish($("#name-input").value);
    $("#name-skip-btn").onclick = () => finish("");
    $("#name-input").onkeydown = (e) => { if (e.key === "Enter") finish($("#name-input").value); };
  }

  // ---------------------------------------------------------------------
  // Viewer screen wiring (mode toggle, share, export/import buttons)
  // ---------------------------------------------------------------------
  function wireViewerScreen() {
    $("#back-btn").addEventListener("click", goToDashboard);

    $("#mode-browse").addEventListener("click", () => setMode("browse"));
    $("#mode-comment").addEventListener("click", () => setMode("comment"));

    $("#share-btn").addEventListener("click", () => copyProjectLink(state.projectId));
    $("#replace-file-btn").addEventListener("click", () => {
      if (!state.projectId || !state.filePath) return;
      pickReplacementFile({ id: state.projectId, name: state.projectName, fileName: state.fileName, filePath: state.filePath });
    });
    $("#replace-file-input").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      const target = replaceTarget;
      replaceTarget = null;
      if (f && target) replaceProjectFile(target, f);
    });

    // Comments drawer: hidden until asked for, floats over the page
    $("#comments-toggle-btn").addEventListener("click", () => setSidebar(!isSidebarOpen()));
    $("#sidebar-close").addEventListener("click", () => setSidebar(false));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !isSidebarOpen() || state.pendingPin) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      setSidebar(false);
    });

    $("#export-comments-btn").addEventListener("click", exportMarkdown);
    $("#sb-export-md").addEventListener("click", exportMarkdown);
    $("#sb-export-json").addEventListener("click", exportJson);

    $("#import-comments-btn").addEventListener("click", () => $("#import-input-2").click());
    $("#sb-import").addEventListener("click", () => $("#import-input-2").click());
    $("#import-input-2").addEventListener("change", async (e) => {
      if (!e.target.files.length) return;
      const text = await e.target.files[0].text();
      e.target.value = "";
      let list;
      try {
        const json = JSON.parse(text);
        list = Array.isArray(json) ? json : (json.comments || []);
      } catch (err) {
        alert("Could not parse that file as comments JSON.");
        return;
      }
      try {
        const added = await importComments(state.projectId, list, { keepNumbers: false });
        toast(`Imported ${added} new comment(s).`);
      } catch (err) {
        alert("Import failed: " + friendlyError(err));
      }
    });

    // Keep pins aligned with the content
    window.addEventListener("resize", () => schedulePinLayout());
    $("#content-pane").addEventListener("scroll", () => {
      if (state.fileType === "pdf" || state.fileType === "pptx") updateCurrentPage();
      schedulePinLayout();
    }, { passive: true });
  }

  async function copyProjectLink(projectId) {
    const key = sharedEmail() ? localStorage.getItem(LS_TEAM_KEY) : null;
    const url = location.origin + location.pathname + "#/project/" + encodeURIComponent(projectId) +
      (key ? "?key=" + encodeURIComponent(key) : "");
    const note = key
      ? "Link copied — anyone with this link can open it and comment, no sign-in needed. Only send it to reviewers."
      : "Link copied — the reviewer will need to sign in to open it.";
    try {
      await navigator.clipboard.writeText(url);
      toast(note, 4200);
    } catch (e) {
      window.prompt("Copy this link:", url);
    }
  }

  // Inserts comments that aren't already in the database (matched by id).
  async function importComments(projectId, list, opts) {
    const keepNumbers = !!(opts && opts.keepNumbers);
    const valid = (list || []).filter((c) => c && c.id && c.text != null && isFinite(Number(c.x)) && isFinite(Number(c.y)));
    if (!valid.length) return 0;

    const have = await existingCommentIds(valid.map((c) => String(c.id)));
    const fresh = valid.filter((c) => !have.has(c.id));
    if (!fresh.length) return 0;

    const rows = fresh
      .sort((a, b) => (a.number || 0) - (b.number || 0))
      .map((c) => {
        const r = {
          id: String(c.id),
          project_id: projectId,
          x: Number(c.x),
          y: Number(c.y),
          page: c.page == null ? null : Number(c.page),
          anchor: c.anchorRaw || (c.anchor && c.anchor !== "content" ? c.anchor : null),
          text: String(c.text),
          author: c.author || "Anonymous",
          element_selector: c.elementSelector || c.element_selector || null,
          status: c.status === "resolved" ? "resolved" : "open",
          created_at: c.timestamp || c.created_at || new Date().toISOString(),
        };
        if (keepNumbers) r.number = Number(c.number) || null;
        return r;
      });

    const { data, error } = await sb.from("comments").upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select();
    if (error) throw error;
    if (state.view === "viewer" && state.projectId === projectId) {
      (data || []).forEach((r) => upsertLocalComment(commentFromRow(r)));
      renderPins();
      renderSidebar();
    }
    return (data || []).length;
  }

  function isSidebarOpen() {
    return $("#sidebar").classList.contains("open");
  }

  function setSidebar(open) {
    $("#sidebar").classList.toggle("open", open);
    $("#sidebar").setAttribute("aria-hidden", open ? "false" : "true");
    const btn = $("#comments-toggle-btn");
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) btn.classList.remove("has-new");
  }

  function setMode(mode) {
    state.mode = mode;
    $("#mode-browse").classList.toggle("active", mode === "browse");
    $("#mode-comment").classList.toggle("active", mode === "comment");
    $("#pin-overlay").classList.toggle("active", mode === "comment");
    $("#content-inner").classList.toggle("comment-mode", mode === "comment");
  }

  // ---------------------------------------------------------------------
  // Content rendering per file type
  // ---------------------------------------------------------------------
  async function renderContent(token) {
    const inner = $("#content-inner");
    runCleanup();
    anchorCache.clear();
    domVersion++;
    Array.from(inner.children).forEach((el) => { if (el.id !== "pin-overlay") el.remove(); });
    inner.style.maxWidth = "";
    inner.style.height = "";
    const banner = $("#warning-banner");
    banner.classList.remove("show");
    banner.textContent = "";

    state.totalPages = 1;
    state.currentPage = 1;

    try {
      if (state.fileType === "html") await renderHtml(inner);
      else if (state.fileType === "pdf") await renderPdf(inner, token);
      else if (state.fileType === "docx") await renderDocx(inner);
      else if (state.fileType === "pptx") await renderPptx(inner, token);
    } catch (err) {
      console.error(err);
      showContentMessage("⚠ Couldn't display this file: " + (err && err.message ? err.message : err));
    }

    // pin overlay must stay the last child, above content
    inner.appendChild($("#pin-overlay"));
    renderPins();
  }

  function htmlFrame() {
    return state.fileType === "html" ? $("#html-frame") : null;
  }

  // Scroll + size of the HTML page inside the iframe (null if not readable)
  function htmlFrameInfo() {
    const iframe = htmlFrame();
    if (!iframe) return null;
    let sx = 0, sy = 0;
    try {
      const w = iframe.contentWindow;
      sx = w.scrollX || 0;
      sy = w.scrollY || 0;
    } catch (e) { /* page navigated elsewhere */ }
    return { scrollX: sx, scrollY: sy, width: iframe.clientWidth, height: iframe.clientHeight };
  }

  // The reviewed page is shown through iframe.srcdoc, which has no address of
  // its own: a link like href="#pricing" would resolve against Pinpoint's own
  // URL and load Pinpoint inside the frame. This small script, added to the
  // page, makes in-page links scroll within the page instead, and opens links
  // to other pages in a new tab so the page under review stays put.
  const IFRAME_NAV_FIX = `<script data-pinpoint-nav-fix>
(function () {
  function findTarget(id) {
    if (!id) return null;
    return document.getElementById(id) || document.getElementsByName(id)[0] || null;
  }
  window.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = (a.getAttribute("href") || "").trim();
    if (/^(javascript:|mailto:|tel:|sms:|data:)/i.test(href)) return;
    if (href.charAt(0) === "#") {
      e.preventDefault();
      var id = href.slice(1);
      try { id = decodeURIComponent(id); } catch (err) {}
      if (!id || id === "top") { if (id === "top") window.scrollTo({ top: 0, behavior: "smooth" }); return; }
      var el = findTarget(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (a.target && a.target !== "_self") return;
    e.preventDefault();
    window.open(a.href, "_blank", "noopener");
  }, false);
})();
<\/script>`;

  function addNavFix(html) {
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + IFRAME_NAV_FIX);
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + IFRAME_NAV_FIX);
    return IFRAME_NAV_FIX + html;
  }

  async function renderHtml(inner) {
    const text = addNavFix(await state.fileBlob.text());
    const iframe = document.createElement("iframe");
    iframe.id = "html-frame";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
    inner.insertBefore(iframe, inner.firstChild);

    const fitHeight = () => {
      inner.style.height = $("#content-pane").clientHeight + "px";
      schedulePinLayout();
    };
    const onFrameScroll = () => schedulePinLayout();
    const onLoad = () => {
      fitHeight();
      try {
        const w = iframe.contentWindow;
        const d = iframe.contentDocument;
        w.addEventListener("scroll", onFrameScroll, { passive: true });
        // scrolling inside boxes on the page (capture: scroll doesn't bubble)
        d.addEventListener("scroll", onFrameScroll, { capture: true, passive: true });
        w.addEventListener("resize", onFrameScroll);
        // content that appears, moves or changes (tabs, "show report" buttons…)
        let pending = false;
        const mo = new MutationObserver(() => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => { pending = false; onReviewedPageChanged(); });
        });
        mo.observe(d.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        state.cleanup.push(() => mo.disconnect());
        d.fonts && d.fonts.ready && d.fonts.ready.then(() => onReviewedPageChanged());
        Array.from(d.images || []).forEach((img) => { if (!img.complete) img.addEventListener("load", onReviewedPageChanged); });
      } catch (e) { /* ignore */ }
      anchorCache.clear();
      onReviewedPageChanged();
      renderSidebar();
    };
    iframe.addEventListener("load", onLoad);
    iframe.srcdoc = text;

    const ro = new ResizeObserver(fitHeight);
    ro.observe($("#content-pane"));
    state.cleanup.push(() => ro.disconnect());
    fitHeight();
  }

  async function renderPdf(inner, token) {
    if (!window.pdfjsLib) {
      showContentMessage("pdf.js failed to load (check network / CDN access).");
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    const arrayBuf = await state.fileBlob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    state.totalPages = pdf.numPages;

    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.paddingBottom = "20px";
    inner.insertBefore(container, inner.firstChild);

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (token !== state.openToken) return;
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.3 });
      const wrap = document.createElement("div");
      wrap.className = "page-wrap";
      wrap.dataset.page = pageNum;
      wrap.style.width = viewport.width + "px";
      wrap.style.height = viewport.height + "px";

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      wrap.appendChild(canvas);
      container.appendChild(wrap);

      const label = document.createElement("div");
      label.className = "page-label";
      label.textContent = `Page ${pageNum} of ${pdf.numPages}`;
      container.appendChild(label);

      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      schedulePinLayout();
    }
    updateCurrentPage();
  }

  function updateCurrentPage() {
    const pane = $("#content-pane");
    const wraps = $$("#content-inner [data-page]");
    if (!wraps.length) return;
    const paneRect = pane.getBoundingClientRect();
    let best = 1, bestDist = Infinity;
    wraps.forEach((w) => {
      const r = w.getBoundingClientRect();
      const dist = Math.abs(r.top - paneRect.top);
      if (dist < bestDist) { bestDist = dist; best = Number(w.dataset.page); }
    });
    state.currentPage = best;
  }

  async function renderDocx(inner) {
    const banner = $("#warning-banner");
    banner.textContent = "⚠ DOCX preview is an approximation (via mammoth.js) — formatting, page breaks and exact layout will differ from the original document.";
    banner.classList.add("show");

    if (!window.mammoth) {
      showContentMessage("mammoth.js failed to load (check network / CDN access).");
      return;
    }
    const arrayBuf = await state.fileBlob.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuf });
    const container = document.createElement("div");
    container.className = "docx-container";
    container.innerHTML = result.value;
    inner.insertBefore(container, inner.firstChild);
    container.querySelectorAll("img").forEach((img) => img.addEventListener("load", schedulePinLayout));
  }

  async function renderPptx(inner, token) {
    const banner = $("#warning-banner");
    banner.textContent = "⚠ PPTX preview is an approximate, best-effort rendering (text/images extracted client-side) — not a pixel-accurate render of the original slides.";
    banner.classList.add("show");

    if (!window.JSZip) {
      showContentMessage("JSZip failed to load (check network / CDN access).");
      return;
    }
    const arrayBuf = await state.fileBlob.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuf);

    const slideFiles = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)[1]) - Number(b.match(/slide(\d+)\.xml/)[1]));

    state.totalPages = slideFiles.length || 1;

    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.paddingBottom = "20px";
    inner.insertBefore(container, inner.firstChild);

    if (!slideFiles.length) {
      container.innerHTML = `<div class="empty-state">No slides found in this PPTX.</div>`;
      return;
    }

    let idx = 0;
    for (const path of slideFiles) {
      if (token !== state.openToken) return;
      idx++;
      const slideNo = Number(path.match(/slide(\d+)\.xml/)[1]);
      const xmlText = await zip.file(path).async("text");
      const doc = new DOMParser().parseFromString(xmlText, "application/xml");
      const texts = Array.from(doc.getElementsByTagName("a:t")).map((n) => n.textContent);

      const relsPath = `ppt/slides/_rels/slide${slideNo}.xml.rels`;
      let imageUrl = null;
      if (zip.file(relsPath)) {
        const relsXml = await zip.file(relsPath).async("text");
        const relsDoc = new DOMParser().parseFromString(relsXml, "application/xml");
        const rel = Array.from(relsDoc.getElementsByTagName("Relationship"))
          .find((r) => /image/i.test(r.getAttribute("Type") || ""));
        if (rel) {
          const target = rel.getAttribute("Target").replace(/^\.\.\//, "ppt/");
          const mediaFile = zip.file(target) || zip.file("ppt/" + target.replace(/^ppt\//, ""));
          if (mediaFile) {
            const blob = await mediaFile.async("blob");
            imageUrl = URL.createObjectURL(blob);
            state.cleanup.push(() => URL.revokeObjectURL(imageUrl));
          }
        }
      }

      const wrap = document.createElement("div");
      wrap.className = "slide-wrap";
      wrap.dataset.page = idx;

      if (texts.length) {
        const h = document.createElement("h2");
        h.textContent = texts[0];
        wrap.appendChild(h);
        texts.slice(1).forEach((t) => {
          if (!t.trim()) return;
          const p = document.createElement("p");
          p.textContent = t;
          wrap.appendChild(p);
        });
      }
      if (imageUrl) {
        const img = document.createElement("img");
        img.src = imageUrl;
        img.addEventListener("load", schedulePinLayout);
        wrap.appendChild(img);
      }
      if (!texts.length && !imageUrl) {
        const p = document.createElement("p");
        p.style.color = "#999";
        p.textContent = "(No extractable text/image content on this slide)";
        wrap.appendChild(p);
      }

      container.appendChild(wrap);
      const label = document.createElement("div");
      label.className = "page-label";
      label.textContent = `Slide ${idx} of ${slideFiles.length}`;
      container.appendChild(label);
    }
    updateCurrentPage();
  }

  // ---------------------------------------------------------------------
  // Pin geometry
  //
  // HTML pages and Word documents reflow with screen size, so a pin saved as
  // "x% across, y px down" lands somewhere else on a different screen.
  // Instead, a pin is attached to what was clicked:
  //   • the exact character, when the click was on text, or
  //   • the element (heading, image, button…), at the same relative spot.
  // Stored in the `anchor` column as  "el:" + JSON:
  //   { r: "html"|"docx",          which document
  //     p: css path, t: text start  the element
  //     fx, fy: 0..1                spot inside the element's box
  //     cp, cn, co, ct, cto, dx, dy the character (optional) }
  // The x / y columns keep the old-style position as a last-resort fallback.
  //
  //   anchor 'page'    → x, y = % of PDF page / PPTX slide number `page`
  //   anchor 'html'    → (older comments) x = % of iframe width, y = px down
  //   anchor 'content' → (older comments / DOCX) % of the whole content area
  // ---------------------------------------------------------------------
  const anchorCache = new Map(); // comment id -> { el, textNode, offset, legacy, ver }
  let domVersion = 0;            // bumped when the reviewed page changes

  function normText(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function cssEsc(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function currentAnchorKind() {
    return state.fileType === "html" ? "html" : state.fileType === "docx" ? "docx" : null;
  }

  function anchorDoc(kind) {
    if (kind === "html") {
      const f = htmlFrame();
      try { return (f && f.contentDocument) || null; } catch (e) { return null; }
    }
    return document;
  }

  function anchorRoot(kind) {
    if (kind === "html") { const d = anchorDoc("html"); return d ? d.body : null; }
    return $("#content-inner .docx-container");
  }

  // A path like  "body > main:nth-of-type(1) > h1:nth-of-type(2)"  or  "#hero > p:nth-of-type(1)"
  function cssPath(el, root) {
    const doc = el.ownerDocument;
    const parts = [];
    let node = el;
    while (node && node !== root && node.nodeType === 1 && node !== doc.documentElement) {
      if (node.id) {
        let unique = false;
        try { unique = doc.querySelectorAll("#" + cssEsc(node.id)).length === 1; } catch (e) { unique = false; }
        if (unique) { parts.unshift("#" + cssEsc(node.id)); return parts.join(" > "); }
      }
      let i = 1, sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) i++;
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      node = node.parentElement;
    }
    const head = root && root.tagName === "BODY" ? "body" : ":scope";
    return parts.length ? head + " > " + parts.join(" > ") : head;
  }

  function queryPath(root, path) {
    if (!root || !path) return null;
    if (path === ":scope" || (path === "body" && root.tagName === "BODY")) return root;
    try {
      return path.indexOf("#") === 0 || path.indexOf("body") === 0
        ? root.ownerDocument.querySelector(path)
        : root.querySelector(path);
    } catch (e) { return null; }
  }

  function findByText(root, tag, t) {
    if (!root || !tag || !t) return null;
    let list;
    try { list = root.querySelectorAll(tag); } catch (e) { return null; }
    const n = Math.min(list.length, 4000);
    for (let i = 0; i < n; i++) {
      if (normText(list[i].textContent).indexOf(t) === 0) return list[i];
    }
    return null;
  }

  // Multi-line inline elements (a long <span> or <a>) have a box that spans
  // several lines; use their block parent instead so the spot is stable.
  function anchorable(el) {
    const win = el.ownerDocument.defaultView;
    while (el && el.parentElement && el.tagName !== "BODY") {
      let disp = "";
      try { disp = win.getComputedStyle(el).display; } catch (e) { disp = ""; }
      if (disp === "inline" && el.getClientRects().length > 1) { el = el.parentElement; continue; }
      break;
    }
    return el;
  }

  function caretAt(doc, x, y) {
    try {
      if (doc.caretRangeFromPoint) {
        const r = doc.caretRangeFromPoint(x, y);
        if (r) return { node: r.startContainer, offset: r.startOffset };
      }
      if (doc.caretPositionFromPoint) {
        const p = doc.caretPositionFromPoint(x, y);
        if (p) return { node: p.offsetNode, offset: p.offset };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function charRect(node, offset) {
    const len = (node.nodeValue || "").length;
    if (!len) return null;
    const o = Math.min(Math.max(0, offset), len - 1);
    try {
      const range = node.ownerDocument.createRange();
      range.setStart(node, o);
      range.setEnd(node, o + 1);
      const rects = range.getClientRects();
      const rect = rects[0] || range.getBoundingClientRect();
      return rect && (rect.width || rect.height) ? rect : null;
    } catch (e) { return null; }
  }

  // What's under the mouse, in the coordinates of the document it belongs to.
  function pointTarget(e) {
    const kind = currentAnchorKind();
    if (kind === "html") {
      const iframe = htmlFrame();
      const doc = anchorDoc("html");
      if (!iframe || !doc) return null;
      const fr = iframe.getBoundingClientRect();
      const cx = e.clientX - fr.left, cy = e.clientY - fr.top;
      let el = null;
      try { el = doc.elementFromPoint(cx, cy); } catch (err) { el = null; }
      return el ? { kind, doc, el, cx, cy } : null;
    }
    if (kind === "docx") {
      const overlay = $("#pin-overlay");
      const prev = overlay.style.pointerEvents;
      overlay.style.pointerEvents = "none"; // look through the overlay
      let el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = prev;
      if (!el || !el.closest(".docx-container")) return null;
      return { kind, doc: document, el, cx: e.clientX, cy: e.clientY, overlay };
    }
    return null;
  }

  function buildElementAnchor(t) {
    const root = anchorRoot(t.kind);
    if (!root || !(t.el === root || root.contains(t.el))) return null;
    const el = anchorable(t.el);
    const a = { r: t.kind, p: cssPath(el, root) };
    const box = el.getBoundingClientRect();
    a.fx = box.width ? Math.round(((t.cx - box.left) / box.width) * 10000) / 10000 : 0.5;
    a.fy = box.height ? Math.round(((t.cy - box.top) / box.height) * 10000) / 10000 : 0.5;
    const txt = normText(el.textContent);
    if (txt) a.t = txt.slice(0, 40);

    // Exact character, when the click is on text
    let caret;
    if (t.kind === "docx") {
      const prev = t.overlay.style.pointerEvents;
      t.overlay.style.pointerEvents = "none";
      caret = caretAt(t.doc, t.cx, t.cy);
      t.overlay.style.pointerEvents = prev;
    } else {
      caret = caretAt(t.doc, t.cx, t.cy);
    }
    if (caret && caret.node && caret.node.nodeType === 3 && el.contains(caret.node)) {
      const node = caret.node;
      const len = node.nodeValue.length;
      const o = Math.min(caret.offset, len - 1);
      const rect = charRect(node, o);
      if (rect && t.cx >= rect.left - 24 && t.cx <= rect.right + 24 && t.cy >= rect.top - 6 && t.cy <= rect.bottom + 6) {
        const host = node.parentElement;
        const texts = Array.from(host.childNodes).filter((n) => n.nodeType === 3);
        const from = Math.max(0, o - 8);
        a.cp = host === el ? a.p : cssPath(host, root);
        a.cn = texts.indexOf(node);
        a.co = o;
        a.ct = node.nodeValue.slice(from, o + 9);
        a.cto = o - from;
        a.dx = Math.round((t.cx - rect.left) * 10) / 10;
        a.dy = Math.round((t.cy - rect.top) * 10) / 10;
      }
    }
    return a;
  }

  // Older comments: find the element from the saved description
  // ("h1#hero.title — "View your hospital's…"") nearest the old position.
  function parseDescription(desc) {
    const d = String(desc || "");
    if (!d) return null;
    const cut = d.indexOf(' — "');
    const head = cut >= 0 ? d.slice(0, cut) : d;
    let text = cut >= 0 ? d.slice(cut + 4) : "";
    if (text.endsWith('"')) text = text.slice(0, -1);
    const tm = head.match(/^[a-z][a-z0-9-]*/i);
    if (!tm) return null;
    let rest = head.slice(tm[0].length);
    let id = "";
    if (rest.charAt(0) === "#") {
      const dot = rest.indexOf(".");
      id = dot >= 0 ? rest.slice(1, dot) : rest.slice(1);
      rest = dot >= 0 ? rest.slice(dot) : "";
    }
    const classes = rest.split(".").filter(Boolean);
    return { tag: tm[0].toLowerCase(), id, classes, text: normText(text) };
  }

  function legacyPoint(c, kind) {
    if (kind === "html") {
      const f = htmlFrameInfo();
      if (!f) return null;
      return { x: (c.x / 100) * f.width - f.scrollX, y: c.y - f.scrollY };
    }
    const inner = $("#content-inner");
    const ir = inner.getBoundingClientRect();
    return { x: ir.left + (c.x / 100) * inner.clientWidth, y: ir.top + (c.y / 100) * inner.clientHeight };
  }

  function findLegacyElement(c, kind) {
    const info = parseDescription(c.elementSelector);
    const root = anchorRoot(kind);
    if (!info || !root) return null;
    const doc = root.ownerDocument;
    let cands = [];
    if (info.id) {
      const byId = doc.getElementById(info.id);
      if (byId) cands = [byId];
    }
    if (!cands.length) {
      let sel = info.tag + info.classes.map((k) => "." + cssEsc(k)).join("");
      try { cands = Array.from(root.querySelectorAll(sel)); } catch (e) { cands = []; }
      if (!cands.length && info.classes.length) {
        try { cands = Array.from(root.querySelectorAll(info.tag)); } catch (e) { cands = []; }
      }
    }
    if (info.text) cands = cands.filter((el) => normText(el.textContent).indexOf(info.text) === 0);
    cands = cands.filter((el) => { const b = el.getBoundingClientRect(); return b.width || b.height; });
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    const pt = legacyPoint(c, kind);
    if (!pt) return cands[0];
    let best = cands[0], bestD = Infinity;
    cands.forEach((el) => {
      const b = el.getBoundingClientRect();
      const dx = Math.max(b.left - pt.x, 0, pt.x - b.right);
      const dy = Math.max(b.top - pt.y, 0, pt.y - b.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = el; }
    });
    return best;
  }

  function resolveAnchor(c, kind) {
    const key = c.id || "__pending";
    const hit = anchorCache.get(key);
    if (hit && (hit.el ? hit.el.isConnected : hit.ver === domVersion)) return hit;

    const res = { el: null, textNode: null, offset: 0, legacy: false, ver: domVersion };
    const root = anchorRoot(kind);
    if (!root) return res;

    if (c.el) {
      const a = c.el;
      let el = queryPath(root, a.p);
      if (a.t && (!el || normText(el.textContent).indexOf(a.t.slice(0, 20)) !== 0)) {
        const segs = String(a.p || "").split(" > ");
        const tag = (segs[segs.length - 1] || "").split(":")[0];
        const alt = tag && tag.charAt(0) !== "#" ? findByText(root, tag, a.t) : null;
        if (alt) el = alt;
      }
      res.el = el;
      if (el && a.cp != null && a.ct) {
        const host = a.cp === a.p ? el : queryPath(root, a.cp);
        if (host && (host === el || el.contains(host))) {
          const texts = Array.from(host.childNodes).filter((n) => n.nodeType === 3);
          let node = texts[a.cn];
          let off = a.co;
          if (!node || node.nodeValue.substr(a.co - a.cto, a.ct.length) !== a.ct) {
            node = null;
            for (const tn of texts) {
              const i = tn.nodeValue.indexOf(a.ct);
              if (i >= 0) { node = tn; off = i + a.cto; break; }
            }
          }
          if (node) { res.textNode = node; res.offset = off; }
        }
      }
    } else if (c.elementSelector && ((kind === "html" && c.anchor === "html") || (kind === "docx" && c.anchor === "content"))) {
      res.el = findLegacyElement(c, kind);
      res.legacy = true;
    }
    // Boxes on the page that clip their content (scroll areas, carousels…)
    res.clips = [];
    if (res.el) {
      const win = res.el.ownerDocument.defaultView;
      let n = res.el.parentElement;
      while (n && n !== root && n.tagName !== "BODY" && n.tagName !== "HTML") {
        try {
          const st = win.getComputedStyle(n);
          if (/(auto|scroll|hidden|clip)/.test(st.overflowX + " " + st.overflowY)) res.clips.push(n);
        } catch (e) { /* ignore */ }
        n = n.parentElement;
      }
    }
    anchorCache.set(key, res);
    return res;
  }

  function clippedAway(res, pt) {
    if (!res || !res.clips) return false;
    for (const n of res.clips) {
      const b = n.getBoundingClientRect();
      if (pt.x < b.left - 2 || pt.x > b.right + 2 || pt.y < b.top - 2 || pt.y > b.bottom + 2) return true;
    }
    return false;
  }

  // Point for comment c in the client coordinates of its document
  // (the iframe's viewport for HTML, the app window for DOCX).
  // null = can't place it this way; { hidden: true } = its element isn't showing.
  function anchorPoint(c, kind) {
    if (!kind || (!c.el && !c.elementSelector)) return null;
    const r = resolveAnchor(c, kind);
    if (!r.el) return null;
    if (c.el && r.textNode && r.textNode.isConnected) {
      const rect = charRect(r.textNode, r.offset);
      if (rect) {
        const dx = Math.max(-40, Math.min(40, Number(c.el.dx) || 0));
        const dy = Math.max(-30, Math.min(30, Number(c.el.dy) || 0));
        const p = { x: rect.left + dx, y: rect.top + dy };
        if (clippedAway(r, p)) p.clipped = true;
        return p;
      }
    }
    const box = r.el.getBoundingClientRect();
    if (!box.width && !box.height) return { hidden: true };
    if (c.el) {
      const fx = Math.max(0, Math.min(1, Number(c.el.fx)));
      const fy = Math.max(0, Math.min(1, Number(c.el.fy)));
      const p = { x: box.left + (isFinite(fx) ? fx : 0.5) * box.width, y: box.top + (isFinite(fy) ? fy : 0.5) * box.height };
      if (clippedAway(r, p)) p.clipped = true;
      return p;
    }
    // Older comment: keep its old spot if that's on the element, else pull it onto the element.
    const pt = legacyPoint(c, kind) || { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const ix = Math.min(12, box.width / 4), iy = Math.min(10, box.height / 4);
    return {
      x: Math.max(box.left + ix, Math.min(box.right - ix, pt.x)),
      y: Math.max(box.top + iy, Math.min(box.bottom - iy, pt.y)),
    };
  }

  function pinCoords(c) {
    const inner = $("#content-inner");
    if (c.anchor === "page") {
      const el = inner.querySelector(`[data-page="${c.page}"]`);
      if (!el) return null;
      const pr = el.getBoundingClientRect();
      const ir = inner.getBoundingClientRect();
      return { left: pr.left - ir.left + (c.x / 100) * pr.width, top: pr.top - ir.top + (c.y / 100) * pr.height };
    }
    const kind = currentAnchorKind();
    const pt = anchorPoint(c, kind);
    if (pt && (pt.hidden || pt.clipped)) return null;
    if (pt) {
      const ir = inner.getBoundingClientRect();
      if (kind === "html") {
        const iframe = htmlFrame();
        const fr = iframe.getBoundingClientRect();
        if (pt.y < -4 || pt.y > iframe.clientHeight + 30 || pt.x < -20 || pt.x > iframe.clientWidth + 20) return null;
        return { left: fr.left - ir.left + pt.x, top: fr.top - ir.top + pt.y };
      }
      return { left: pt.x - ir.left, top: pt.y - ir.top };
    }
    if (c.anchor === "html") {
      const f = htmlFrameInfo();
      if (!f) return null;
      const top = c.y - f.scrollY;
      const left = (c.x / 100) * f.width - f.scrollX;
      if (top < -4 || top > f.height + 30) return null; // scrolled out of view
      return { left, top };
    }
    return { left: (c.x / 100) * inner.clientWidth, top: (c.y / 100) * inner.clientHeight };
  }

  // Is this comment placed by the old screen-position method only?
  function isApproximate(c) {
    if (c.anchor === "page" || c.el) return false;
    const kind = currentAnchorKind();
    if (!kind || !anchorRoot(kind)) return false;
    if (!c.elementSelector) return true;
    const r = resolveAnchor(c, kind);
    return !r.el;
  }

  function onReviewedPageChanged() {
    domVersion++;
    anchorCache.forEach((v, k) => { if (!v.el || !v.el.isConnected) anchorCache.delete(k); });
    schedulePinLayout();
  }

  let layoutRaf = 0;
  function schedulePinLayout() {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layoutPins(); });
  }

  function placeEl(el, coords, dx) {
    if (!coords) { el.style.display = "none"; return; }
    el.style.display = "";
    el.style.left = (coords.left + (dx || 0)) + "px";
    el.style.top = coords.top + "px";
  }

  // Popovers: open to the right of the pin, or to the left / higher up
  // when that would run off the visible area.
  function placePopover(pop, coords) {
    if (!coords) { pop.style.display = "none"; return; }
    pop.style.display = "";
    const overlay = $("#pin-overlay");
    const pane = $("#content-pane");
    const inner = $("#content-inner");
    const w = pop.offsetWidth || 270, h = pop.offsetHeight || 140;
    const visLeft = pane.scrollLeft - inner.offsetLeft + 8;
    const visRight = visLeft + pane.clientWidth - 16;
    const visTop = state.fileType === "html" ? 8 : pane.scrollTop - inner.offsetTop + 8;
    const visBottom = state.fileType === "html" ? overlay.clientHeight - 8 : visTop + pane.clientHeight - 16;
    let left = coords.left + 20;
    if (left + w > visRight) left = coords.left - 20 - w;
    left = Math.max(visLeft, Math.min(left, visRight - w));
    let top = coords.top - 18;
    if (top + h > visBottom) top = visBottom - h;
    top = Math.max(visTop, top);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function layoutPins() {
    const overlay = $("#pin-overlay");
    overlay.querySelectorAll(".pin[data-id]").forEach((pin) => {
      const c = state.comments.find((x) => x.id === pin.dataset.id);
      if (c) placeEl(pin, pinCoords(c));
    });
    overlay.querySelectorAll(".pin-popover.saved").forEach((pop) => {
      const c = state.comments.find((x) => x.id === pop.dataset.for);
      if (c) placePopover(pop, pinCoords(c));
    });
    if (state.pendingPin) {
      const co = pinCoords(state.pendingPin.coords);
      placeEl(state.pendingPin.pin, co);
      placePopover(state.pendingPin.pop, co);
    }
  }

  // ---------------------------------------------------------------------
  // Pin dropping (click on overlay in Comment mode)
  // ---------------------------------------------------------------------
  function scrollableAncestor(el) {
    const win = el && el.ownerDocument.defaultView;
    while (el && el.tagName !== "BODY" && el.tagName !== "HTML") {
      try {
        const st = win.getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY + st.overflowX) &&
            (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) return el;
      } catch (e) { /* ignore */ }
      el = el.parentElement;
    }
    return null;
  }

  let hoverRaf = 0;
  let lastHoverEvent = null;

  function updateHoverBox() {
    hoverRaf = 0;
    const box = $("#hover-box");
    const e = lastHoverEvent;
    if (!box) return;
    if (!e || state.mode !== "comment" || state.pendingPin) { box.style.display = "none"; return; }
    const t = pointTarget(e);
    const root = t && anchorRoot(t.kind);
    if (!t || !root || t.el === root || t.el.tagName === "HTML") { box.style.display = "none"; return; }
    const el = anchorable(t.el);
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) { box.style.display = "none"; return; }
    const ir = $("#content-inner").getBoundingClientRect();
    let left = r.left, top = r.top;
    if (t.kind === "html") {
      const fr = htmlFrame().getBoundingClientRect();
      left += fr.left; top += fr.top;
    }
    box.style.display = "block";
    box.style.left = (left - ir.left) + "px";
    box.style.top = (top - ir.top) + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  function wirePinOverlay() {
    const overlay = $("#pin-overlay");

    // Outline of the element under the cursor in Comment mode
    const hb = document.createElement("div");
    hb.id = "hover-box";
    hb.className = "hover-box";
    overlay.appendChild(hb);

    overlay.addEventListener("mousemove", (e) => {
      if (e.target.closest(".pin") || e.target.closest(".pin-popover")) { lastHoverEvent = null; }
      else lastHoverEvent = { clientX: e.clientX, clientY: e.clientY };
      if (!hoverRaf) hoverRaf = requestAnimationFrame(updateHoverBox);
    });
    overlay.addEventListener("mouseleave", () => {
      lastHoverEvent = null;
      if (!hoverRaf) hoverRaf = requestAnimationFrame(updateHoverBox);
    });

    // In Comment mode the overlay sits on top of the HTML iframe, so pass
    // mouse-wheel scrolling through to whatever would scroll underneath.
    overlay.addEventListener("wheel", (e) => {
      const iframe = htmlFrame();
      if (!iframe || state.mode !== "comment") return;
      try {
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? iframe.clientHeight : 1;
        const t = pointTarget(e);
        const sc = t ? scrollableAncestor(t.el) : null;
        (sc || iframe.contentWindow).scrollBy({ left: e.deltaX * k, top: e.deltaY * k });
        e.preventDefault();
      } catch (err) { /* ignore */ }
      lastHoverEvent = { clientX: e.clientX, clientY: e.clientY };
      if (!hoverRaf) hoverRaf = requestAnimationFrame(updateHoverBox);
    }, { passive: false });

    overlay.addEventListener("click", (e) => {
      if (state.mode !== "comment" || !state.fileBlob) return;
      if (e.target.closest(".pin") || e.target.closest(".pin-popover")) return;
      const coords = clickToCoords(e);
      if (!coords) return;
      openPendingPinComposer(coords, guessElementSelector(e));
      $("#hover-box").style.display = "none";
    });
  }

  function clickToCoords(e) {
    const inner = $("#content-inner");
    const ir = inner.getBoundingClientRect();

    if (state.fileType === "html") {
      const iframe = htmlFrame();
      const f = htmlFrameInfo();
      if (!iframe || !f) return null;
      const fr = iframe.getBoundingClientRect();
      const coords = {
        anchor: "html",
        page: null,
        x: ((e.clientX - fr.left + f.scrollX) / fr.width) * 100,
        y: e.clientY - fr.top + f.scrollY,
      };
      const t = pointTarget(e);
      const a = t ? buildElementAnchor(t) : null;
      if (a) coords.el = a;
      return coords;
    }

    if (state.fileType === "pdf" || state.fileType === "pptx") {
      const pages = $$("#content-inner [data-page]");
      for (const el of pages) {
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          return {
            anchor: "page",
            page: Number(el.dataset.page),
            x: ((e.clientX - r.left) / r.width) * 100,
            y: ((e.clientY - r.top) / r.height) * 100,
          };
        }
      }
      // Clicked in the gap between pages — anchor to the whole content area.
      return {
        anchor: "content",
        page: state.currentPage,
        x: ((e.clientX - ir.left) / ir.width) * 100,
        y: ((e.clientY - ir.top) / ir.height) * 100,
      };
    }

    const coords = {
      anchor: "content",
      page: null,
      x: ((e.clientX - ir.left) / ir.width) * 100,
      y: ((e.clientY - ir.top) / ir.height) * 100,
    };
    if (state.fileType === "docx") {
      const t = pointTarget(e);
      const a = t ? buildElementAnchor(t) : null;
      if (a) coords.el = a;
    }
    return coords;
  }

  function guessElementSelector(e) {
    // Best-effort: describe what was clicked so Claude can find it later.
    try {
      let el = null;
      if (state.fileType === "html" || state.fileType === "docx") {
        const t = pointTarget(e);
        el = t ? anchorable(t.el) : null;
      } else if (state.fileType === "pptx") {
        el = document.elementsFromPoint(e.clientX, e.clientY)
          .find((n) => n.closest && n.closest(".slide-wrap") && !n.closest(".pin-overlay"));
      } else {
        return "";
      }
      if (!el || el.classList.contains("docx-container") || el.classList.contains("slide-wrap") || el.tagName === "BODY" || el.tagName === "HTML") return "";
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = el.className && typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      return `${tag}${id}${cls}${text ? ` — "${text}"` : ""}`;
    } catch (err) {
      return "";
    }
  }

  function nextCommentNumber() {
    return state.comments.reduce((max, c) => Math.max(max, c.number || 0), 0) + 1;
  }

  function openPendingPinComposer(coords, elementSelector) {
    closePendingComposer();
    closeSavedPopover();
    const overlay = $("#pin-overlay");

    const pin = document.createElement("div");
    pin.className = "pin pending";
    pin.innerHTML = `<span>${nextCommentNumber()}</span>`;
    overlay.appendChild(pin);

    const pop = document.createElement("div");
    pop.className = "pin-popover";
    pop.innerHTML = `
      <div class="meta">${coords.page ? `Page/Slide ${coords.page} · ` : ""}${escapeHtml(elementSelector || "")}</div>
      <textarea placeholder="Type your comment… (Ctrl+Enter to save)"></textarea>
      <div class="actions">
        <button class="btn small" data-act="cancel">Cancel</button>
        <button class="btn small primary" data-act="save">Save</button>
      </div>
    `;
    overlay.appendChild(pop);
    state.pendingPin = { pin, pop, coords };
    layoutPins();

    const textarea = pop.querySelector("textarea");
    textarea.focus();
    const saveBtn = pop.querySelector('[data-act="save"]');

    pop.querySelector('[data-act="cancel"]').onclick = () => closePendingComposer();
    textarea.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) saveBtn.click();
      if (ev.key === "Escape") closePendingComposer();
    });

    saveBtn.onclick = () => {
      const text = textarea.value.trim();
      if (!text) { toast("Comment can't be empty."); return; }
      ensureAuthorName(async (author) => {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        const row = {
          id: uid("c"),
          project_id: state.projectId,
          x: coords.x,
          y: coords.y,
          page: coords.page || null,
          anchor: coords.el ? "el:" + JSON.stringify(coords.el) : coords.anchor,
          text,
          author: author || "Anonymous",
          author_id: clientId(),
          element_selector: elementSelector || null,
          status: "open",
        };
        const projectAtSave = state.projectId;
        const { data, error } = await sb.from("comments").insert(row).select().single();
        if (error) {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
          toast("Couldn't save: " + friendlyError(error), 5000);
          return;
        }
        if (state.projectId !== projectAtSave) return;
        upsertLocalComment(commentFromRow(data));
        closePendingComposer();
        renderPins();
        renderSidebar();
        toast(`Comment #${data.number} added — your team sees it now.`);
      });
    };
  }

  function closePendingComposer() {
    anchorCache.delete("__pending");
    if (state.pendingPin) {
      state.pendingPin.pin.remove();
      state.pendingPin.pop.remove();
      state.pendingPin = null;
    }
  }

  function closeSavedPopover() {
    $$("#pin-overlay .pin-popover.saved").forEach((el) => el.remove());
    state.openPopoverId = null;
  }

  // ---------------------------------------------------------------------
  // Pin rendering (saved comments)
  // ---------------------------------------------------------------------
  function renderPins() {
    const overlay = $("#pin-overlay");
    overlay.querySelectorAll(".pin[data-id], .pin-popover.saved").forEach((el) => el.remove());

    [...state.comments].sort((a, b) => (a.number || 0) - (b.number || 0)).forEach((c) => {
      const pin = document.createElement("div");
      pin.className = "pin" + (c.status === "resolved" ? " resolved" : "") + (isFromEarlierVersion(c) ? " old-version" : "");
      pin.dataset.id = c.id;
      pin.innerHTML = `<span>${c.number || "•"}</span>`;
      pin.title = `${c.author}: ${c.text}`;
      pin.addEventListener("click", (ev) => {
        ev.stopPropagation();
        togglePinPopover(c.id);
      });
      overlay.appendChild(pin);
    });

    // Re-open the popover the person was reading, if that comment still exists
    if (state.openPopoverId && state.comments.some((c) => c.id === state.openPopoverId)) {
      showPinPopover(state.openPopoverId);
    } else {
      state.openPopoverId = null;
    }
    layoutPins();
  }

  function togglePinPopover(id) {
    if (state.openPopoverId === id) { closeSavedPopover(); return; }
    showPinPopover(id);
  }

  function showPinPopover(id) {
    const c = state.comments.find((x) => x.id === id);
    if (!c) return;
    const overlay = $("#pin-overlay");
    overlay.querySelectorAll(".pin-popover.saved").forEach((el) => el.remove());
    state.openPopoverId = id;

    const pop = document.createElement("div");
    pop.className = "pin-popover saved";
    pop.dataset.for = c.id;
    pop.innerHTML = `
      <div class="meta">#${c.number} · ${escapeHtml(c.author)} · ${new Date(c.timestamp).toLocaleString()}</div>
      ${c.elementSelector ? `<div class="meta" style="font-family:monospace">${escapeHtml(c.elementSelector)}</div>` : ""}
      <div style="margin:6px 0; white-space:pre-wrap;">${escapeHtml(c.text)}</div>
      <div class="actions">
        <button class="btn small" data-act="close">Close</button>
        <button class="btn small" data-act="resolve">${c.status === "resolved" ? "Reopen" : "Resolve"}</button>
        <button class="btn small danger" data-act="delete">Delete</button>
      </div>
    `;
    pop.addEventListener("click", (ev) => ev.stopPropagation());
    overlay.appendChild(pop);
    placePopover(pop, pinCoords(c));
    pop.querySelector('[data-act="close"]').onclick = () => closeSavedPopover();
    pop.querySelector('[data-act="resolve"]').onclick = () => toggleResolved(c.id);
    pop.querySelector('[data-act="delete"]').onclick = () => deleteComment(c.id);
  }

  async function toggleResolved(id) {
    const c = state.comments.find((x) => x.id === id);
    if (!c) return;
    const prev = c.status;
    const next = prev === "resolved" ? "open" : "resolved";
    c.status = next; // optimistic
    renderPins(); renderSidebar();
    const { error } = await sb.from("comments").update({ status: next }).eq("id", id);
    if (error) {
      c.status = prev;
      renderPins(); renderSidebar();
      toast("Couldn't update: " + friendlyError(error), 5000);
    }
  }

  async function deleteComment(id) {
    const c = state.comments.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`Delete comment #${c.number} for everyone?`)) return;
    const before = state.comments.slice();
    state.comments = state.comments.filter((x) => x.id !== id);
    if (state.openPopoverId === id) state.openPopoverId = null;
    renderPins(); renderSidebar();
    const { error } = await sb.from("comments").delete().eq("id", id);
    if (error) {
      state.comments = before;
      renderPins(); renderSidebar();
      toast("Couldn't delete: " + friendlyError(error), 5000);
    }
  }

  // ---------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------
  function renderSidebar() {
    const list = $("#sidebar-list");
    const openCount = state.comments.filter((c) => c.status !== "resolved").length;
    $("#count-badge").textContent = state.comments.length ? `${openCount} open · ${state.comments.length}` : "0";
    $("#toggle-count").textContent = openCount;
    $("#comments-toggle-btn").title = `${openCount} open of ${state.comments.length} comment(s) — show or hide`;

    if (!state.comments.length) {
      list.innerHTML = `<div class="empty-state">No comments yet. Switch to Comment mode and click anywhere on the content to add one. Comments appear for everyone instantly.</div>`;
      return;
    }

    const sorted = [...state.comments].sort((a, b) => (a.number || 0) - (b.number || 0));
    list.innerHTML = "";
    sorted.forEach((c) => {
      const mine = isMine(c);
      const item = document.createElement("div");
      item.className = "comment-item" + (c.status === "resolved" ? " resolved" : "");
      item.dataset.id = c.id;
      item.innerHTML = `
        <div class="row1">
          <div class="num">${c.number}</div>
          <div class="author">${escapeHtml(c.author)}${mine ? ' <span class="you-tag">you</span>' : ""}</div>
          <div class="time" title="${escapeHtml(new Date(c.timestamp).toLocaleString())}">${timeAgo(c.timestamp)}</div>
        </div>
        <div class="text">${escapeHtml(c.text)}</div>
        ${c.elementSelector ? `<div class="ctx">${escapeHtml(c.elementSelector)}</div>` : ""}
        ${c.page ? `<div class="ctx">Page/Slide ${c.page}</div>` : ""}
        ${isFromEarlierVersion(c) ? `<div class="ctx old-version-tag">Made on an earlier version of the file</div>` : ""}
        ${isApproximate(c) ? `<div class="ctx old-version-tag">Approximate position (made before precise pinning)</div>` : ""}
        <div class="item-actions">
          <button class="btn small" data-act="goto">Go to pin</button>
          <button class="btn small" data-act="resolve">${c.status === "resolved" ? "Reopen" : "Resolve"}</button>
          <button class="btn small danger" data-act="delete">Delete</button>
        </div>
      `;
      item.querySelector('[data-act="goto"]').onclick = () => gotoComment(c.id);
      item.querySelector('[data-act="resolve"]').onclick = () => toggleResolved(c.id);
      item.querySelector('[data-act="delete"]').onclick = () => deleteComment(c.id);
      list.appendChild(item);
    });
  }

  function gotoComment(id) {
    const c = state.comments.find((x) => x.id === id);
    if (!c) return;
    setSidebar(false);
    const kind = currentAnchorKind();
    const pt = c.anchor !== "page" ? anchorPoint(c, kind) : null;
    if (pt && pt.hidden) {
      toast("This comment is on part of the page that isn't showing right now (for example, something that appears after clicking a button or opening a tab). Open that part of the page and try again.", 6000);
      return;
    }
    const res = pt ? resolveAnchor(c, kind) : null;
    if (res && res.el) {
      try {
        const target = res.textNode && res.textNode.parentElement ? res.textNode.parentElement : res.el;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (e) { /* ignore */ }
    } else if (c.anchor === "html") {
      const iframe = htmlFrame();
      try { iframe.contentWindow.scrollTo({ top: Math.max(0, c.y - 150), behavior: "smooth" }); } catch (e) { /* ignore */ }
    } else {
      const co = pinCoords(c);
      if (co) {
        const pane = $("#content-pane");
        const inner = $("#content-inner");
        const top = co.top + inner.offsetTop;
        pane.scrollTo({ top: Math.max(0, top - 150), behavior: "smooth" });
      }
    }
    setTimeout(() => { layoutPins(); showPinPopover(c.id); }, 600);
  }

  // ---------------------------------------------------------------------
  // Export: comments as JSON / Markdown
  // ---------------------------------------------------------------------
  function commentsPayload() {
    return {
      project: state.projectName,
      file: state.fileName,
      fileType: state.fileType,
      exportedAt: new Date().toISOString(),
      comments: [...state.comments].sort((a, b) => a.number - b.number),
    };
  }

  function exportJson() {
    if (!state.comments.length) { toast("No comments to export yet."); return; }
    const blob = new Blob([JSON.stringify(commentsPayload(), null, 2)], { type: "application/json" });
    download(`comments-${slug(state.fileName)}.json`, blob);
  }

  function describePosition(c) {
    if (c.el) return c.el.ct ? `on the text "…${normText(c.el.ct)}…" in the element below` : "on the element below";
    if (c.anchor === "html") return `about ${Math.round(c.y)}px from the top of the page, ${c.x.toFixed(1)}% across`;
    if (c.anchor === "page") return `x=${c.x.toFixed(1)}%, y=${c.y.toFixed(1)}% of ${state.fileType === "pptx" ? "slide" : "page"} ${c.page}`;
    return `x=${c.x.toFixed(1)}%, y=${c.y.toFixed(1)}% (relative to content area)`;
  }

  function exportMarkdown() {
    if (!state.comments.length) { toast("No comments to export yet."); return; }
    const sorted = [...state.comments].sort((a, b) => a.number - b.number);
    let md = `# Review comments for \`${state.fileName}\`\n\n`;
    md += `Project: ${state.projectName}\n\n`;
    md += `Exported ${new Date().toLocaleString()} · ${sorted.length} comment(s), ${sorted.filter((c) => c.status !== "resolved").length} open\n\n`;
    md += `> Paste this file into a Claude chat along with the original source and say "please make these edits."\n\n`;
    sorted.forEach((c) => {
      md += `## Comment #${c.number}${c.status === "resolved" ? " (resolved)" : ""}\n`;
      md += `- **Author:** ${c.author}\n`;
      md += `- **Time:** ${new Date(c.timestamp).toLocaleString()}\n`;
      if (c.page != null) md += `- **Page/Slide:** ${c.page}\n`;
      md += `- **Position:** ${describePosition(c)}\n`;
      if (c.elementSelector) md += `- **Element/context:** \`${c.elementSelector}\`\n`;
      if (isFromEarlierVersion(c)) md += `- **Note:** made on an earlier version of the file\n`;
      md += `- **Status:** ${c.status}\n\n`;
      md += `${c.text}\n\n---\n\n`;
    });
    const blob = new Blob([md], { type: "text/markdown" });
    download(`comments-for-claude-${slug(state.fileName)}.md`, blob);
    toast("Markdown exported — paste it into a Claude chat.");
  }

  // ---------------------------------------------------------------------
  // One-time upload of data from the old, browser-only version
  //   Sources: this browser's IndexedDB ("comment-review-db") + the
  //   cr_comments_<id> localStorage keys, and a projects.json bundle if
  //   one is still deployed next to index.html.
  // ---------------------------------------------------------------------
  function readLegacyIdbProjects() {
    return new Promise((resolve) => {
      if (!window.indexedDB) { resolve([]); return; }
      let req;
      try { req = indexedDB.open(LEGACY_DB_NAME); } catch (e) { resolve([]); return; }
      req.onupgradeneeded = (ev) => {
        // The database didn't exist — don't create an empty one.
        if (ev.oldVersion === 0) { try { req.transaction.abort(); } catch (e) { /* ignore */ } }
      };
      req.onerror = () => resolve([]);
      req.onblocked = () => resolve([]);
      req.onsuccess = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(LEGACY_STORE)) { d.close(); resolve([]); return; }
        try {
          const tx = d.transaction(LEGACY_STORE, "readonly");
          const g = tx.objectStore(LEGACY_STORE).getAll();
          g.onsuccess = () => { d.close(); resolve(g.result || []); };
          g.onerror = () => { d.close(); resolve([]); };
        } catch (e) { d.close(); resolve([]); }
      };
    });
  }

  function readLegacyComments(projectId) {
    try {
      const raw = localStorage.getItem(LS_COMMENTS_PREFIX + projectId);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  let legacyBundlePromise = null;
  function readLegacyBundle() {
    if (!legacyBundlePromise) legacyBundlePromise = readLegacyBundleOnce();
    return legacyBundlePromise;
  }

  async function readLegacyBundleOnce() {
    try {
      const res = await fetch("projects.json", { cache: "no-store" });
      if (!res.ok) return [];
      const list = await res.json();
      if (!Array.isArray(list)) return [];
      return list.filter((p) => p && p.id && p.fileName && p.fileType);
    } catch (e) { return []; }
  }

  async function gatherLegacyCandidates() {
    const map = new Map();
    const idb = await readLegacyIdbProjects();
    idb.forEach((rec) => {
      if (!rec || !rec.id || !rec.blob || !extToType(rec.fileName || "")) return;
      map.set(rec.id, {
        id: rec.id, name: rec.name || rec.fileName, fileName: rec.fileName, fileType: rec.fileType || extToType(rec.fileName),
        createdAt: rec.createdAt, getBlob: async () => rec.blob, comments: readLegacyComments(rec.id),
      });
    });
    const bundle = await readLegacyBundle();
    for (const p of bundle) {
      const existing = map.get(p.id);
      let bundled = [];
      try {
        const r = await fetch(`comments/${encodeURIComponent(p.id)}.json`, { cache: "no-store" });
        if (r.ok) { const j = await r.json(); bundled = Array.isArray(j) ? j : (j.comments || []); }
      } catch (e) { /* none */ }
      if (existing) {
        const ids = new Set(existing.comments.map((c) => c.id));
        bundled.forEach((c) => { if (c && c.id && !ids.has(c.id)) existing.comments.push(c); });
      } else {
        map.set(p.id, {
          id: p.id, name: p.name || p.fileName, fileName: p.fileName, fileType: p.fileType, createdAt: p.createdAt,
          getBlob: async () => {
            const r = await fetch(`content/${encodeURIComponent(p.id)}/${encodeURIComponent(p.fileName)}`, { cache: "no-store" });
            if (!r.ok) throw new Error(`Couldn't read content/${p.id}/${p.fileName}`);
            return r.blob();
          },
          comments: bundled.concat(readLegacyComments(p.id).filter((c) => !bundled.some((b) => b.id === c.id))),
        });
      }
    }
    return Array.from(map.values());
  }

  function migratedIds() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_MIGRATED_IDS) || "[]")); } catch (e) { return new Set(); }
  }
  function markMigrated(id) {
    const s = migratedIds(); s.add(id);
    localStorage.setItem(LS_MIGRATED_IDS, JSON.stringify(Array.from(s)));
  }

  async function checkLegacyLocalData(cloudProjects) {
    if (sessionStorage.getItem(SS_MIGRATE_DISMISSED)) return;
    let all;
    try { all = await gatherLegacyCandidates(); } catch (e) { return; }
    const done = migratedIds();
    all = all.filter((c) => !done.has(c.id));
    if (!all.length) { $("#migrate-banner").classList.add("hidden"); legacyCandidates = []; return; }

    // Ignore projects already fully in the shared workspace.
    const cloudIds = new Set(cloudProjects.map((p) => p.id));
    const inCloud = all.filter((c) => cloudIds.has(c.id));
    let cloudCommentIds = new Set();
    const legacyCommentIds = inCloud.flatMap((c) => c.comments.map((x) => x && x.id).filter(Boolean));
    if (legacyCommentIds.length) {
      try {
        cloudCommentIds = await existingCommentIds(legacyCommentIds.map(String));
      } catch (e) { /* show banner anyway */ }
    }
    legacyCandidates = all.filter((c) =>
      !cloudIds.has(c.id) || c.comments.some((x) => x && x.id && !cloudCommentIds.has(x.id)));
    all.filter((c) => !legacyCandidates.includes(c)).forEach((c) => markMigrated(c.id));

    if (state.view !== "dashboard") return;
    if (!legacyCandidates.length) { $("#migrate-banner").classList.add("hidden"); return; }
    $("#migrate-count").textContent = legacyCandidates.length;
    $("#migrate-banner").classList.remove("hidden");
  }

  async function migrateLegacyProjects() {
    const btn = $("#migrate-btn");
    if (!legacyCandidates.length) return;
    btn.disabled = true;
    let ok = 0, failed = 0, commentsAdded = 0;
    const cloudIds = new Set((await fetchProjects().catch(() => [])).map((p) => p.id));
    for (const cand of legacyCandidates) {
      btn.textContent = `Uploading ${ok + failed + 1} of ${legacyCandidates.length}…`;
      try {
        const isNew = !cloudIds.has(cand.id);
        if (isNew) {
          const blob = await cand.getBlob();
          await uploadProject({ id: cand.id, name: cand.name, fileName: cand.fileName, fileType: cand.fileType, blob, createdAt: cand.createdAt });
        }
        commentsAdded += await importComments(cand.id, cand.comments, { keepNumbers: isNew });
        markMigrated(cand.id);
        ok++;
      } catch (err) {
        console.warn("Migration failed for", cand.id, err);
        failed++;
      }
    }
    btn.disabled = false;
    btn.textContent = "Upload to shared workspace";
    if (failed) alert(`Uploaded ${ok} project(s) and ${commentsAdded} comment(s). ${failed} project(s) failed — try again, or check the browser console for details.`);
    else toast(`Uploaded ${ok} project(s) and ${commentsAdded} comment(s). Everyone can see them now.`, 4000);
    renderDashboard(true);
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
