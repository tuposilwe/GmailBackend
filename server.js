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

app.get("/emails", async (req, res) => {
  const client = new ImapFlow({
    host: process.env.IMAP_SERVER,
    port: process.env.IMAP_PORT,
    secure: true,
    auth: {
      user: process.env.IMAP_USERNAME,
      pass: process.env.IMAP_PASSWORD
    }
  });

  await client.connect();

  let emails = [];
  let lock = await client.getMailboxLock("INBOX");

  try {
    for await (let msg of client.fetch("1:*", { envelope: true })) {
      emails.push({
        subject: msg.envelope.subject,
        from: msg.envelope.from[0].address
      });
    }
  } finally {
    lock.release();
  }

  await client.logout();
  res.json(emails);
});


// console.log(`Your port is ${process.env.PORT}`); // 8626

app.listen(process.env.PORT || 3000, () => console.log(`Server running on port ${process.env.PORT}`));