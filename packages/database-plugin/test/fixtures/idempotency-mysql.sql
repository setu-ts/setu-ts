CREATE TABLE `setu_idempotency` (
  `id` VARCHAR(191) PRIMARY KEY,
  `kind` VARCHAR(191) NOT NULL,
  `role` VARCHAR(191) NOT NULL,
  `fingerprint` VARCHAR(191) NOT NULL,
  `created_at` BIGINT NOT NULL,
  `expires_at` BIGINT NOT NULL,
  `result` LONGTEXT
);
