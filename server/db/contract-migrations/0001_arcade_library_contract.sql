-- Task 1 intentionally ships no destructive contract migration.
-- The explicit Task 3 runner must replace this fail-closed guard only after
-- backup verification, legacy backfill, and child-row preservation tests exist.
SELECT arcade_library_contract_requires_task_3();
