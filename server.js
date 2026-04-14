var express = require("express");
var cors = require("cors");
var nodemailer = require("nodemailer");
var { ImapFlow } = require("imapflow");
var { simpleParser } = require("mailparser");
var Database = require("better-sqlite3");
var path = require("path");
var multer = require("multer");
var crypto = require("crypto");
require('dotenv').config();

// multer: keep files in memory so we can pass buffers directly to nodemailer
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── SQLite – contacts + snoozed ───────────────────────────────────────────────
const db = new Database(path.join(__dirname, "contacts.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS sent_contacts (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    name  TEXT NOT NULL,
    sent_count INTEGER NOT NULL DEFAULT 1,
    last_sent  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snoozed (
    uid          INTEGER NOT NULL,
    folder       TEXT    NOT NULL DEFAULT 'inbox',
    snooze_until TEXT    NOT NULL,
    PRIMARY KEY (uid, folder)
  );
`);

const upsertContact = db.prepare(`
  INSERT INTO sent_contacts (email, name, sent_count, last_sent)
  VALUES (@email, @name, 1, @last_sent)
  ON CONFLICT(email) DO UPDATE SET
    name       = excluded.name,
    sent_count = sent_contacts.sent_count + 1,
    last_sent  = excluded.last_sent
`);

const searchContacts = db.prepare(`
  SELECT name, email FROM sent_contacts
  WHERE lower(email) LIKE lower(@q) OR lower(name) LIKE lower(@q)
  ORDER BY sent_count DESC, last_sent DESC
  LIMIT 10
`);

const topContacts = db.prepare(`
  SELECT name, email FROM sent_contacts
  ORDER BY sent_count DESC, last_sent DESC
  LIMIT 50
`);

const upsertSnooze       = db.prepare(`INSERT INTO snoozed (uid, folder, snooze_until) VALUES (@uid, @folder, @snooze_until) ON CONFLICT(uid, folder) DO UPDATE SET snooze_until = excluded.snooze_until`);
const deleteSnooze       = db.prepare(`DELETE FROM snoozed WHERE uid = ? AND folder = ?`);
const getActiveSnoozed   = db.prepare(`SELECT uid, folder, snooze_until FROM snoozed WHERE snooze_until > ? ORDER BY snooze_until ASC`);
const deleteExpiredSnooze = db.prepare(`DELETE FROM snoozed WHERE snooze_until <= ?`);

// ── IMAP connection semaphore ─────────────────────────────────────────────────
// Gmail caps simultaneous IMAP connections (~15). Concurrent React Query
// fetches (inbox list, drafts badge, email detail…) can easily exceed this.
// Limit to 3 concurrent connections and queue the rest.
const IMAP_CONCURRENCY = 3;
let _imapSlots = IMAP_CONCURRENCY;
const _imapQueue = [];

function _imapAcquire() {
  return new Promise(resolve => {
    if (_imapSlots > 0) { _imapSlots--; resolve(); }
    else { _imapQueue.push(resolve); }
  });
}

function _imapRelease() {
  if (_imapQueue.length > 0) { _imapQueue.shift()(); }
  else { _imapSlots++; }
}

// Run fn(client) with a connected client, always releasing the slot on exit.
async function withImap(fn) {
  await _imapAcquire();
  const client = makeImapClient();
  try {
    await client.connect();
    return await fn(client);
  } finally {
    _imapRelease();
    client.logout().catch(() => {});
  }
}

// ── In-memory logo cache (domain:source → {buffer, contentType, ts}) ─────────
const logoCache = new Map();
const LOGO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 h

function makeImapClient() {
  const client = new ImapFlow({
    host: process.env.IMAP_SERVER,
    port: parseInt(process.env.IMAP_PORT),
    secure: true,
    auth: {
      user: process.env.IMAP_USERNAME,
      pass: process.env.IMAP_PASSWORD.replace(/\s/g, "")
    },
    logger: false
  });
  // Prevent unhandled 'error' events (e.g. ETIMEOUT) from crashing the process.
  // Errors are surfaced through rejected promises in the route handlers instead.
  client.on("error", (err) => {
    console.error("[imap] socket error:", err.response || err.message);
  });
  return client;
}

const app = express();
app.use(cors());
app.use(express.json());

// ── GET /logo?domain=example.com ─────────────────────────────────────────────
// Browser-like UA so external services don't block server-side requests
const LOGO_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
};

// Explicit domain → brand overrides for domains whose automatic resolution fails.
// When a domain is listed here the logo is fetched from the mapped brand domain
// directly, skipping all heuristics.
const DOMAIN_BRAND_OVERRIDES = {
  "students.udemy.com":      "udemy.com",
  "e.udemymail.com":         "udemy.com",
  "business-email.bolt.eu":  "bolt.eu",
  "eccouncil.org":           "eccouncil.org",
};

// Personal / consumer email domains — never show a service logo for these
const PERSONAL_DOMAINS = new Set([
  "gmail.com","googlemail.com",
  "yahoo.com","yahoo.co.uk","yahoo.fr","yahoo.de","yahoo.es","yahoo.it","yahoo.co.jp",
  "hotmail.com","hotmail.co.uk","hotmail.fr","hotmail.de","hotmail.es","hotmail.it",
  "outlook.com","outlook.co.uk","outlook.fr","outlook.de","outlook.es","outlook.it",
  "live.com","live.co.uk","live.fr","live.de",
  "msn.com","icloud.com","me.com","mac.com",
  "aol.com","protonmail.com","proton.me","tutanota.com","tutamail.com",
  "zoho.com","yandex.com","yandex.ru","mail.ru","inbox.com",
]);

// Returns up to 2 initials (first letter of each word), e.g. "John Doe" → "JD", "Google" → "G"
function getInitials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// Subdomains that email-sending services use but aren't the brand domain
const EMAIL_SUBDOMAINS = new Set([
  "mail","email","em","e","em1","em2","smtp","smtpout",
  "mg","mg1","mg2","send","sends","m","bounce","bounces",
  "marketing","mktg","mkt","news","newsletter","newsletters",
  "notify","notifications","notification","updates","update",
  "info","noreply","no-reply","reply","support","hello",
  "promo","offers","offers1","campaign","campaigns",
  "students","accounts","account","auth","login","secure",
]);

// Suffixes that companies append to their brand name to form a dedicated
// email-sending domain, e.g. "udemymail" → brand "udemy", TLD stays the same.
const EMAIL_SLD_SUFFIXES = [
  "mail", "email", "mails", "emails",
  "news", "newsletter", "newsletters",
  "updates", "update",
  "marketing", "mktg",
  "notifications", "notification", "notify",
  "promo", "promos", "offers",
  "campaigns", "campaign",
  "sends", "send",
  "messages", "message",
  "comms", "comm",
];

// If the SLD (e.g. "udemymail") ends with a known email-domain suffix, return
// the brand part ("udemy"); otherwise return null.
function stripEmailSldSuffix(sld) {
  for (const suffix of EMAIL_SLD_SUFFIXES) {
    if (sld.length > suffix.length && sld.endsWith(suffix)) {
      return sld.slice(0, -suffix.length);
    }
  }
  return null;
}

// Returns brand-domain candidates first, then the original sending domain, deduped.
// Brand domains are tried first because sending subdomains (e.g. students.udemy.com,
// e.udemymail.com) are never real websites — fetching icons from them wastes timeout
// budget before we even reach the actual brand domain.
//
// e.g. "students.udemy.com" → ["udemy.com", "students.udemy.com"]
//      "e.udemymail.com"    → ["udemy.com", "udemymail.com", "e.udemymail.com"]
//      "email.claude.com"   → ["claude.com", "email.claude.com"]
//      "jsmastery.pro"      → ["jsmastery.pro"]  (no subdomain, returned as-is)
function domainVariants(domain) {
  const parts  = domain.split(".");
  const brand  = [];

  // Strip known email-sending subdomain prefix (e.g. "students", "e", "mail" …)
  if (parts.length > 2 && EMAIL_SUBDOMAINS.has(parts[0])) {
    brand.push(parts.slice(1).join("."));
  }

  // Apex domain (TLD+1)
  if (parts.length > 2) {
    brand.push(parts.slice(-2).join("."));
  }

  // Strip email-domain suffixes baked into the SLD itself
  // e.g. "udemymail.com" → "udemy.com"
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const stripped = stripEmailSldSuffix(sld);
  if (stripped) {
    brand.push(`${stripped}.${tld}`);
  }

  // Brand domains first, original sending domain last (deduped)
  return [...new Set([...brand, domain])];
}

// Priority order: live site icons → Clearbit → DuckDuckGo favicon CDN.
// DuckDuckGo is last because it returns a generic globe icon instead of 404 for
// unknown domains (which would prevent the frontend falling back to initials).
// For well-known domains that block direct requests (e.g. udemy.com returns 403),
// DuckDuckGo reliably serves the real favicon from its own cache.
function buildLogoUrlList(domain) {
  const variants = domainVariants(domain);
  const urls = [];

  const push = (tpl) => variants.forEach(d => urls.push(tpl(d)));

  // Live site icons first (most up-to-date)
  push(d => `https://${d}/apple-touch-icon.png`);
  push(d => `https://${d}/apple-touch-icon-precomposed.png`);
  push(d => `https://${d}/favicon.ico`);
  push(d => `https://${d}/favicon.png`);
  push(d => `https://${d}/favicon.svg`);
  push(d => `https://${d}/favicon-32x32.png`);
  push(d => `https://${d}/favicon-16x16.png`);
  // Clearbit — broad coverage but may be stale or unreachable
  push(d => `https://logo.clearbit.com/${d}`);
  // DuckDuckGo favicon CDN — works for bot-protected sites (403s, Cloudflare)
  push(d => `https://icons.duckduckgo.com/ip3/${d}.ico`);

  return [...new Set(urls)];
}

// Scrape the homepage HTML of a domain to find the favicon/logo URL declared in
// <link> or <meta> tags — many sites don't put their icon at /favicon.ico at all.
// Returns the best candidate URL found, or null if nothing usable was found.
async function scrapeFaviconUrl(domain) {
  const origins = domainVariants(domain).map(d => `https://${d}`);
  for (const origin of origins) {
    try {
      const r = await fetch(origin, {
        signal: AbortSignal.timeout(6000),
        headers: LOGO_FETCH_HEADERS,
        redirect: "follow",
      });
      if (!r.ok) continue;
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("html")) continue;

      const html = await r.text();
      const candidates = [];

      const resolve = (href) => {
        if (!href || href.startsWith("data:")) return null;
        if (href.startsWith("http")) return href;
        if (href.startsWith("//")) return `https:${href}`;
        return `${origin}${href.startsWith("/") ? "" : "/"}${href}`;
      };

      // <link rel="...icon..." href="..."> — both attribute orders
      const reLink = /<link([^>]+)>/gi;
      let m;
      while ((m = reLink.exec(html)) !== null) {
        const attrs = m[1];
        const relMatch  = /rel=["']([^"']+)["']/i.exec(attrs);
        const hrefMatch = /href=["']([^"']+)["']/i.exec(attrs);
        if (!relMatch || !hrefMatch) continue;
        const rel = relMatch[1].toLowerCase();
        if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
          const url = resolve(hrefMatch[1]);
          if (url) candidates.push(url);
        }
      }

      // <meta property="og:image"> — brand image used for social sharing
      const ogMatch = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
                   || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
      if (ogMatch) {
        const url = resolve(ogMatch[1]);
        if (url) candidates.push(url);
      }

      // <meta name="msapplication-TileImage">
      const msMatch = /<meta[^>]+name=["']msapplication-TileImage["'][^>]+content=["']([^"']+)["']/i.exec(html)
                   || /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']msapplication-TileImage["']/i.exec(html);
      if (msMatch) {
        const url = resolve(msMatch[1]);
        if (url) candidates.push(url);
      }

      if (candidates.length) return candidates[0];
    } catch (_) { /* try next origin */ }
  }
  return null;
}

