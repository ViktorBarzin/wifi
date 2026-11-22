-- The one sync_state row the app reads and updates.
INSERT INTO "sync_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
