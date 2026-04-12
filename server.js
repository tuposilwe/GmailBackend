var express = require("express");
var cors = require("cors");
var nodemailer = require("nodemailer");
var { ImapFlow } = require("imapflow");
var { simpleParser } = require("mailparser");
require('dotenv').config();

// ── In-memory logo cache (domain:source → {buffer, contentType, ts}) ─────────
const logoCache = new Map();
const LOGO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 h

function makeImapClient() {
  return new ImapFlow({
    host: process.env.IMAP_SERVER,
    port: process.env.IMAP_PORT,
    secure: true,
    auth: {
      user: process.env.IMAP_USERNAME,
      pass: process.env.IMAP_PASSWORD
    },
    logger: false
  });
}

const app = express();
app.use(cors());
app.use(express.json());

// ── GET /logo?domain=example.com&source=clearbit|favicon ─────────────────────
app.get("/logo", async (req, res) => {
  const domain = (req.query.domain || "").toLowerCase().trim();
  const source = req.query.source || "auto"; // clearbit | favicon | auto

  if (!domain) return res.status(400).end();

  const cacheKey = `${source}:${domain}`;
  const cached   = logoCache.get(cacheKey);

  if (cached && Date.now() - cached.ts < LOGO_CACHE_TTL) {
    if (cached.notFound) return res.status(404).end();
    res.setHeader("Content-Type",  cached.contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.end(cached.buffer);
  }

  // Four sources tried in order — most to least logo-quality
  const urls =
    source === "clearbit" ? [`https://logo.clearbit.com/${domain}`]
    : source === "favicon" ? [
        `https://icons.duckduckgo.com/ip3/${domain}.ico`,
        `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
        `https://${domain}/favicon.ico`,
      ]
    : [
        `https://logo.clearbit.com/${domain}`,
        `https://icons.duckduckgo.com/ip3/${domain}.ico`,
        `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
        `https://${domain}/favicon.ico`,
      ];

  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;

      const contentType = r.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) continue;

      const buffer = Buffer.from(await r.arrayBuffer());
      if (buffer.length < 100) continue;          // skip 1×1 placeholder images

      logoCache.set(cacheKey, { buffer, contentType, ts: Date.now() });
      res.setHeader("Content-Type",  contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.end(buffer);
    } catch (_) {
      // try next source
    }
  }

  logoCache.set(cacheKey, { notFound: true, ts: Date.now() });
  res.status(404).end();
});

app.post("/send-email", async (req, res) => {
  const { to, subject, text } = req.body;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_SERVER,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
      user: process.env.SMTP_USERNAME,
      pass: process.env.SMTP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: "your@email.com",
    to,
    subject,
    text
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

  const client = makeImapClient();

  await client.connect();

  let emails = [];
  let total = 0;
  let lock = await client.getMailboxLock("INBOX");

  try {

    let mailbox = await client.mailboxOpen("INBOX");
    total = mailbox.exists;

    // Calculate start & end
    let end = total - (page - 1) * pagesize;
    let start = Math.max(1, end - pagesize + 1);

    let range = `${start}:${end}`;

    console.log("Page:", page);
    console.log("Range:", range);

    // await client.messageFlagsAdd(uid, ["\\Flagged"]);
    // await client.messageFlagsRemove(uid, ["\\Flagged"]);

    // List mailboxes
        // let mailboxes = await client.list();
        // console.log('Available mailboxes:');
        // for (let mailbox of mailboxes) {
        //     console.log(`  ${mailbox.path} ${mailbox.specialUse || ''}`);
        // }

    for await (let msg of client.fetch(range, {
      envelope: true,
      bodyStructure: true,
      reverse: true,
      flags: true,
      headers: ["authentication-results"],
    })) {
      const subject = msg.envelope.subject || "(No Subject)";
      const fromObj = msg.envelope.from?.[0];
      const senderEmail = fromObj?.address || "unknown@unknown.com";
      const senderName = fromObj?.name || senderEmail.split("@")[0];
      const isStarred = msg.flags?.has("\\Flagged");
      const date = new Date(msg.envelope.date);
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      const timeStr = isToday
        ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleDateString([], { month: "short", day: "numeric" });

      // Parse Authentication-Results for DKIM / DMARC pass
      const authRaw = msg.headers ? msg.headers.toString().replace(/\r?\n[ \t]+/g, " ") : "";
      const verified = /dkim=pass/i.test(authRaw) || /dmarc=pass/i.test(authRaw);

      emails.push({
        id: msg.uid,
        unread: !msg.flags.has('\\Seen'),
        starred: isStarred,
        senderName,
        senderEmail,
        sender: senderName,
        avatar: senderName.substring(0, 2).toUpperCase(),
        avatarColor: "#1a73e8",
        subject,
        preview: subject.substring(0, 80),
        time: timeStr,
        date: date.toISOString(),
        label: "inbox",
        verified,
        attachments: collectAttachments(msg.bodyStructure),
        hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
      });
    }
  } finally {
    lock.release();
  }

  await client.logout();
  res.json({ emails: emails.reverse(), total });
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
  const client = makeImapClient();
  await client.connect();
  let lock = await client.getMailboxLock("INBOX");
  let emails = [];

  try {
    const uids = await client.search({ flagged: true }, { uid: true });

    if (uids.length > 0) {
      const uidRange = uids.join(",");
      for await (let msg of client.fetch(uidRange, {
        envelope: true,
        bodyStructure: true,
        flags: true,
      }, { uid: true })) {
        const fromObj = msg.envelope.from?.[0];
        const senderEmail = fromObj?.address || "unknown@unknown.com";
        const senderName = fromObj?.name || senderEmail.split("@")[0];
        const date = new Date(msg.envelope.date);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        const timeStr = isToday
          ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : date.toLocaleDateString([], { month: "short", day: "numeric" });

        emails.push({
          id: msg.uid,
          unread: !msg.flags.has("\\Seen"),
          starred: true,
          senderName,
          senderEmail,
          sender: senderName,
          avatar: senderName.substring(0, 2).toUpperCase(),
          avatarColor: "#1a73e8",
          subject: msg.envelope.subject || "(No Subject)",
          preview: (msg.envelope.subject || "").substring(0, 80),
          time: timeStr,
          date: date.toISOString(),
          label: "inbox",
          attachments: collectAttachments(msg.bodyStructure),
          hasAttachment: collectAttachments(msg.bodyStructure).length > 0,
        });
      }
    }
  } finally {
    lock.release();
  }

  await client.logout();
  res.json(emails.reverse());
});