app.get("/logo", async (req, res) => {
  let domain = (req.query.domain || "").toLowerCase().trim();
  if (!domain) return res.status(400).end();

  // Apply explicit brand overrides — redirect lookup to the canonical brand domain.
  // This handles cases where automatic heuristics fail (e.g. students.udemy.com).
  if (DOMAIN_BRAND_OVERRIDES[domain]) {
    domain = DOMAIN_BRAND_OVERRIDES[domain];
  }

  // Personal/consumer email providers — try Gravatar for the person's actual profile
  // photo; if they have none, return 404 so the frontend shows initials.
  if (PERSONAL_DOMAINS.has(domain)) {
    const email = (req.query.email || "").toLowerCase().trim();
    if (email) {
      const hash = crypto.createHash("md5").update(email).digest("hex");
      // d=404 → Gravatar returns 404 (not a default image) when no photo exists
      const gravatarUrl = `https://www.gravatar.com/avatar/${hash}?s=128&d=404&r=g`;
      try {
        const r = await fetch(gravatarUrl, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const contentType = r.headers.get("content-type") || "image/jpeg";
          const buffer = Buffer.from(await r.arrayBuffer());
          if (buffer.length >= 64) {
            res.setHeader("Content-Type",  contentType);
            res.setHeader("Cache-Control", "public, max-age=86400");
            return res.end(buffer);
          }
        }
      } catch (_) { /* no gravatar → fall through to 404 */ }
    }
    return res.status(404).end();
  }

  const cached = logoCache.get(domain);
  if (cached && Date.now() - cached.ts < LOGO_CACHE_TTL) {
    if (cached.notFound) return res.status(404).end();
    res.setHeader("Content-Type",  cached.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.end(cached.buffer);
  }

  for (const url of buildLogoUrlList(domain)) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: LOGO_FETCH_HEADERS,
        redirect: "follow",
      });
      if (!r.ok) {
        // console.log(`[logo-dbg] ${url} → HTTP ${r.status}`);
        continue;
      }

      const contentType = r.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        // console.log(`[logo-dbg] ${url} → bad content-type: ${contentType}`);
        continue;
      }

      const buffer = Buffer.from(await r.arrayBuffer());
      if (buffer.length < 64) {
        console.log(`[logo-dbg] ${url} → too small: ${buffer.length}b`); continue;
      }

      logoCache.set(domain, { buffer, contentType, ts: Date.now() });
      res.setHeader("Content-Type",  contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      console.log(`[logo] ${domain} → ${url}`);
      return res.end(buffer);
    } catch (e) {
      // console.log(`[logo-dbg] ${url} → ${e.message}`);
    }
  }

  // Last resort: scrape the homepage to find the real favicon URL
  try {
    const scraped = await scrapeFaviconUrl(domain);
    if (scraped) {
      const r = await fetch(scraped, {
        signal: AbortSignal.timeout(5000),
        headers: LOGO_FETCH_HEADERS,
        redirect: "follow",
      });
      if (r.ok) {
        const contentType = r.headers.get("content-type") || "";
        if (contentType.startsWith("image/")) {
          const buffer = Buffer.from(await r.arrayBuffer());
          if (buffer.length >= 64) {
            logoCache.set(domain, { buffer, contentType, ts: Date.now() });
            res.setHeader("Content-Type",  contentType);
            res.setHeader("Cache-Control", "public, max-age=86400");
            console.log(`[logo] ${domain} → ${scraped} (scraped)`);
            return res.end(buffer);
          }
        }
      }
    }
  } catch (e) {
    // console.log(`[logo-dbg] scraper failed: ${e.message}`);
  }

  // Final fallback: unavatar.io — a favicon CDN that handles bot-protected sites
  // (Cloudflare-shielded domains like udemy.com that block direct server fetches).
  // Brand domains come first in domainVariants, so udemy.com is tried before
  // students.udemy.com.
  const apexVariants = domainVariants(domain);
  for (const d of apexVariants) {
    const unavatarUrl = `https://unavatar.io/${d}?fallback=false`;
    try {
      const r = await fetch(unavatarUrl, {
        signal: AbortSignal.timeout(6000),
        headers: LOGO_FETCH_HEADERS,
        redirect: "follow",
      });
      if (!r.ok) { console.log(`[logo-dbg] ${unavatarUrl} → HTTP ${r.status}`); continue; }
      const contentType = r.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) { console.log(`[logo-dbg] ${unavatarUrl} → bad content-type: ${contentType}`); continue; }
      const buffer = Buffer.from(await r.arrayBuffer());
      if (buffer.length < 64) { console.log(`[logo-dbg] ${unavatarUrl} → too small: ${buffer.length}b`); continue; }
      logoCache.set(domain, { buffer, contentType, ts: Date.now() });
      res.setHeader("Content-Type",  contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      console.log(`[logo] ${domain} → ${unavatarUrl} (unavatar)`);
      return res.end(buffer);
    } catch (e) {
      // console.log(`[logo-dbg] ${unavatarUrl} → ${e.message}`);
    }
  }

  logoCache.set(domain, { notFound: true, ts: Date.now() });
  console.log(`[logo] ${domain} → not found`);
  res.status(404).end();
});

