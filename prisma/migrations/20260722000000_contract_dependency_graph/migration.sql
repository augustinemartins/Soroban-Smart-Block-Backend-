-- Migration: contract_dependency_graph
-- Adds the ContractDependency table required by the supply-chain
-- vulnerability-propagation graph (issue #300).

CREATE TABLE "ContractDependency" (
    "id"            TEXT         NOT NULL,
    "sourceAddress" VARCHAR(56)  NOT NULL,
    "targetAddress" VARCHAR(56)  NOT NULL,
    "isActive"      BOOLEAN      NOT NULL DEFAULT true,
    "metadata"      JSONB,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractDependency_pkey" PRIMARY KEY ("id")
);

-- Unique edge (source → target)
CREATE UNIQUE INDEX "ContractDependency_sourceAddress_targetAddress_key"
    ON "ContractDependency"("sourceAddress", "targetAddress");

-- Index for downstream BFS: WHERE sourceAddress IN (frontier) AND isActive = true
CREATE INDEX "ContractDependency_sourceAddress_isActive_idx"
    ON "ContractDependency"("sourceAddress", "isActive");

-- Index for upstream BFS: WHERE targetAddress IN (frontier) AND isActive = true
CREATE INDEX "ContractDependency_targetAddress_isActive_idx"
    ON "ContractDependency"("targetAddress", "isActive");
