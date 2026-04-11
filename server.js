var express = require("express");
var nodemailer = require("nodemailer");
var { ImapFlow } = require("imapflow");
require('dotenv').config();

const app = express();
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

  const client = new ImapFlow({
    host: process.env.IMAP_SERVER,
    port: process.env.IMAP_PORT,
    secure: true,
    auth: {
      user: process.env.IMAP_USERNAME,
      pass: process.env.IMAP_PASSWORD
    },
    logger: false
  });

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
      const from = msg.envelope.from?.[0]?.address || "Unknown";
      const isStarred = msg.flags?.has("\\Flagged");

      emails.push({
        id: msg.uid,
        unread: !msg.flags.has('\\Seen'),
        starred: isStarred,
        sender: from.split("@")[0], // simple name
        avatar: from.substring(0, 2).toUpperCase(),
        avatarColor: "#1a73e8", // random or generated later
        subject: subject,
        preview: subject.substring(0, 60), // simple preview
        time: new Date(msg.envelope.date).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        }),
        label: "inbox",
        hasAttachment: hasAttachments(msg.bodyStructure),
        body: subject // later you can fetch real body
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


// console.log(`Your port is ${process.env.PORT}`); // 8626

app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT}`));