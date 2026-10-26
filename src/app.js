import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { status: code });
const validId = value => /^\d+$/.test(String(value)) && Number(value) > 0 && Number(value) <= 2147483647;
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export function createApp(db, { production = process.env.NODE_ENV === 'production', timezone = process.env.CAMPUS_TIMEZONE || 'America/New_York' } = {}) {
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }); // fail fast on invalid configuration
  const app = express();
  if (production) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  const cookie = { httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: 7 * 86400000 };
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', async (_req, res) => { await db.query('SELECT 1'); res.json({ ok: true }); });
  app.get('/api/config', (_req, res) => res.json({ timezone }));
  // Double-submit token with a same-site cookie; all mutations require a custom header.
  app.get('/api/csrf', (req, res) => {
    const token = req.cookies.csrf || randomBytes(32).toString('hex');
    res.cookie('csrf', token, { ...cookie, httpOnly: false }).json({ token });
  });
  app.use('/api', (req, _res, next) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
    const a = Buffer.from(req.cookies.csrf || '');
    const b = Buffer.from(req.get('X-CSRF-Token') || '');
    if (!a.length || a.length !== b.length || !timingSafeEqual(a,b)) return next(fail(403, 'Please refresh the page and try again.'));
    next();
  });
  app.use('/api', async (req, _res, next) => {
    if (req.cookies.session) {
      const { rows } = await db.query('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()', [hash(req.cookies.session)]);
      req.user = rows[0];
    }
    next();
  });
  const auth = (req, _res, next) => next(req.user ? undefined : fail(401, 'Please sign in first.'));
  const admin = (req, _res, next) => next(req.user?.role === 'admin' ? undefined : fail(403, 'Administrator access required.'));
  const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
  async function signIn(req, res, user) {
    const token = randomBytes(32).toString('hex');
    if (req.cookies.session) await db.query('DELETE FROM sessions WHERE token_hash=$1', [hash(req.cookies.session)]);
    await db.query("DELETE FROM sessions WHERE expires_at<now()");
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')", [hash(token), user.id]);
    res.cookie('session', token, cookie).json({ user: publicUser(user) });
  }
  app.post('/api/register', authLimit, async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password;
    if (name.length < 2 || name.length > 80 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) throw fail(400, 'Enter a name, valid email, and a password of 12–72 bytes.');
    try {
      const { rows: [user] } = await db.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING *', [name,email,await bcrypt.hash(password,12)]);
      await signIn(req,res,user);
    } catch (e) { if (e.code === '23505') throw fail(409,'This email is already registered.'); throw e; }
  });
  app.post('/api/login', authLimit, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { rows: [user] } = await db.query('SELECT * FROM users WHERE email=$1',[email]);
    // Dummy hash keeps unknown-email and wrong-password work comparable.
    const encoded = user?.password_hash || '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';
    if (typeof req.body.password !== 'string' || !(await bcrypt.compare(req.body.password,encoded)) || !user) throw fail(401,'Email or password is incorrect.');
    await signIn(req,res,user);
  });
  app.post('/api/logout', async (req,res) => {
    if (req.cookies.session) await db.query('DELETE FROM sessions WHERE token_hash=$1',[hash(req.cookies.session)]);
    res.clearCookie('session', { path:'/', secure:production, sameSite:'lax' }).json({ ok:true });
  });
  app.get('/api/me', (req,res) => res.json({ user:req.user ? publicUser(req.user) : null }));
  app.get('/api/buildings', async (_req,res) => res.json((await db.query('SELECT * FROM buildings ORDER BY id')).rows));
  function interval(date,start,end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !timePattern.test(start || '') || !timePattern.test(end || '') || start >= end) throw fail(400,'Choose a valid date and start/end time.');
    const d = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== date) throw fail(400,'Invalid date.');
    return [`${date} ${start}:00`,`${date} ${end}:00`];
  }
  app.get('/api/rooms', async (req,res) => {
    const values = []; const filters = ['r.active=true'];
    if (req.query.building) { if (!validId(req.query.building)) throw fail(400,'Invalid building.'); values.push(req.query.building); filters.push(`r.building_id=$${values.length}`); }
    if (req.query.capacity) { const n=Number(req.query.capacity); if (!Number.isInteger(n)||n<1||n>100) throw fail(400,'Capacity must be 1–100.'); values.push(n); filters.push(`r.capacity >= $${values.length}`); }
    if (req.query.date || req.query.start || req.query.end) {
      const [start,end] = interval(req.query.date,req.query.start,req.query.end);
      values.push(start,end); const a=values.length-1, b=values.length;
      filters.push(`r.opens <= $${a}::timestamp::time AND r.closes >= $${b}::timestamp::time AND NOT EXISTS (SELECT 1 FROM reservations x WHERE x.room_id=r.id AND x.status='confirmed' AND x.starts_at<$${b}::timestamp AND x.ends_at>$${a}::timestamp)`);
    }
    res.json((await db.query(`SELECT r.*,b.name AS building FROM rooms r JOIN buildings b ON b.id=r.building_id WHERE ${filters.join(' AND ')} ORDER BY r.building_id,r.id`,values)).rows);
  });
  app.get('/api/reservations',auth,async (req,res) => res.json((await db.query("SELECT x.id,x.room_id,to_char(x.starts_at,'YYYY-MM-DD\"T\"HH24:MI') AS starts_at,to_char(x.ends_at,'YYYY-MM-DD\"T\"HH24:MI') AS ends_at,x.purpose,x.status,r.name AS room,b.name AS building FROM reservations x JOIN rooms r ON r.id=x.room_id JOIN buildings b ON b.id=r.building_id WHERE x.user_id=$1 ORDER BY x.starts_at DESC",[req.user.id])).rows));
  app.post('/api/reservations',auth,async (req,res) => {
    const { room_id, date, start, end }=req.body;
    if (!validId(room_id)) throw fail(400,'Choose a room.');
    const [from,to]=interval(date,start,end);
    const purpose=String(req.body.purpose || '').trim();
    if (!purpose || purpose.length>160) throw fail(400,'Enter a purpose, up to 160 characters.');
    if ((new Date(to+'Z')-new Date(from+'Z'))/3600000>4) throw fail(400,'Reservations can last up to four hours.');
    const c=await db.connect();
    try {
      await c.query('BEGIN');
      // Consistent user-then-room locks protect simultaneous bookings, including
      // one student trying two different rooms at the same time.
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
      const { rows:[room] }=await c.query('SELECT * FROM rooms WHERE id=$1 FOR UPDATE',[room_id]);
      if (!room?.active) throw fail(404,'This room is unavailable.');
      const { rows:[clock] }=await c.query("SELECT $1::timestamp > (now() AT TIME ZONE $2) AS future, $1::timestamp <= (now() AT TIME ZONE $2)+interval '30 days' AS in_range",[from,timezone]);
      if (!clock.future || !clock.in_range) throw fail(400,'Choose a future time within the next 30 days.');
      if (start < room.opens.slice(0,5) || end > room.closes.slice(0,5)) throw fail(400,'Choose a time within the room’s opening hours.');
      const overlap=await c.query("SELECT id FROM reservations WHERE status='confirmed' AND (room_id=$1 OR user_id=$2) AND starts_at<$4::timestamp AND ends_at>$3::timestamp",[room_id,req.user.id,from,to]);
      if (overlap.rows.length) throw fail(409,'This time overlaps an existing room reservation or one of your own bookings.');
      const { rows:[booking] }=await c.query('INSERT INTO reservations(user_id,room_id,starts_at,ends_at,purpose) VALUES($1,$2,$3,$4,$5) RETURNING id',[req.user.id,room_id,from,to,purpose]);
      await c.query('COMMIT'); res.status(201).json(booking);
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  });
  app.post('/api/reservations/:id/cancel',auth,async (req,res) => {
    if (!validId(req.params.id)) throw fail(400,'Invalid reservation.');
    const result=await db.query("UPDATE reservations SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='confirmed' AND starts_at>(now() AT TIME ZONE $3) RETURNING id",[req.params.id,req.user.id,timezone]);
    if (!result.rows.length) throw fail(404,'No upcoming reservation found.');
    res.json({ ok:true });
  });
  app.get('/api/admin/rooms',auth,admin,async (_req,res) => res.json((await db.query('SELECT r.*,b.name AS building FROM rooms r JOIN buildings b ON b.id=r.building_id ORDER BY r.id')).rows));
  app.post('/api/admin/rooms',auth,admin,async (req,res) => {
    const { building_id, capacity, opens, closes }=req.body;
    const name=String(req.body.name||'').trim(), amenities=String(req.body.amenities||'').trim();
    if (!validId(building_id)||!name||name.length>80||!Number.isInteger(Number(capacity))||Number(capacity)<1||Number(capacity)>100||!timePattern.test(opens||'')||!timePattern.test(closes||'')||opens>=closes||amenities.length>250) throw fail(400,'Check the room name, building, capacity (1–100), and opening hours.');
    const { rows:[room] }=await db.query('INSERT INTO rooms(building_id,name,capacity,amenities,opens,closes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[building_id,name,capacity,amenities,opens,closes]);
    res.status(201).json(room);
  });
  app.patch('/api/admin/rooms/:id',auth,admin,async (req,res) => {
    const { opens,closes,active }=req.body;
    if (!validId(req.params.id)||!timePattern.test(opens||'')||!timePattern.test(closes||'')||opens>=closes||typeof active!=='boolean') throw fail(400,'Invalid opening hours or room state.');
    const c=await db.connect();
    try {
      await c.query('BEGIN');
      const { rows:[r] }=await c.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE',[req.params.id]);
      if (!r) throw fail(404,'Room not found.');
      const conflicts=await c.query("SELECT id FROM reservations WHERE room_id=$1 AND status='confirmed' AND ends_at>(now() AT TIME ZONE $4) AND ($5=false OR starts_at::time<$2::time OR ends_at::time>$3::time)",[r.id,opens,closes,timezone,active]);
      if (conflicts.rows.length) throw fail(409,'Existing bookings would be affected. Keep the room available until they finish.');
      await c.query('UPDATE rooms SET opens=$1,closes=$2,active=$3 WHERE id=$4',[opens,closes,active,r.id]);
      await c.query('COMMIT'); res.json({ok:true});
    } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
  });
  app.get('/api/admin/report',auth,admin,async (_req,res) => {
    const { rows }=await db.query("SELECT r.id,r.name,b.name AS building,COUNT(x.id)::integer AS bookings,COALESCE(SUM(EXTRACT(EPOCH FROM (x.ends_at-x.starts_at))/3600),0)::numeric(10,1) AS hours FROM rooms r JOIN buildings b ON b.id=r.building_id LEFT JOIN reservations x ON x.room_id=r.id AND x.status='confirmed' AND x.starts_at >= (now() AT TIME ZONE $1)-interval '30 days' AND x.starts_at <= (now() AT TIME ZONE $1) GROUP BY r.id,r.name,b.name ORDER BY bookings DESC,r.id",[timezone]);
    res.json(rows);
  });
  app.use('/api',(_req,_res,next)=>next(fail(404,'API route not found.')));
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)),'../public')));
  app.use((err,_req,res,_next)=>{
    const status=err.status || (['23503','23505','22007','22008'].includes(err.code)?400:500);
    if (status>=500) console.error('Request failed:',err.code||err.name);
    res.status(status).json({error:status>=500?'Something went wrong. Please try again.':(err.code?'Invalid or duplicate record.':err.message)});
  });
  return app;
}
