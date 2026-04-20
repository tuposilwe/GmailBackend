CREATE TABLE `login_audits` (
    `id`          INT          NOT NULL AUTO_INCREMENT,
    `email`       VARCHAR(191) NOT NULL DEFAULT '',
    `ip`          VARCHAR(191) NOT NULL DEFAULT '',
    `user_agent`  TEXT         NOT NULL DEFAULT '',
    `domain`      VARCHAR(191) NOT NULL DEFAULT '',
    `imap_server` VARCHAR(191) NOT NULL DEFAULT '',
    `success`     BOOLEAN      NOT NULL,
    `blocked`     BOOLEAN      NOT NULL DEFAULT false,
    `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `login_audits_ip_idx`(`ip`),
    INDEX `login_audits_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
