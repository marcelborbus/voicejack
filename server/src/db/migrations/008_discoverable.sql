-- v1.2 #44: friend search. Registered users can opt out of being found by name (default on).
ALTER TABLE users ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 1 CHECK (discoverable IN (0, 1));