app.get("/emails/:id", async (req, res) => {
  const uid = parseInt(req.params.id);
  const client = makeImapClient();

  await client.connect();
  let lock = await client.getMailboxLock("INBOX");

  try {
    const download = await client.download(`${uid}`, undefined, { uid: true });
    if (!download) return res.status(404).json({ error: "Message not found" });

    const parsed = await simpleParser(download.content);

    const fromObj = parsed.from?.value?.[0];
    const toObj = parsed.to?.value?.[0];

    const attachments = (parsed.attachments || []).map((att, i) => ({
      index: i,
      filename: att.filename || `attachment-${i + 1}`,
      contentType: att.contentType || "application/octet-stream",
      size: att.size || att.content?.length || 0,
    }));

    res.json({
      id: uid,
      subject: parsed.subject || "(No Subject)",
      senderName: fromObj?.name || fromObj?.address?.split("@")[0] || "Unknown",
      senderEmail: fromObj?.address || "",
      toName: toObj?.name || toObj?.address?.split("@")[0] || "",
      toEmail: toObj?.address || "",
      date: parsed.date?.toISOString() || null,
      text: parsed.text || "",
      html: parsed.html || "",
      attachments,
    });
  } finally {
    lock.release();
  }

  await client.logout();
});

app.get("/emails/:id/attachments/:index", async (req, res) => {
  const uid = parseInt(req.params.id);
  const index = parseInt(req.params.index);
  const client = makeImapClient();

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  try {
    const download = await client.download(`${uid}`, undefined, { uid: true });
    if (!download) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const parsed = await simpleParser(download.content);
    const att = (parsed.attachments || [])[index];
    if (!att) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const filename = encodeURIComponent(att.filename || `attachment-${index + 1}`);
    res.setHeader("Content-Type", att.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", att.content.length);
    res.end(att.content);
  } finally {
    lock.release();
    client.logout().catch(() => {});
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

// ── Helper: run an IMAP action on INBOX then logout ──────────────────────────
async function inboxAction(res, fn) {
  const client = makeImapClient();
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    await fn(client);
    res.json({ success: true });
  } finally {
    lock.release();
    client.logout().catch(() => {});
  }
}

// ── POST /emails/:id/unsubscribe ─────────────────────────────────────────────
app.post("/emails/:id/unsubscribe", async (req, res) => {
  const uid = parseInt(req.params.id);
  const client = makeImapClient();
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  try {
    // Fetch only the relevant headers — much faster than downloading the full body
    let headerBuffer;
    for await (const msg of client.fetch(`${uid}`, { headers: ["list-unsubscribe", "list-unsubscribe-post"] }, { uid: true })) {
      headerBuffer = msg.headers;
    }

    const headerText = headerBuffer ? headerBuffer.toString() : "";
    // Unfold multi-line header values
    const unfolded = headerText.replace(/\r?\n[ \t]/g, " ");

    const luMatch  = unfolded.match(/^list-unsubscribe:\s*(.*)/im);
    const lupMatch = unfolded.match(/^list-unsubscribe-post:\s*(.*)/im);
    const listUnsubscribe     = luMatch  ? luMatch[1].trim()  : "";
    const listUnsubscribePost = lupMatch ? lupMatch[1].trim() : "";

    if (!listUnsubscribe) {
      return res.status(400).json({ error: "No List-Unsubscribe header found" });
    }

    // Extract <url> tokens from the header value
    const urls = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map(m => m[1]);
    const httpsUrl  = urls.find(u => /^https?:\/\//i.test(u));
    const mailtoUrl = urls.find(u => /^mailto:/i.test(u));

    let method = "none";

    if (httpsUrl && listUnsubscribePost) {
      // RFC 8058 one-click unsubscribe
      await fetch(httpsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      method = "http-post";
    } else if (mailtoUrl) {
      // Send an unsubscribe email
      const url     = new URL(mailtoUrl);
      const to      = url.pathname;
      const subject = url.searchParams.get("subject") || "Unsubscribe";

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_SERVER,
        port: process.env.SMTP_PORT,
        secure: true,
        auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD },
      });

      await transporter.sendMail({
        from: process.env.SMTP_USERNAME,
        to,
        subject,
        text: "",
      });
      method = "mailto";
    } else if (httpsUrl) {
      // Fallback: plain GET to the unsubscribe URL
      await fetch(httpsUrl);
      method = "http-get";
    }

    // Always move to Spam, just like Gmail does
    const spamFolder = await findMailbox(client, "\\Junk", ["Spam", "[Gmail]/Spam", "Junk", "Junk Email"]);
    if (spamFolder) {
      await client.messageMove(`${uid}`, spamFolder, { uid: true });
    }

    res.json({ success: true, method });
  } catch (err) {
    console.error("Unsubscribe error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    lock.release();
    client.logout().catch(() => {});
  }
});

// ── GET /mailboxes — list all folders ────────────────────────────────────────
app.get("/mailboxes", async (req, res) => {
  const client = makeImapClient();
  await client.connect();
  try {
    const list = await client.list();
    res.json(list.map(m => ({ path: m.path, name: m.name, specialUse: m.specialUse || null })));
  } finally {
    client.logout().catch(() => {});
  }
});

// ── POST /emails/:id/archive ─────────────────────────────────────────────────
app.post("/emails/:id/archive", async (req, res) => {
  const uid = parseInt(req.params.id);
  await inboxAction(res, async (client) => {
    const dest = await findMailbox(client, "\\Archive", ["Archive", "[Gmail]/All Mail", "All Mail"]);
    if (dest) {
      await client.messageMove(`${uid}`, dest, { uid: true });
    } else {
      // No archive folder — just remove \Inbox flag (IMAP MOVE not available)
      await client.messageFlagsAdd(`${uid}`, ["\\Deleted"], { uid: true });
      await client.messageExpunge();
    }
  });
});

// ── POST /emails/:id/spam ────────────────────────────────────────────────────
app.post("/emails/:id/spam", async (req, res) => {
  const uid = parseInt(req.params.id);
  await inboxAction(res, async (client) => {
    const dest = await findMailbox(client, "\\Junk", ["Spam", "[Gmail]/Spam", "Junk", "Junk Email"]);
    if (dest) await client.messageMove(`${uid}`, dest, { uid: true });
  });
});

// ── POST /emails/:id/trash ───────────────────────────────────────────────────
app.post("/emails/:id/trash", async (req, res) => {
  const uid = parseInt(req.params.id);
  await inboxAction(res, async (client) => {
    const dest = await findMailbox(client, "\\Trash", ["Trash", "[Gmail]/Trash", "Deleted Items"]);
    if (dest) {
      await client.messageMove(`${uid}`, dest, { uid: true });
    } else {
      await client.messageFlagsAdd(`${uid}`, ["\\Deleted"], { uid: true });
      await client.messageExpunge();
    }
  });
});

// ── POST /emails/:id/mark-unread ─────────────────────────────────────────────
app.post("/emails/:id/mark-unread", async (req, res) => {
  const uid = parseInt(req.params.id);
  await inboxAction(res, async (client) => {
    await client.messageFlagsRemove(`${uid}`, ["\\Seen"], { uid: true });
  });
});

// ── POST /emails/:id/mark-read ───────────────────────────────────────────────
app.post("/emails/:id/mark-read", async (req, res) => {
  const uid = parseInt(req.params.id);
  await inboxAction(res, async (client) => {
    await client.messageFlagsAdd(`${uid}`, ["\\Seen"], { uid: true });
  });
});

// ── POST /emails/:id/star ────────────────────────────────────────────────────
app.post("/emails/:id/star", async (req, res) => {
  const uid = parseInt(req.params.id);
  await inboxAction(res, async (client) => {
    await client.messageFlagsAdd(`${uid}`, ["\\Flagged"], { uid: true });
  });
});

// ── POST /emails/:id/move ────────────────────────────────────────────────────
app.post("/emails/:id/move", async (req, res) => {
  const uid = parseInt(req.params.id);
  const { mailbox } = req.body;
  if (!mailbox) return res.status(400).json({ error: "mailbox required" });
  await inboxAction(res, async (client) => {
    await client.messageMove(`${uid}`, mailbox, { uid: true });
  });
});

// console.log(`Your port is ${process.env.PORT}`); // 8626

app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT}`));