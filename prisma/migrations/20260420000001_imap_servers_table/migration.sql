-- CreateTable
CREATE TABLE `imap_servers` (
    `id`         INT          NOT NULL AUTO_INCREMENT,
    `label`      VARCHAR(191) NOT NULL,
    `host`       VARCHAR(191) NOT NULL,
    `port`       INT          NOT NULL DEFAULT 993,
    `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
