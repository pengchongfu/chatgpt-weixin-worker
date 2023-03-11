DROP TABLE IF EXISTS Messages;
CREATE TABLE Messages (id INTEGER PRIMARY KEY AUTOINCREMENT, openId TEXT, content TEXT, role TEXT CHECK( role IN ('user','assistant') ), createdAt INTEGER);
CREATE INDEX idx_openId ON Messages (openId);