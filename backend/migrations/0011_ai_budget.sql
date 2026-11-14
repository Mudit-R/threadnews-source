CREATE TABLE ai_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  day TEXT NOT NULL,
  used INTEGER NOT NULL CHECK (used > 0)
);
