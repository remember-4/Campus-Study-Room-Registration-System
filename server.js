import 'dotenv/config';
import { database, initialize } from './db.js';
import { createApp } from './src/app.js';

const db = database();
try {
  await initialize(db);
  const app = createApp(db);
  const server = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Campus Rooms is ready'));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
    server.close(() => db.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
} catch (e) { console.error('Startup failed:', e.message); await db.end(); process.exit(1); }
