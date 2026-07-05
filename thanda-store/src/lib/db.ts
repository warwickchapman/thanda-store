import { Pool } from 'pg';

const pool = new Pool({
  user: 'renogy_user',
  host: 'localhost',
  database: 'renogy_store',
  password: 'renogy_pass',
  port: 5432,
});

export default pool;
