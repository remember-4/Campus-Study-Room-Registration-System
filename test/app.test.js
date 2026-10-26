import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { initialize } from '../db.js';
import { createApp } from '../src/app.js';

const engine = new PGlite();
// One embedded PostgreSQL connection. Serialize client leases so transaction
// boundaries match a pool. Real multi-connection locking needs hosted PG QA.
let tail=Promise.resolve();
const db={
  query:(sql,args)=>engine.query(sql,args),
  async connect(){const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return{query:(sql,args)=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):(!args&&sql.includes('CREATE TABLE')?engine.exec(sql):engine.query(sql,args)),release};}
};
let app,student,other,admin,token,otherToken,adminToken;
const date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
const payload={room_id:1,date,start:'10:00',end:'11:00',purpose:'Database project'};
before(async()=>{
  await initialize(db,{ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD:'correct-admin-password'});
  app=createApp(db,{production:false,timezone:'UTC'});
  student=request.agent(app);other=request.agent(app);admin=request.agent(app);
  token=(await student.get('/api/csrf')).body.token;
  otherToken=(await other.get('/api/csrf')).body.token;
  adminToken=(await admin.get('/api/csrf')).body.token;
});
after(async()=>{await engine.close();});
test('complete reservation workflow, access control, validation and persistence',async()=>{
  let r=await student.get('/api/rooms');assert.equal(r.status,200);assert.equal(r.body.length,6);
  r=await student.post('/api/register').set('X-CSRF-Token',token).send({name:'Student One',email:'one@example.com',password:'student-password-123'});assert.equal(r.status,200);assert.equal(r.body.user.role,'student');
  r=await other.post('/api/register').set('X-CSRF-Token',otherToken).send({name:'Student Two',email:'two@example.com',password:'student-password-456'});assert.equal(r.status,200);
  r=await student.post('/api/reservations').send(payload);assert.equal(r.status,403);
  r=await student.post('/api/reservations').set('X-CSRF-Token',token).send(payload);assert.equal(r.status,201);const booking=r.body.id;
  r=await other.post('/api/reservations').set('X-CSRF-Token',otherToken).send(payload);assert.equal(r.status,409);
  r=await student.post('/api/reservations').set('X-CSRF-Token',token).send({...payload,room_id:2});assert.equal(r.status,409);
  r=await other.post(`/api/reservations/${booking}/cancel`).set('X-CSRF-Token',otherToken);assert.equal(r.status,404);
  r=await student.get(`/api/rooms?date=${date}&start=10:00&end=11:00`);assert.equal(r.status,200);assert.equal(r.body.length,5);
  r=await other.post('/api/reservations').set('X-CSRF-Token',otherToken).send({...payload,start:'11:00',end:'12:00'});assert.equal(r.status,201);
  for(const changes of [{date:'2026-02-30'},{date:'2020-01-01'},{start:'07:00',end:'08:00'},{start:'12:00',end:'17:00'},{end:'09:00'},{purpose:''}]){
    r=await student.post('/api/reservations').set('X-CSRF-Token',token).send({...payload,...changes});assert.equal(r.status,400,JSON.stringify(changes));
  }
  r=await student.get('/api/admin/report');assert.equal(r.status,403);
  r=await admin.post('/api/login').set('X-CSRF-Token',adminToken).send({email:'admin@example.com',password:'correct-admin-password'});assert.equal(r.status,200);
  r=await admin.patch('/api/admin/rooms/1').set('X-CSRF-Token',adminToken).send({opens:'12:00',closes:'22:00',active:true});assert.equal(r.status,409);
  r=await admin.post('/api/admin/rooms').set('X-CSRF-Token',adminToken).send({building_id:1,name:'Study 303',capacity:6,amenities:'Display',opens:'09:00',closes:'21:00'});assert.equal(r.status,201);
  r=await admin.get('/api/admin/report');assert.equal(r.status,200);assert.equal(r.body.length,7);
  r=await student.post(`/api/reservations/${booking}/cancel`).set('X-CSRF-Token',token);assert.equal(r.status,200);
  r=await student.get('/api/reservations');assert.equal(r.body[0].status,'cancelled');
  // Re-create the Express app while keeping database-backed sessions.
  const cookies=(await student.get('/api/me')).request.cookies;
  const restarted=createApp(db,{production:false,timezone:'UTC'});
  r=await request(restarted).get('/api/me').set('Cookie',cookies);assert.equal(r.body.user.email,'one@example.com');
  r=await student.post('/api/logout').set('X-CSRF-Token',token);assert.equal(r.status,200);
  r=await student.get('/api/reservations');assert.equal(r.status,401);
});
