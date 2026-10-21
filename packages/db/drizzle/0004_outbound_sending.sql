-- Allow atomic queued -> sending claim for idempotent send retries
-- (no CHECK constraint in prior migrations; values are app-enforced)
SELECT 1;
