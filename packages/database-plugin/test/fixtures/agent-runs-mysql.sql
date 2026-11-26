CREATE TABLE `agent_run` (
  `id` VARCHAR(191) PRIMARY KEY,
  `tenantId` VARCHAR(191),
  `principalId` VARCHAR(191),
  `definition` VARCHAR(191),
  `version` VARCHAR(191),
  `status` VARCHAR(191),
  `input` JSON,
  `leaseOwner` VARCHAR(191),
  `leaseVersion` BIGINT,
  `leaseUntil` BIGINT,
  `entryCount` INT,
  `approvalIds` JSON,
  `chunkCount` INT,
  `stepChunkStart` INT,
  `toolTimeoutKey` VARCHAR(191),
  `toolTimeouts` INT,
  `cancelRequested` BOOLEAN,
  `error` LONGTEXT,
  `createdAt` BIGINT,
  `updatedAt` BIGINT
);

CREATE TABLE `agent_entry` (
  `id` VARCHAR(191) PRIMARY KEY,
  `runId` VARCHAR(191),
  `tenantId` VARCHAR(191),
  `seq` INT,
  `kind` VARCHAR(191),
  `messages` JSON,
  `finishReason` VARCHAR(191),
  `usage` JSON,
  `toolCallId` VARCHAR(191),
  `stepChunkStart` INT,
  `leaseVersion` BIGINT
);

CREATE TABLE `agent_chunks` (
  `id` VARCHAR(191) PRIMARY KEY,
  `runId` VARCHAR(191),
  `tenantId` VARCHAR(191),
  `seq` INT,
  `chunks` JSON,
  `leaseVersion` BIGINT
);

CREATE TABLE `agent_approval` (
  `id` VARCHAR(191) PRIMARY KEY,
  `runId` VARCHAR(191),
  `tenantId` VARCHAR(191),
  `seq` INT,
  `toolCallId` VARCHAR(191),
  `toolName` VARCHAR(191),
  `input` JSON,
  `status` VARCHAR(191),
  `deadline` BIGINT,
  `decidedBy` VARCHAR(191),
  `decidedAt` BIGINT,
  `reason` LONGTEXT,
  `leaseVersion` BIGINT
);
