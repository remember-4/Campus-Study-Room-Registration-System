-- Campus-local timestamps are intentional; the entire campus uses one timezone.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(254) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS buildings (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings(id),
  name VARCHAR(80) NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  amenities VARCHAR(250) NOT NULL DEFAULT '',
  opens TIME NOT NULL DEFAULT '08:00',
  closes TIME NOT NULL DEFAULT '22:00',
  active BOOLEAN NOT NULL DEFAULT true,
  CHECK (opens < closes),
  UNIQUE(building_id, name)
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  starts_at TIMESTAMP NOT NULL,
  ends_at TIMESTAMP NOT NULL,
  purpose VARCHAR(160) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS reservations_room_time ON reservations(room_id, starts_at, ends_at) WHERE status='confirmed';
CREATE INDEX IF NOT EXISTS reservations_user ON reservations(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
