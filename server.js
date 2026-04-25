const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const crypto = require('crypto');

const app = express();
app.use(express.json());
const IS_PACKAGED = Boolean(process.pkg);
const APP_ROOT = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = IS_PACKAGED ? path.join(__dirname, 'public') : path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

const DB_FILE = path.join(APP_ROOT, 'data.db');
let db;
const sessions = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const computedHash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    display_name: user.display_name,
    username: user.username,
    role: user.role,
    is_active: user.is_active
  };
}

async function initDb() {
  db = await open({ filename: DB_FILE, driver: sqlite3.Database });
  await db.exec(`PRAGMA foreign_keys = ON;`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const userColumns = await db.all(`PRAGMA table_info(users);`);
  const userColumnNames = userColumns.map(col => col.name);
  if (!userColumnNames.includes('password_salt')) {
    await db.exec(`ALTER TABLE users ADD COLUMN password_salt TEXT`);
  }
  if (!userColumnNames.includes('password_hash')) {
    await db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      purchase_price REAL NOT NULL DEFAULT 0,
      sell_price REAL NOT NULL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      date TEXT NOT NULL,
      total REAL NOT NULL,
      served_by TEXT DEFAULT '',
      sold_by TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open'
    );
  `);

  const invoiceColumns = await db.all(`PRAGMA table_info(invoices);`);
  const invoiceColumnNames = invoiceColumns.map(col => col.name);
  if (!invoiceColumnNames.includes('served_by')) {
    await db.exec(`ALTER TABLE invoices ADD COLUMN served_by TEXT DEFAULT ''`);
  }
  if (!invoiceColumnNames.includes('sold_by')) {
    await db.exec(`ALTER TABLE invoices ADD COLUMN sold_by TEXT DEFAULT ''`);
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      description TEXT,
      quantity INTEGER NOT NULL,
      purchase_price REAL NOT NULL,
      sell_price REAL NOT NULL,
      line_total REAL NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER REFERENCES invoices(id),
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT,
      date TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS revenues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT,
      date TEXT NOT NULL
    );
  `);
}

function parseDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return value;
}

app.get('/api/bootstrap-status', async (req, res) => {
  const row = await db.get('SELECT COUNT(*) as count FROM users');
  const userCount = Number(row?.count || 0);
  res.json({ hasUsers: userCount > 0 });
});

app.post('/api/bootstrap-admin', async (req, res) => {
  const row = await db.get('SELECT COUNT(*) as count FROM users');
  const userCount = Number(row?.count || 0);
  if (userCount > 0) {
    return res.status(400).json({ error: 'Bootstrap deja termine' });
  }

  const displayName = String(req.body.display_name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const role = String(req.body.role || 'admin').trim().toLowerCase() || 'admin';
  const password = String(req.body.password || '');

  if (!displayName || !username || !password) {
    return res.status(400).json({ error: 'Nom, identifiant et mot de passe requis' });
  }

  const { salt, hash } = hashPassword(password);
  const result = await db.run(
    'INSERT INTO users (display_name, username, role, is_active, password_salt, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
    [displayName, username, role, 1, salt, hash]
  );
  const user = await db.get('SELECT * FROM users WHERE id = ?', result.lastID);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user.id, createdAt: Date.now() });
  res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  }

  const user = await db.get('SELECT * FROM users WHERE username = ?', username);
  if (!user) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  if (Number(user.is_active) !== 1) {
    return res.status(403).json({ error: 'Compte inactif' });
  }
  const hasPassword = Boolean(user.password_salt && user.password_hash);
  if (!hasPassword) {
    if (password !== user.username) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    const migrated = hashPassword(password);
    await db.run(
      'UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?',
      [migrated.salt, migrated.hash, user.id]
    );
    user.password_salt = migrated.salt;
    user.password_hash = migrated.hash;
  }
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user.id, createdAt: Date.now() });
  return res.json({ token, user: sanitizeUser(user) });
});

app.use('/api', async (req, res, next) => {
  if (req.path === '/bootstrap-status' || req.path === '/bootstrap-admin' || req.path === '/login') {
    return next();
  }

  const token = String(req.get('x-auth-token') || '');
  if (!token) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  const session = sessions.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Session invalide' });
  }

  const user = await db.get(
    'SELECT id, display_name, username, role, is_active FROM users WHERE id = ?',
    session.userId
  );
  if (!user || Number(user.is_active) !== 1) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session invalide' });
  }

  req.authUser = user;
  req.authToken = token;
  return next();
});

app.get('/api/session', async (req, res) => {
  return res.json({ user: sanitizeUser(req.authUser) });
});

