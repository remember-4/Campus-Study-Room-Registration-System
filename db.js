import pg from 'pg';
import fs from 'node:fs/promises';
import bcrypt from 'bcryptjs';

export async function initialize(db, env = process.env) {
  // Serialize bootstrapping across overlapping deploys. Never reset existing data.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(3740)');
    await client.query(await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const buildings = [
      ['Main Library', 'Quiet spaces for focused work'],
      ['Science Center', 'Collaborative spaces for big ideas'],
      ['Student Commons', 'Meet, study, and make progress']
    ];
    for (const [name, description] of buildings) {
      const { rows: [b] } = await client.query('INSERT INTO buildings(name,description) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [name, description]);
      for (const [suffix, capacity, amenities] of [['101', 4, 'Whiteboard, Power outlets'], ['202', 8, 'Display, Whiteboard, Power outlets']]) {
        await client.query('INSERT INTO rooms(building_id,name,capacity,amenities) VALUES($1,$2,$3,$4) ON CONFLICT(building_id,name) DO NOTHING', [b.id, `Study ${suffix}`, capacity, amenities]);
      }
    }
    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      if (env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
      await client.query("INSERT INTO users(name,email,password_hash,role) VALUES('Campus Administrator',$1,$2,'admin') ON CONFLICT(email) DO NOTHING", [env.ADMIN_EMAIL.trim().toLowerCase(), await bcrypt.hash(env.ADMIN_PASSWORD, 12)]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

export function database() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to your PostgreSQL connection URL');
  // Render internal connections need no SSL override. External providers should
  // specify sslmode=require in DATABASE_URL; certificate verification stays enabled.
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
}
