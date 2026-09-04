// Load environment variables before creating the database connection pool.
require('dotenv').config();

const mysql = require('mysql2/promise');

// A pool reuses connections efficiently and keeps API route code concise.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// Export the pool so route handlers can use parameterized queries safely.
module.exports = pool;
