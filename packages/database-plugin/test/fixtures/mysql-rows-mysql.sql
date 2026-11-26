CREATE TABLE `compound_rows` (
  `tenantId` VARCHAR(191) NOT NULL,
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191),
  `version` INT NOT NULL,
  `balance` INT NOT NULL,
  PRIMARY KEY (tenantId, id)
);

CREATE TABLE `business` (
  `id` VARCHAR(191) PRIMARY KEY,
  `name` VARCHAR(191)
);
