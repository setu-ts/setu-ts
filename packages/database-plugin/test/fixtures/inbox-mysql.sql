CREATE TABLE `setu_inbox` (
  `id` VARCHAR(191) PRIMARY KEY,
  `kind` VARCHAR(191) NOT NULL,
  `consumer` VARCHAR(191) NOT NULL,
  `topic` VARCHAR(191) NOT NULL,
  `envelope_id` VARCHAR(191),
  `status` VARCHAR(191) NOT NULL,
  `attempts` INT NOT NULL,
  `updated_at` BIGINT NOT NULL,
  `last_error` LONGTEXT,
  `envelope` LONGTEXT
);
