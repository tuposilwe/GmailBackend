-- Recreate user_settings with proper columns
DROP TABLE IF EXISTS `user_settings`;
CREATE TABLE `user_settings` (
    `user_email`   VARCHAR(191) NOT NULL,
    `reading_pane` BOOLEAN      NOT NULL DEFAULT false,

    PRIMARY KEY (`user_email`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
