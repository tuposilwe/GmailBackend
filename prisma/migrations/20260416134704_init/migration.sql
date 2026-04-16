-- CreateTable
CREATE TABLE "sent_contacts" (
    "email" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sent_count" INTEGER NOT NULL DEFAULT 1,
    "last_sent" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "snoozed" (
    "uid" INTEGER NOT NULL,
    "folder" TEXT NOT NULL DEFAULT 'inbox',
    "snooze_until" DATETIME NOT NULL,

    PRIMARY KEY ("uid", "folder")
);

-- CreateTable
CREATE TABLE "recent_searches" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "query" TEXT NOT NULL,
    "searched_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "signatures" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_email" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT 'Default',
    "html" TEXT NOT NULL DEFAULT '',
    "is_default" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "sessions" (
    "token" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "imap_user" TEXT NOT NULL DEFAULT '',
    "imap_pass" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL,
    "expires_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT
);

-- CreateIndex
CREATE UNIQUE INDEX "recent_searches_query_key" ON "recent_searches"("query");
