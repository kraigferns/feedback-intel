DROP TABLE IF EXISTS feedback;

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT,
  author TEXT,
  customer_tier TEXT DEFAULT 'free',
  created_at TEXT NOT NULL,
  
  sentiment TEXT,
  sentiment_score REAL,
  urgency TEXT,
  themes TEXT,
  summary TEXT,
  processed_at TEXT
);

CREATE INDEX idx_source ON feedback(source);
CREATE INDEX idx_urgency ON feedback(urgency);
CREATE INDEX idx_sentiment ON feedback(sentiment);
CREATE INDEX idx_created ON feedback(created_at);
CREATE UNIQUE INDEX idx_content_hash ON feedback(content_hash);
