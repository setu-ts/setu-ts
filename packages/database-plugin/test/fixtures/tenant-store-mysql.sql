CREATE TABLE `rows` (
  `id` VARCHAR(191) PRIMARY KEY,
  `name` VARCHAR(191),
  `tenant_id` VARCHAR(191),
  `version` INT NOT NULL,
  `balance` INT NOT NULL,
  `profile` JSON
);
