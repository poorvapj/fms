// Check the MongoDB connection for an environment: npm run db:ping  /  npm run db:ping:live
import { config } from '../config.ts';
import { connect, disconnect } from '../db/mongo.ts';

const masked = config.mongoUri.replace(/\/\/([^:/]+):[^@]+@/, '//$1:****@');
console.log(`${config.env.toUpperCase()}: ${masked || '(no address set)'}  → database "${config.mongoDb}"`);
if (/<db_password>|<user>|<local-cluster>/.test(config.mongoUri)) {
  console.error(`Replace the <placeholders> in ${config.env === 'live' ? 'MONGODB_URI_LIVE' : 'MONGODB_URI_LOCAL'} in backend/.env first.`);
  process.exit(1);
}
try {
  const db = await connect();
  await db.admin().command({ ping: 1 });
  console.log('Pinged your deployment. You successfully connected to MongoDB!');
} catch (err) {
  const msg = (err as Error).message;
  console.error('Connection failed:', msg);
  if (/auth|password|bad auth/i.test(msg)) console.error('→ Wrong user name or password in the connection string.');
  else if (/timed out|ENOTFOUND|Server selection/i.test(msg)) console.error('→ Check Atlas → Network Access (allow your IP) and the cluster address.');
  process.exitCode = 1;
} finally {
  await disconnect();
}