app.post('/api/logout', async (req, res) => {
  sessions.delete(req.authToken);
  return res.json({ success: true });
});

app.get('/api/clients', async (req, res) => {
  const clients = await db.all('SELECT * FROM clients ORDER BY id DESC');
  res.json(clients);
});

app.post('/api/clients', async (req, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom du client requis' });
  const result = await db.run(
    'INSERT INTO clients (name, phone, email, notes) VALUES (?, ?, ?, ?)',
    [name, phone || '', email || '', notes || '']
  );
  const client = await db.get('SELECT * FROM clients WHERE id = ?', result.lastID);
  res.json(client);
});

app.get('/api/products', async (req, res) => {
  const products = await db.all('SELECT * FROM products ORDER BY id DESC');
  res.json(products);
});

app.get('/api/staff', async (req, res) => {
  const staff = await db.all('SELECT * FROM staff ORDER BY id DESC');
  res.json(staff);
});

app.get('/api/users', async (req, res) => {
  const users = await db.all(
    'SELECT id, display_name, username, role, is_active, created_at FROM users ORDER BY id DESC'
  );
  res.json(users);
});

app.post('/api/staff', async (req, res) => {
  const { name, role } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'Nom et role requis' });
  const result = await db.run(
    'INSERT INTO staff (name, role) VALUES (?, ?)',
    [name, role]
  );
  const member = await db.get('SELECT * FROM staff WHERE id = ?', result.lastID);
  res.json(member);
});

