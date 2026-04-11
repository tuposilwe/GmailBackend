var express = require("express");
var cors = require("cors");
var nodemailer = require("nodemailer");
var { ImapFlow } = require("imapflow");
var { simpleParser } = require("mailparser");
require('dotenv').config();

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

function hasAttachments(structure) {
  if (!structure) return false;

  // If this part is an attachment
  if (structure.disposition === "attachment") {
    return true;
  }

  // Check children recursively
  if (structure.childNodes && structure.childNodes.length) {
    return structure.childNodes.some(child => hasAttachments(child));
  }

  return false;
}

app.get("/emails", async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pagesize = parseInt(req.query.limit) || 50;

  const client = makeImapClient();

  await client.connect();

  let emails = [];
  let lock = await client.getMailboxLock("INBOX");

//   let message = await client.fetchOne('*', { flags: true });

// console.log('Flags:', message.flags);
// console.log('Is seen?', message.flags.has('\\Seen'));
// console.log('Is flagged?', message.flags.has('\\Flagged'));
// console.log('Flag color:', message.flagColor); // e.g., 'red', 'yellow'

  try {

    let mailbox = await client.mailboxOpen("INBOX");
    let total = mailbox.exists;

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
      flags: true
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
        hasAttachment: hasAttachments(msg.bodyStructure),
      });
    }
  } finally {
    lock.release();
  }

  await client.logout();
  res.json(emails.reverse());
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
          hasAttachment: hasAttachments(msg.bodyStructure),
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
    });
  } finally {
    lock.release();
  }

  await client.logout();
});

// console.log(`Your port is ${process.env.PORT}`); // 8626

app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT}`));