// ── DELETE /logo/cache ───────────────────────────────────────────────────────
// Clear logo cache. Use ?domain=example.com for specific domain, or no query for all
app.delete("/logo/cache", (req, res) => {
  const domain = (req.query.domain || "").toLowerCase().trim();
  
  if (domain) {
    // Clear specific domain
    const deleted = logoCache.delete(domain);
    if (deleted) {
      console.log(`[logo] Cache cleared for ${domain}`);
      res.json({ success: true, message: `Cache cleared for ${domain}` });
    } else {
      res.json({ success: false, message: `No cache entry found for ${domain}` });
    }
  } else {
    // Clear entire cache
    const size = logoCache.size;
    logoCache.clear();
    console.log(`[logo] Cleared entire cache (${size} entries)`);
    res.json({ success: true, message: `Cleared all ${size} cached logos` });
  }
});

// ── POST /emails/drafts — save a draft to the IMAP Drafts folder ─────────────
app.post("/emails/drafts", upload.array("attachments"), async (req, res) => {
  const { to, subject, text, html } = req.body;

  // Build the raw RFC 2822 message with nodemailer (no SMTP connection)
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const attachments = (req.files || []).map(f => ({
    filename: f.originalname,
    content:  f.buffer,
    contentType: f.mimetype,
  }));

  const info = await builder.sendMail({
    from:    process.env.SMTP_USERNAME,
    to:      to || "",
    subject: subject || "",
    text:    text || "",
    ...(html        ? { html }        : {}),
    ...(attachments.length ? { attachments } : {}),
  });

  const rawMessage = info.message; // Buffer

  try {
    await withImap(async (client) => {
      const draftsPath = await findMailbox(client, "\\Drafts", ["Drafts", "[Gmail]/Drafts", "Draft"]);
      if (!draftsPath) return res.status(500).json({ error: "Drafts folder not found" });
      await client.append(draftsPath, rawMessage, ["\\Draft", "\\Seen"]);
      res.json({ success: true });
    });
  } catch (err) {
    console.error("[imap] save draft error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

app.post("/send-email", upload.array("attachments"), async (req, res) => {
  const { to, subject, text, html } = req.body;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_SERVER,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
      user: process.env.SMTP_USERNAME,
      pass: process.env.SMTP_PASSWORD
    }
  });

  const attachments = (req.files || []).map(f => ({
    filename: f.originalname,
    content:  f.buffer,
    contentType: f.mimetype,
  }));

  await transporter.sendMail({
    from: process.env.SMTP_USERNAME,
    to,
    subject,
    text: text || "",
    ...(html ? { html } : {}),
    ...(attachments.length ? { attachments } : {}),
  });

  res.json({ success: true });
});

function collectAttachments(structure, result = []) {
  if (!structure) return result;

  if (structure.disposition === "attachment") {
    const filename =
      structure.dispositionParameters?.filename ||
      structure.parameters?.name ||
      "attachment";
    result.push({
      filename,
      contentType: structure.type && structure.subtype
        ? `${structure.type}/${structure.subtype}`
        : "application/octet-stream",
    });
  }

  if (structure.childNodes?.length) {
    for (const child of structure.childNodes) {
      collectAttachments(child, result);
    }
  }

  return result;
}

function hasAttachments(structure) {
  return collectAttachments(structure).length > 0;
}

app.get("/emails", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pagesize = parseInt(req.query.limit) || 50;

  try {
    await withImap(async (client) => {
      let emails = [];
      let total = 0;
      const lock = await client.getMailboxLock("INBOX");
      try {
        const mailbox = await client.mailboxOpen("INBOX");
        total = mailbox.exists;
        const end   = total - (page - 1) * pagesize;
        const start = Math.max(1, end - pagesize + 1);

        for await (const msg of client.fetch(`${start}:${end}`, {
          envelope: true, bodyStructure: true, reverse: true, flags: true,
          headers: ["authentication-results"],
        })) {
          const subject     = msg.envelope.subject || "(No Subject)";
          const fromObj     = msg.envelope.from?.[0];
          const senderEmail = fromObj?.address || "unknown@unknown.com";
          const senderName  = fromObj?.name || senderEmail.split("@")[0];
          const date        = new Date(msg.envelope.date);
          const isToday     = date.toDateString() === new Date().toDateString();
          const timeStr     = isToday
            ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : date.toLocaleDateString([], { month: "short", day: "numeric" });
          const authRaw     = msg.headers ? msg.headers.toString().replace(/\r?\n[ \t]+/g, " ") : "";
          emails.push({
            id: msg.uid, unread: !msg.flags.has("\\Seen"),
            starred: msg.flags?.has("\\Flagged"),
            senderName, senderEmail, sender: senderName,
            avatar: getInitials(senderName), avatarColor: "#1a73e8",
            subject, preview: subject.substring(0, 80),
            time: timeStr, date: date.toISOString(), label: "inbox",
            verified: /dkim=pass/i.test(authRaw) || /dmarc=pass/i.test(authRaw),
            attachments: collectAttachments(msg.bodyStructure),
            hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
          });
        }
      } finally { lock.release(); }
      res.json({ emails: emails.reverse(), total });
    });
  } catch (err) {
    console.error("[imap] /emails error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});



// app.get("/emails", async (req, res) => {
//   const client = new ImapFlow({
//     host: process.env.IMAP_SERVER,
//     port: process.env.IMAP_PORT,
//     secure: true,
//     auth: {
//       user: process.env.IMAP_USERNAME,
//       pass: process.env.IMAP_PASSWORD
//     }
//   });

//   await client.connect();

//   let emails = [];
//   let lock = await client.getMailboxLock("INBOX");

//   try {
//     for await (let msg of client.fetch("1:*", { envelope: true })) {
//       emails.push({
//         subject: msg.envelope.subject,
//         from: msg.envelope.from[0].address
//       });
//     }
//   } finally {
//     lock.release();
//   }

//   await client.logout();
//   res.json(emails);
// });


app.get("/emails/starred", async (req, res) => {
  try {
    await withImap(async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      let emails = [];
      try {
        const uids = await client.search({ flagged: true }, { uid: true });
        if (uids.length > 0) {
          for await (const msg of client.fetch(uids.join(","), {
            envelope: true, bodyStructure: true, flags: true,
          }, { uid: true })) {
            const fromObj     = msg.envelope.from?.[0];
            const senderEmail = fromObj?.address || "unknown@unknown.com";
            const senderName  = fromObj?.name || senderEmail.split("@")[0];
            const date        = new Date(msg.envelope.date);
            const isToday     = date.toDateString() === new Date().toDateString();
            emails.push({
              id: msg.uid, unread: !msg.flags.has("\\Seen"), starred: true,
              senderName, senderEmail, sender: senderName,
              avatar: getInitials(senderName), avatarColor: "#1a73e8",
              subject: msg.envelope.subject || "(No Subject)",
              preview: (msg.envelope.subject || "").substring(0, 80),
              time: isToday
                ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : date.toLocaleDateString([], { month: "short", day: "numeric" }),
              date: date.toISOString(), label: "inbox",
              attachments: collectAttachments(msg.bodyStructure),
              hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
            });
          }
        }
      } finally { lock.release(); }
      res.json(emails.reverse());
    });
  } catch (err) {
    console.error("[imap] /emails/starred error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── GET /emails/sent ─────────────────────────────────────────────────────────
app.get("/emails/sent", async (req, res) => {
  const page     = parseInt(req.query.page)  || 1;
  const pagesize = parseInt(req.query.limit) || 50;
  try {
    await withImap(async (client) => {
      const sentPath = await findMailbox(client, "\\Sent", ["Sent", "Sent Items", "Sent Messages", "[Gmail]/Sent Mail"]);
      if (!sentPath) return res.json({ emails: [], total: 0 });
      let emails = [], total = 0;
      const lock = await client.getMailboxLock(sentPath);
      try {
        total = (await client.mailboxOpen(sentPath)).exists;
        if (total === 0) return res.json({ emails: [], total: 0 });
        const end = total - (page - 1) * pagesize, start = Math.max(1, end - pagesize + 1);
        for await (const msg of client.fetch(`${start}:${end}`, { envelope: true, bodyStructure: true, flags: true })) {
          const toList    = msg.envelope.to || [];
          const toDisplay = toList.map(t => t.name || t.address).filter(Boolean).join(", ") || "—";
          const date      = new Date(msg.envelope.date);
          const isToday   = date.toDateString() === new Date().toDateString();
          emails.push({
            id: msg.uid, unread: !msg.flags.has("\\Seen"), starred: msg.flags.has("\\Flagged"),
            senderName: toDisplay, senderEmail: toList[0]?.address || "",
            sender: toDisplay, avatar: getInitials(toDisplay), avatarColor: "#34a853",
            subject: msg.envelope.subject || "(No Subject)",
            preview: (msg.envelope.subject || "").substring(0, 80),
            time: isToday
              ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : date.toLocaleDateString([], { month: "short", day: "numeric" }),
            date: date.toISOString(), label: "sent",
            attachments: collectAttachments(msg.bodyStructure),
            hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
          });
        }
      } finally { lock.release(); }
      res.json({ emails: emails.reverse(), total });
    });
  } catch (err) {
    console.error("[imap] /emails/sent error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── GET /emails/drafts ───────────────────────────────────────────────────────
app.get("/emails/drafts", async (req, res) => {
  const page     = parseInt(req.query.page)  || 1;
  const pagesize = parseInt(req.query.limit) || 50;
  try {
    await withImap(async (client) => {
      const draftsPath = await findMailbox(client, "\\Drafts", ["Drafts", "[Gmail]/Drafts", "Draft"]);
      if (!draftsPath) return res.json({ emails: [], total: 0 });
      let emails = [], total = 0;
      const lock = await client.getMailboxLock(draftsPath);
      try {
        total = (await client.mailboxOpen(draftsPath)).exists;
        if (total === 0) return res.json({ emails: [], total: 0 });
        const end = total - (page - 1) * pagesize, start = Math.max(1, end - pagesize + 1);
        for await (const msg of client.fetch(`${start}:${end}`, { envelope: true, bodyStructure: true, flags: true })) {
          const toList    = msg.envelope.to || [];
          const toDisplay = toList.map(t => t.name || t.address).filter(Boolean).join(", ") || "—";
          const date      = new Date(msg.envelope.date || Date.now());
          const isToday   = date.toDateString() === new Date().toDateString();
          emails.push({
            id: msg.uid, unread: !msg.flags.has("\\Seen"), starred: msg.flags.has("\\Flagged"),
            senderName: toDisplay || "Draft", senderEmail: toList[0]?.address || "",
            sender: toDisplay || "Draft", avatar: getInitials(toDisplay || "Draft"), avatarColor: "#e53935",
            subject: msg.envelope.subject || "(No Subject)",
            preview: (msg.envelope.subject || "").substring(0, 80),
            time: isToday
              ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : date.toLocaleDateString([], { month: "short", day: "numeric" }),
            date: date.toISOString(), label: "drafts",
            attachments: collectAttachments(msg.bodyStructure),
            hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
          });
        }
      } finally { lock.release(); }
      res.json({ emails: emails.reverse(), total });
    });
  } catch (err) {
    console.error("[imap] /emails/drafts error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── GET /emails/snoozed ──────────────────────────────────────────────────────
app.get("/emails/snoozed", async (req, res) => {
  const now = new Date().toISOString();
  deleteExpiredSnooze.run(now);
  const rows = getActiveSnoozed.all(now);
  if (rows.length === 0) return res.json({ emails: [], total: 0 });

  // Group UIDs by source folder so we open each mailbox once
  const byFolder = {};
  for (const row of rows) {
    if (!byFolder[row.folder]) byFolder[row.folder] = [];
    byFolder[row.folder].push(row);
  }

  const emailMap = {};
  try {
    await withImap(async (client) => {
      for (const [folderHint, folderRows] of Object.entries(byFolder)) {
        const mailboxPath = await resolveMailbox(client, folderHint);
        const lock = await client.getMailboxLock(mailboxPath);
        try {
          const uidList = folderRows.map(r => r.uid).join(",");
          for await (const msg of client.fetch(uidList, { envelope: true, bodyStructure: true, flags: true }, { uid: true })) {
            const fromObj     = msg.envelope.from?.[0];
            const senderEmail = fromObj?.address || "unknown@unknown.com";
            const senderName  = fromObj?.name || senderEmail.split("@")[0];
            const date        = new Date(msg.envelope.date || Date.now());
            const isToday     = date.toDateString() === new Date().toDateString();
            const rowData     = folderRows.find(r => r.uid === msg.uid);
            emailMap[`${msg.uid}:${folderHint}`] = {
              id: msg.uid, unread: !msg.flags.has("\\Seen"), starred: msg.flags.has("\\Flagged"),
              senderName, senderEmail, sender: senderName,
              avatar: getInitials(senderName), avatarColor: "#1a73e8",
              subject: msg.envelope.subject || "(No Subject)",
              preview: (msg.envelope.subject || "").substring(0, 80),
              time: isToday
                ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : date.toLocaleDateString([], { month: "short", day: "numeric" }),
              date: date.toISOString(), label: "snoozed",
              snoozeUntil:  rowData?.snooze_until,
              sourceFolder: folderHint,
              attachments: collectAttachments(msg.bodyStructure),
              hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
            };
          }
        } finally { lock.release(); }
      }
    });
  } catch (err) {
    console.error("[imap] /emails/snoozed error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
    return;
  }

  const emails = rows.map(r => emailMap[`${r.uid}:${r.folder}`]).filter(Boolean);
  res.json({ emails, total: emails.length });
});

// ── POST /emails/:id/snooze ───────────────────────────────────────────────────
app.post("/emails/:id/snooze", (req, res) => {
  const uid = parseInt(req.params.id);
  const { snooze_until, folder = "inbox" } = req.body;
  if (!snooze_until) return res.status(400).json({ error: "snooze_until required" });
  upsertSnooze.run({ uid, folder, snooze_until });
  res.json({ success: true });
});

// ── DELETE /emails/:id/snooze — remove snooze (unsnooze) ─────────────────────
app.delete("/emails/:id/snooze", (req, res) => {
  const uid = parseInt(req.params.id);
  const folder = req.query.folder || "inbox";
  deleteSnooze.run(uid, folder);
  res.json({ success: true });
});

// ── GET /emails/spam ─────────────────────────────────────────────────────────
app.get("/emails/spam", async (req, res) => {
  const page     = parseInt(req.query.page)  || 1;
  const pagesize = parseInt(req.query.limit) || 50;
  try {
    await withImap(async (client) => {
      const spamPath = await findMailbox(client, "\\Junk", ["Spam", "[Gmail]/Spam", "Junk", "Junk Email"]);
      if (!spamPath) return res.json({ emails: [], total: 0 });
      let emails = [], total = 0;
      const lock = await client.getMailboxLock(spamPath);
      try {
        total = (await client.mailboxOpen(spamPath)).exists;
        if (total === 0) return res.json({ emails: [], total: 0 });
        const end = total - (page - 1) * pagesize, start = Math.max(1, end - pagesize + 1);
        for await (const msg of client.fetch(`${start}:${end}`, { envelope: true, bodyStructure: true, flags: true })) {
          const fromObj     = msg.envelope.from?.[0];
          const senderEmail = fromObj?.address || "unknown@unknown.com";
          const senderName  = fromObj?.name || senderEmail.split("@")[0];
          const date        = new Date(msg.envelope.date || Date.now());
          const isToday     = date.toDateString() === new Date().toDateString();
          emails.push({
            id: msg.uid, unread: !msg.flags.has("\\Seen"), starred: msg.flags.has("\\Flagged"),
            senderName, senderEmail, sender: senderName,
            avatar: getInitials(senderName), avatarColor: "#1a73e8",
            subject: msg.envelope.subject || "(No Subject)",
            preview: (msg.envelope.subject || "").substring(0, 80),
            time: isToday
              ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : date.toLocaleDateString([], { month: "short", day: "numeric" }),
            date: date.toISOString(), label: "spam",
            attachments: collectAttachments(msg.bodyStructure),
            hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
          });
        }
      } finally { lock.release(); }
      emails.sort((a, b) => new Date(b.date) - new Date(a.date));
      res.json({ emails, total });
    });
  } catch (err) {
    console.error("[imap] /emails/spam error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── GET /emails/trash ────────────────────────────────────────────────────────
app.get("/emails/trash", async (req, res) => {
  const page     = parseInt(req.query.page)  || 1;
  const pagesize = parseInt(req.query.limit) || 50;
  try {
    await withImap(async (client) => {
      const trashPath = await findMailbox(client, "\\Trash", ["Trash", "[Gmail]/Trash", "Deleted Items"]);
      if (!trashPath) return res.json({ emails: [], total: 0 });
      let emails = [], total = 0;
      const lock = await client.getMailboxLock(trashPath);
      try {
        total = (await client.mailboxOpen(trashPath)).exists;
        if (total === 0) return res.json({ emails: [], total: 0 });
        const end = total - (page - 1) * pagesize, start = Math.max(1, end - pagesize + 1);
        for await (const msg of client.fetch(`${start}:${end}`, { envelope: true, bodyStructure: true, flags: true })) {
          const fromObj     = msg.envelope.from?.[0];
          const senderEmail = fromObj?.address || "unknown@unknown.com";
          const senderName  = fromObj?.name || senderEmail.split("@")[0];
          const date        = new Date(msg.envelope.date || Date.now());
          const isToday     = date.toDateString() === new Date().toDateString();
          emails.push({
            id: msg.uid, unread: !msg.flags.has("\\Seen"), starred: msg.flags.has("\\Flagged"),
            senderName, senderEmail, sender: senderName,
            avatar: getInitials(senderName), avatarColor: "#1a73e8",
            subject: msg.envelope.subject || "(No Subject)",
            preview: (msg.envelope.subject || "").substring(0, 80),
            time: isToday
              ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : date.toLocaleDateString([], { month: "short", day: "numeric" }),
            date: date.toISOString(), label: "trash",
            attachments: collectAttachments(msg.bodyStructure),
            hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
          });
        }
      } finally { lock.release(); }
      emails.sort((a, b) => new Date(b.date) - new Date(a.date));
      res.json({ emails, total });
    });
  } catch (err) {
    console.error("[imap] /emails/trash error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── GET /emails/thread?subject=...  ─────────────────────────────────────────
// Returns all messages in INBOX + Sent that share the same base subject,
// sorted oldest-first. Used by the frontend to render threaded conversations.
app.get("/emails/thread", async (req, res) => {
  const rawSubject = (req.query.subject || "").trim();
  if (!rawSubject) return res.json([]);
  // Strip any number of Re:/Fwd:/Fw:/AW:/WG: prefixes to get the base subject
  const baseSubject = rawSubject.replace(/^((Re|Fwd?|Fw|AW|WG):\s*)*/gi, "").trim();
  if (!baseSubject) return res.json([]);

  try {
    const messages = [];

    await withImap(async (client) => {
      const fetchFromMailbox = async (mailboxPath, folder) => {
        const lock = await client.getMailboxLock(mailboxPath);
        try {
          const uids = await client.search({ subject: baseSubject }, { uid: true });
          if (!uids || uids.length === 0) return;
          for await (const msg of client.fetch(uids, { envelope: true, flags: true }, { uid: true })) {
            const fromObj = msg.envelope.from?.[0];
            const toList  = msg.envelope.to || [];
            const date    = new Date(msg.envelope.date);
            const isToday = date.toDateString() === new Date().toDateString();
            const senderEmail = folder === "sent" ? (toList[0]?.address || "") : (fromObj?.address || "");
            const senderName  = folder === "sent"
              ? (toList.map(t => t.name || t.address).filter(Boolean).join(", ") || "—")
              : (fromObj?.name || senderEmail.split("@")[0] || "Unknown");
            messages.push({
              id: msg.uid,
              folder,
              senderName,
              senderEmail,
              subject: msg.envelope.subject || "(No Subject)",
              date: date.toISOString(),
              time: isToday
                ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : date.toLocaleDateString([], { month: "short", day: "numeric" }),
              unread: !msg.flags.has("\\Seen"),
              avatar: getInitials(senderName),
            });
          }
        } finally { lock.release(); }
      };

      await fetchFromMailbox("INBOX", "inbox");
      const sentPath = await findMailbox(client, "\\Sent", ["Sent", "Sent Items", "Sent Messages", "[Gmail]/Sent Mail"]);
      if (sentPath) await fetchFromMailbox(sentPath, "sent");
    });

    // Deduplicate (same uid+folder) and sort oldest-first
    const seen = new Set();
    const unique = messages.filter(m => {
      const key = `${m.folder}:${m.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json(unique.sort((a, b) => new Date(a.date) - new Date(b.date)));
  } catch (err) {
    console.error("[imap] /emails/thread error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

app.get("/emails/:id", async (req, res) => {
  const uid = parseInt(req.params.id);
  const folderHint = req.query.folder || "inbox";
  try {
    await withImap(async (client) => {
      const mailboxPath = await resolveMailbox(client, folderHint);
      const lock = await client.getMailboxLock(mailboxPath);
      try {
        const download = await client.download(`${uid}`, undefined, { uid: true });
        if (!download || !download.content) return res.status(404).json({ error: "Message not found" });
        const parsed  = await simpleParser(download.content);
        const fromObj = parsed.from?.value?.[0];
        const toObj   = parsed.to?.value?.[0];
        res.json({
          id: uid,
          subject:     parsed.subject || "(No Subject)",
          senderName:  fromObj?.name  || fromObj?.address?.split("@")[0] || "Unknown",
          senderEmail: fromObj?.address || "",
          toName:      toObj?.name    || toObj?.address?.split("@")[0]  || "",
          toEmail:     toObj?.address || "",
          date:        parsed.date?.toISOString() || null,
          text:        parsed.text || "",
          html:        parsed.html || "",
          attachments: (parsed.attachments || []).map((att, i) => ({
            index: i,
            filename: att.filename || `attachment-${i + 1}`,
            contentType: att.contentType || "application/octet-stream",
            size: att.size || att.content?.length || 0,
          })),
        });
      } finally { lock.release(); }
    });
  } catch (err) {
    console.error("[imap] /emails/:id error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

app.get("/emails/:id/attachments/:index", async (req, res) => {
  const uid   = parseInt(req.params.id);
  const index = parseInt(req.params.index);
  const folderHint = req.query.folder || "inbox";
  try {
    await withImap(async (client) => {
      const mailboxPath = await resolveMailbox(client, folderHint);
      const lock = await client.getMailboxLock(mailboxPath);
      try {
        const download = await client.download(`${uid}`, undefined, { uid: true });
        if (!download || !download.content) return res.status(404).json({ error: "Message not found" });
        const parsed = await simpleParser(download.content);
        const att = (parsed.attachments || [])[index];
        if (!att) return res.status(404).json({ error: "Attachment not found" });
        const filename = encodeURIComponent(att.filename || `attachment-${index + 1}`);
        res.setHeader("Content-Type", att.contentType || "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
        res.setHeader("Content-Length", att.content.length);
        res.end(att.content);
      } finally { lock.release(); }
    });
  } catch (err) {
    console.error("[imap] /emails/:id/attachments error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── Helper: find a special-use mailbox path ──────────────────────────────────
async function findMailbox(client, specialUse, fallbackNames = []) {
  const list = await client.list();
  let mb = list.find(m => m.specialUse === specialUse);
  if (mb) return mb.path;
  for (const name of fallbackNames) {
    mb = list.find(m => m.path === name || m.name === name);
    if (mb) return mb.path;
  }
  return null;
}

// ── Helper: resolve a folder hint ("sent", "inbox", …) to an IMAP path ───────
async function resolveMailbox(client, folderHint) {
  if (!folderHint || folderHint === "inbox") return "INBOX";
  if (folderHint === "sent") {
    return (await findMailbox(client, "\\Sent",   ["Sent", "Sent Items", "Sent Messages", "[Gmail]/Sent Mail"])) || "INBOX";
  }
  if (folderHint === "drafts") {
    return (await findMailbox(client, "\\Drafts", ["Drafts", "[Gmail]/Drafts", "Draft"])) || "INBOX";
  }
  if (folderHint === "trash") {
    return (await findMailbox(client, "\\Trash",  ["Trash", "[Gmail]/Trash", "Deleted Items"])) || "INBOX";
  }
  if (folderHint === "spam") {
    return (await findMailbox(client, "\\Junk", ["Spam", "[Gmail]/Spam", "Junk", "Junk Email"])) || "INBOX";
  }
  return "INBOX";
}

// ── Helper: run an IMAP action on the given mailbox then logout ───────────────
async function mailboxAction(res, mailboxPath, fn) {
  try {
    await withImap(async (client) => {
      const resolvedPath = typeof mailboxPath === "function"
        ? await mailboxPath(client)
        : mailboxPath;
      const lock = await client.getMailboxLock(resolvedPath);
      try {
        await fn(client);
        if (!res.headersSent) res.json({ success: true });
      } finally {
        lock.release();
      }
    });
  } catch (err) {
    console.error("[imap] mailboxAction error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
}

// Convenience wrapper — keeps all existing callers working unchanged
async function inboxAction(res, fn) {
  return mailboxAction(res, "INBOX", fn);
}

// ── POST /emails/:id/unsubscribe ─────────────────────────────────────────────
app.post("/emails/:id/unsubscribe", async (req, res) => {
  const uid = parseInt(req.params.id);
  try {
    await withImap(async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        let headerBuffer;
        for await (const msg of client.fetch(`${uid}`, { headers: ["list-unsubscribe", "list-unsubscribe-post"] }, { uid: true })) {
          headerBuffer = msg.headers;
        }

        const unfolded = (headerBuffer ? headerBuffer.toString() : "").replace(/\r?\n[ \t]/g, " ");
        const luMatch  = unfolded.match(/^list-unsubscribe:\s*(.*)/im);
        const lupMatch = unfolded.match(/^list-unsubscribe-post:\s*(.*)/im);
        const listUnsubscribe     = luMatch  ? luMatch[1].trim()  : "";
        const listUnsubscribePost = lupMatch ? lupMatch[1].trim() : "";

        if (!listUnsubscribe) return res.status(400).json({ error: "No List-Unsubscribe header found" });

        const urls      = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map(m => m[1]);
        const httpsUrl  = urls.find(u => /^https?:\/\//i.test(u));
        const mailtoUrl = urls.find(u => /^mailto:/i.test(u));
        let method = "none";

        if (httpsUrl && listUnsubscribePost) {
          await fetch(httpsUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
          method = "http-post";
        } else if (mailtoUrl) {
          const url  = new URL(mailtoUrl);
          const transporter = nodemailer.createTransport({ host: process.env.SMTP_SERVER, port: process.env.SMTP_PORT, secure: true, auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD } });
          await transporter.sendMail({ from: process.env.SMTP_USERNAME, to: url.pathname, subject: url.searchParams.get("subject") || "Unsubscribe", text: "" });
          method = "mailto";
        } else if (httpsUrl) {
          await fetch(httpsUrl);
          method = "http-get";
        }

        const spamFolder = await findMailbox(client, "\\Junk", ["Spam", "[Gmail]/Spam", "Junk", "Junk Email"]);
        if (spamFolder) await client.messageMove(`${uid}`, spamFolder, { uid: true });
        res.json({ success: true, method });
      } finally { lock.release(); }
    });
  } catch (err) {
    console.error("Unsubscribe error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── GET /mailboxes — list all folders ────────────────────────────────────────
app.get("/mailboxes", async (req, res) => {
  try {
    await withImap(async (client) => {
      const list = await client.list();
      res.json(list.map(m => ({ path: m.path, name: m.name, specialUse: m.specialUse || null })));
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── POST /emails/:id/archive ─────────────────────────────────────────────────
app.post("/emails/:id/archive", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, req.query.folder), async (client) => {
    const dest = await findMailbox(client, "\\Archive", ["Archive", "[Gmail]/All Mail", "All Mail"]);
    if (dest) {
      await client.messageMove(`${uid}`, dest, { uid: true });
    } else {
      await client.messageDelete(`${uid}`, { uid: true });
    }
  });
});

// ── POST /emails/:id/spam ────────────────────────────────────────────────────
app.post("/emails/:id/spam", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, req.query.folder), async (client) => {
    const dest = await findMailbox(client, "\\Junk", ["Spam", "[Gmail]/Spam", "Junk", "Junk Email"]);
    if (dest) await client.messageMove(`${uid}`, dest, { uid: true });
  });
});

// ── GET /emails/trash ────────────────────────────────────────────────────────
// ── POST /emails/:id/trash ───────────────────────────────────────────────────
app.post("/emails/:id/trash", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, req.query.folder), async (client) => {
    const dest = await findMailbox(client, "\\Trash", ["Trash", "[Gmail]/Trash", "Deleted Items"]);
    if (dest) {
      await client.messageMove(`${uid}`, dest, { uid: true });
    } else {
      await client.messageDelete(`${uid}`, { uid: true });
    }
  });
});

// ── POST /emails/:id/restore — move from Trash back to Inbox ─────────────────
app.post("/emails/:id/restore", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, "trash"), async (client) => {
    await client.messageMove(`${uid}`, "INBOX", { uid: true });
  });
});

// ── POST /emails/:id/not-spam — move from Spam back to Inbox ─────────────────
app.post("/emails/:id/not-spam", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, "spam"), async (client) => {
    await client.messageMove(`${uid}`, "INBOX", { uid: true });
  });
});

// ── DELETE /emails/spam — permanently delete all messages in Spam ─────────────
app.delete("/emails/spam", async (req, res) => {
  try {
    await withImap(async (client) => {
      const spamPath = await findMailbox(client, "\\Junk", ["Spam", "[Gmail]/Spam", "Junk", "Junk Email"]);
      if (!spamPath) return res.json({ success: true, deleted: 0 });
      const lock = await client.getMailboxLock(spamPath);
      try {
        const mb = await client.mailboxOpen(spamPath);
        if (mb.exists === 0) return res.json({ success: true, deleted: 0 });
        await client.messageFlagsAdd("1:*", ["\\Deleted"], { uid: false });
        await client.mailboxClose(); // expunge on close
        res.json({ success: true, deleted: mb.exists });
      } finally { lock.release(); }
    });
  } catch (err) {
    console.error("[imap] DELETE /emails/spam error:", err.response || err.message);
    if (!res.headersSent) res.status(500).json({ error: err.response || err.message });
  }
});

// ── POST /emails/:id/delete-forever — permanently delete from Trash ───────────
app.post("/emails/:id/delete-forever", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, "trash"), async (client) => {
    await client.messageDelete(`${uid}`, { uid: true });
  });
});

// ── POST /emails/:id/mark-unread ─────────────────────────────────────────────
app.post("/emails/:id/mark-unread", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, req.query.folder), async (client) => {
    await client.messageFlagsRemove(`${uid}`, ["\\Seen"], { uid: true });
  });
});

// ── POST /emails/:id/mark-read ───────────────────────────────────────────────
app.post("/emails/:id/mark-read", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, req.query.folder), async (client) => {
    await client.messageFlagsAdd(`${uid}`, ["\\Seen"], { uid: true });
  });
});

// ── POST /emails/:id/star ────────────────────────────────────────────────────
app.post("/emails/:id/star", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, req.query.folder), async (client) => {
    await client.messageFlagsAdd(`${uid}`, ["\\Flagged"], { uid: true });
  });
});

// ── POST /emails/:id/unstar ──────────────────────────────────────────────────
app.post("/emails/:id/unstar", async (req, res) => {
  const uid = parseInt(req.params.id);
  await mailboxAction(res, (c) => resolveMailbox(c, req.query.folder), async (client) => {
    await client.messageFlagsRemove(`${uid}`, ["\\Flagged"], { uid: true });
  });
});

// ── POST /emails/:id/move ────────────────────────────────────────────────────
app.post("/emails/:id/move", async (req, res) => {
  const uid = parseInt(req.params.id);
  const { mailbox } = req.body;
  if (!mailbox) return res.status(400).json({ error: "mailbox required" });
  await mailboxAction(res, (c) => resolveMailbox(c, req.query.folder), async (client) => {
    await client.messageMove(`${uid}`, mailbox, { uid: true });
  });
});

// ── POST /contacts ───────────────────────────────────────────────────────────
// Called by the frontend after a successful send to persist recipients.
// Body: [{ name, email }, ...]
app.post("/contacts", (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  const now = new Date().toISOString();
  const insertMany = db.transaction((contacts) => {
    for (const c of contacts) {
      if (!c.email) continue;
      upsertContact.run({ email: c.email.trim(), name: (c.name || c.email).trim(), last_sent: now });
    }
  });
  insertMany(list);
  res.json({ ok: true });
});

// ── GET /contacts?q=query ────────────────────────────────────────────────────
// Returns contacts from SQLite only, ordered by sent_count DESC.
app.get("/contacts", (req, res) => {
  const q = (req.query.q || "").trim();

  // No query → return top 50 for pre-loading
  if (!q) return res.json(topContacts.all());

  res.json(searchContacts.all({ q: `%${q}%` }));
});

// ── GET /storage — IMAP quota (used / limit in bytes) ────────────────────────
app.get("/storage", async (req, res) => {
  try {
    await withImap(async (client) => {
      try {
        const quota = await client.getQuota("INBOX");
        const storage = quota?.storage;
        if (storage && storage.limit > 0) {
          // ImapFlow already converts IMAP KB units → bytes
          const usedBytes  = storage.usage;
          const limitBytes = storage.limit;
          const percent    = Math.min(100, Math.round((usedBytes / limitBytes) * 100));
          const fmt = (bytes) => {
            const gb = bytes / (1024 ** 3);
            return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
          };
          return res.json({ used: usedBytes, limit: limitBytes, percent, usedFmt: fmt(usedBytes), limitFmt: fmt(limitBytes) });
        }
        res.json({ error: "no_quota" });
      } catch {
        res.json({ error: "quota_not_supported" });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.response || err.message });
  }
});

// console.log(`Your port is ${process.env.PORT}`); // 8626

app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT}`));