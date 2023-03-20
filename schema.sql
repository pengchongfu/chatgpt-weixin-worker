DROP TABLE IF EXISTS Messages;
CREATE TABLE Messages (id INTEGER PRIMARY KEY AUTOINCREMENT, openId TEXT, content TEXT, role TEXT CHECK( role IN ('user','assistant') ), createdAt INTEGER);
CREATE INDEX idx_messages_openId ON Messages (openId);

DROP TABLE IF EXISTS UserSettings;
CREATE TABLE UserSettings (id INTEGER PRIMARY KEY AUTOINCREMENT, openId TEXT UNIQUE, initMessageRole TEXT CHECK( initMessageRole IN ('system', 'user') ), initMessageContent TEXT, createdAt INTEGER);
CREATE INDEX idx_user_settings_openId ON UserSettings (openId);