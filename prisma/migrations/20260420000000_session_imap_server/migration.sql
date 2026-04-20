-- AlterTable
ALTER TABLE `sessions` ADD COLUMN `imap_server` VARCHAR(191) NOT NULL DEFAULT '',
                       ADD COLUMN `imap_port`   INT          NOT NULL DEFAULT 993;
