-- Fail-closed runtime marker. The destructive schema contract is executed only
-- by the explicit contract orchestrator after verified backup and copy checks.
-- contract-sql-sha256: 7b99f5742b52b7c6b1bd7d20ee13676d8687c8a9b5c5cc3a46960de1606b6fe2
-- contract-schema-sha256: fd1d478cb081967596bebc0b25fa43f2e07551d2f1d0469ff427b8e89dede3a8
SELECT arcade_library_contract_requires_explicit_orchestrator();
