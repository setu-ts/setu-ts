CREATE TABLE `grants` (
  `id` VARCHAR(191) PRIMARY KEY,
  `subject` VARCHAR(191) NOT NULL,
  `role` VARCHAR(191) NOT NULL,
  `scopeType` VARCHAR(191),
  `scopeId` VARCHAR(191)
);

CREATE TABLE `roles` (
  `id` VARCHAR(191) PRIMARY KEY,
  `scopeType` VARCHAR(191),
  `scopeId` VARCHAR(191),
  `role` VARCHAR(191) NOT NULL,
  `permission` VARCHAR(191) NOT NULL
);
