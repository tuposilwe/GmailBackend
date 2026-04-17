const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const { URL } = require('url');

// 1. Extract and parse the DATABASE_URL from .env
const dbUrl = new URL(process.env.DATABASE_URL);

// 2. Initialize the adapter using extracted values
const adapter = new PrismaMariaDb({
  host: dbUrl.hostname,
  port: parseInt(dbUrl.port) || 3306,
  user: dbUrl.username,
  password: dbUrl.password,
  database: dbUrl.pathname.replace('/', ''), // Removes the leading slash
  connectionLimit: 5,
});

// 3. Initialize Prisma Client with the adapter
const prisma = new PrismaClient({ 
  adapter, 
  log: ['query', 'info', 'warn', 'error'] 
});

module.exports = { prisma };