app.post('/api/users', async (req, res) => {
  const displayName = String(req.body.display_name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const role = String(req.body.role || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const activeValue = req.body.is_active;
  const isActive = activeValue === '0' || activeValue === 0 || activeValue === false ? 0 : 1;

  if (!displayName || !username || !role || !password) {
    return res.status(400).json({ error: 'Nom, identifiant, role et mot de passe requis' });
  }

  try {
    const { salt, hash } = hashPassword(password);
    const result = await db.run(
      `
      INSERT INTO users (display_name, username, role, is_active, password_salt, password_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [displayName, username, role, isActive, salt, hash]
    );
    const user = await db.get(
      'SELECT id, display_name, username, role, is_active, created_at FROM users WHERE id = ?',
      result.lastID
    );
    return res.json(user);
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return res.status(400).json({ error: 'Cet identifiant existe deja' });
    }
    console.error('Erreur creation user:', error);
    return res.status(500).json({ error: 'Erreur interne lors de la creation du user' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const userId = Math.floor(Number(req.params.id));
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: 'User invalide' });
  }

  const result = await db.run('DELETE FROM users WHERE id = ?', userId);
  if (!result.changes) {
    return res.status(404).json({ error: 'User introuvable' });
  }
  return res.json({ success: true });
});

app.post('/api/products', async (req, res) => {
  const { name, category, purchase_price, sell_price, stock } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom du produit requis' });
  const parsedStock = Number.isFinite(Number(stock)) ? Math.max(0, Math.floor(Number(stock))) : 0;
  const result = await db.run(
    'INSERT INTO products (name, category, purchase_price, sell_price, stock) VALUES (?, ?, ?, ?, ?)',
    [name, category || '', Number(purchase_price) || 0, Number(sell_price) || 0, parsedStock]
  );
  const product = await db.get('SELECT * FROM products WHERE id = ?', result.lastID);
  res.json(product);
});

app.post('/api/products/stock-entry', async (req, res) => {
  const productId = Math.floor(Number(req.body.product_id));
  const quantity = Math.floor(Number(req.body.quantity));

  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ error: 'Produit invalide' });
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Quantite d entree invalide' });
  }

  const updateResult = await db.run(
    'UPDATE products SET stock = stock + ? WHERE id = ?',
    [quantity, productId]
  );
  if (updateResult.changes === 0) {
    return res.status(404).json({ error: 'Produit introuvable' });
  }

  const product = await db.get('SELECT * FROM products WHERE id = ?', productId);
  res.json(product);
});

app.get('/api/invoices', async (req, res) => {
  const invoiceId = req.query.id;
  if (invoiceId) {
    const invoice = await db.get(
      `
      SELECT invoices.*, clients.name as client_name
      FROM invoices
      LEFT JOIN clients ON invoices.client_id = clients.id
      WHERE invoices.id = ?
    `,
      invoiceId
    );
    if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
    const lines = await db.all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', invoiceId);

    const paymentStats = await db.get(
      'SELECT COUNT(*) as payment_count, COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE invoice_id = ?',
      invoiceId
    );
    const paymentCount = Number(paymentStats?.payment_count || 0);
    const totalPaid = Number(paymentStats?.total_paid || 0);
    const isPaid = paymentCount > 0;

    return res.json({ invoice, lines, isPaid, totalPaid });
  }

  const invoices = await db.all(`
    SELECT invoices.*, clients.name as client_name
    FROM invoices
    LEFT JOIN clients ON invoices.client_id = clients.id
    ORDER BY invoices.id DESC
  `);

  for (const inv of invoices) {
    const paymentStats = await db.get(
      'SELECT COUNT(*) as payment_count, COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE invoice_id = ?',
      inv.id
    );
    const paymentCount = Number(paymentStats?.payment_count || 0);
    const totalPaid = Number(paymentStats?.total_paid || 0);
    inv.isPaid = paymentCount > 0;
    inv.totalPaid = totalPaid;
  }

  const lines = await db.all('SELECT * FROM invoice_lines ORDER BY id');
  res.json({ invoices, lines });
});

app.post('/api/invoices', async (req, res) => {
  let { client_id, date, sold_by, served_by, lines } = req.body;
  if (client_id === '') client_id = null;
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'Lignes de facture requises' });
  }

  const normalizedLines = lines.map(line => ({
    product_id: line.product_id || null,
    description: line.description || '',
    quantity: Math.floor(Number(line.quantity || 0)),
    purchase_price: Number(line.purchase_price || 0),
    sell_price: Number(line.sell_price || 0)
  }));

  if (normalizedLines.some(line => !Number.isFinite(line.quantity) || line.quantity <= 0)) {
    return res.status(400).json({ error: 'Quantite invalide dans une ligne de facture' });
  }

  const invoiceDate = parseDate(date);
  const total = normalizedLines.reduce((sum, line) => sum + line.sell_price * line.quantity, 0);
  let invoiceId = null;
  let stmt = null;

  try {
    await db.exec('BEGIN IMMEDIATE TRANSACTION');

    const invoiceResult = await db.run(
      'INSERT INTO invoices (client_id, date, total, sold_by, served_by, status) VALUES (?, ?, ?, ?, ?, ?)',
      [client_id, invoiceDate, total, sold_by || '', served_by || '', 'open']
    );
    invoiceId = invoiceResult.lastID;

    stmt = await db.prepare(`
      INSERT INTO invoice_lines (invoice_id, product_id, description, quantity, purchase_price, sell_price, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of normalizedLines) {
      const lineTotal = line.sell_price * line.quantity;
      await stmt.run(
        invoiceId,
        line.product_id,
        line.description,
        line.quantity,
        line.purchase_price,
        line.sell_price,
        lineTotal
      );

      if (line.product_id) {
        const updateStockResult = await db.run(
          'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
          [line.quantity, line.product_id, line.quantity]
        );

        if (updateStockResult.changes === 0) {
          const product = await db.get('SELECT id FROM products WHERE id = ?', line.product_id);
          if (!product) {
            throw new Error(`Produit introuvable (ID ${line.product_id})`);
          }
          throw new Error(`Stock insuffisant pour le produit ID ${line.product_id}`);
        }
      }
    }

    await stmt.finalize();
    stmt = null;
    await db.exec('COMMIT');
  } catch (error) {
    if (stmt) {
      try {
        await stmt.finalize();
      } catch (finalizeError) {
        console.error('Erreur finalize invoice_lines:', finalizeError);
      }
    }

    try {
      await db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('Erreur rollback facture:', rollbackError);
    }

    const message = error?.message || 'Erreur lors de la creation de facture';
    if (
      message.includes('Stock insuffisant') ||
      message.includes('Produit introuvable') ||
      message.includes('Quantite invalide')
    ) {
      return res.status(400).json({ error: message });
    }
    console.error('Erreur creation facture:', error);
    return res.status(500).json({ error: 'Erreur interne lors de la creation de la facture' });
  }

  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  res.json(invoice);
});

app.get('/api/payments', (req, res) => {
  const invoice_id = req.query.invoice_id;
  if (invoice_id) {
    db.all('SELECT * FROM payments WHERE invoice_id = ?', [invoice_id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  } else {
    db.all('SELECT * FROM payments', (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
});

app.post('/api/payments', async (req, res) => {
  const { invoice_id, amount, date, method } = req.body;
  const invoiceId = Math.floor(Number(invoice_id));
  const parsedAmount = Number(amount);

  if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
    return res.status(400).json({ error: 'Facture invalide' });
  }
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Montant de paiement invalide' });
  }

  try {
    await db.exec('BEGIN IMMEDIATE TRANSACTION');

    const invoice = await db.get('SELECT id, total FROM invoices WHERE id = ?', invoiceId);
    if (!invoice) {
      await db.exec('ROLLBACK');
      return res.status(404).json({ error: 'Facture introuvable' });
    }

    const paymentStats = await db.get(
      'SELECT COUNT(*) as payment_count, COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE invoice_id = ?',
      invoiceId
    );
    const paymentCount = Number(paymentStats?.payment_count || 0);
    if (paymentCount > 0) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Cette facture a deja un paiement' });
    }

    const normalizedAmount = Math.round(parsedAmount * 100) / 100;
    const invoiceTotal = Math.round(Number(invoice.total) * 100) / 100;
    if (!Number.isFinite(invoiceTotal) || invoiceTotal <= 0) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Montant de facture invalide' });
    }
    if (normalizedAmount < invoiceTotal) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Le paiement doit couvrir le montant total de la facture' });
    }

    const amountToRecord = invoiceTotal;
    if (!Number.isFinite(amountToRecord) || amountToRecord <= 0) {
      await db.exec('ROLLBACK');
      return res.status(400).json({ error: 'Montant de paiement invalide' });
    }

    const paymentDate = parseDate(date);
    const result = await db.run(
      'INSERT INTO payments (invoice_id, date, amount, method) VALUES (?, ?, ?, ?)',
      [invoiceId, paymentDate, amountToRecord, method || '']
    );
    const payment = await db.get('SELECT * FROM payments WHERE id = ?', result.lastID);
    await db.exec('COMMIT');
    return res.json(payment);
  } catch (error) {
    try {
      await db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('Erreur rollback paiement:', rollbackError);
    }
    console.error('Erreur creation paiement:', error);
    return res.status(500).json({ error: 'Erreur interne lors de l enregistrement du paiement' });
  }
});

app.post('/api/expenses', async (req, res) => {
  const { description, amount, date, category } = req.body;
  if (!description || !amount) return res.status(400).json({ error: 'Description et montant requis' });
  const expenseDate = parseDate(date);
  const result = await db.run(
    'INSERT INTO expenses (description, amount, date, category) VALUES (?, ?, ?, ?)',
    [description, Number(amount), expenseDate, category || '']
  );
  const expense = await db.get('SELECT * FROM expenses WHERE id = ?', result.lastID);
  res.json(expense);
});

app.post('/api/revenues', async (req, res) => {
  const { description, amount, date, category } = req.body;
  if (!description || !amount) return res.status(400).json({ error: 'Description et montant requis' });
  const revenueDate = parseDate(date);
  const result = await db.run(
    'INSERT INTO revenues (description, amount, date, category) VALUES (?, ?, ?, ?)',
    [description, Number(amount), revenueDate, category || '']
  );
  const revenue = await db.get('SELECT * FROM revenues WHERE id = ?', result.lastID);
  res.json(revenue);
});

app.get('/api/summary', async (req, res) => {
  const date = parseDate(req.query.date);
  const invoices = await db.all('SELECT * FROM invoices WHERE date = ?', date);
  const invoiceIds = invoices.map(i => i.id);

  const invoiceLines =
    invoiceIds.length > 0
      ? await db.all(`SELECT * FROM invoice_lines WHERE invoice_id IN (${invoiceIds.map(() => '?').join(',')})`, invoiceIds)
      : [];
  const payments = await db.all('SELECT * FROM payments WHERE date = ?', date);
  const expenses = await db.all('SELECT * FROM expenses WHERE date = ?', date);
  const revenues = await db.all('SELECT * FROM revenues WHERE date = ?', date);

  const paidAmount = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const totalSales = invoices.reduce((sum, invoice) => sum + invoice.total, 0);
  const totalCost = invoiceLines.reduce((sum, line) => sum + line.purchase_price * line.quantity, 0);
  const grossMargin = totalSales - totalCost;
  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const totalRevenues = revenues.reduce((sum, rev) => sum + rev.amount, 0);
  const netCash = paidAmount + totalRevenues - totalExpenses;

  res.json({
    date,
    invoices,
    invoiceLines,
    payments,
    expenses,
    revenues,
    totals: {
      totalSales,
      totalCost,
      grossMargin,
      paidAmount,
      totalExpenses,
      totalRevenues,
      netCash
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

initDb()
  .then(() => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`Cave app demarree sur http://localhost:${port}`);
    });
  })
  .catch(error => {
    console.error('Erreur d initialisation de la base de donnees:', error);
    process.exit(1);
  });
