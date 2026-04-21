const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'data.db');
let db;

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

app.post('/api/staff', async (req, res) => {
  const { name, role } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'Nom et rôle requis' });
  const result = await db.run(
    'INSERT INTO staff (name, role) VALUES (?, ?)',
    [name, role]
  );
  const member = await db.get('SELECT * FROM staff WHERE id = ?', result.lastID);
  res.json(member);
});

app.post('/api/products', async (req, res) => {
  const { name, category, purchase_price, sell_price } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom du produit requis' });
  const result = await db.run(
    'INSERT INTO products (name, category, purchase_price, sell_price) VALUES (?, ?, ?, ?)',
    [name, category || '', Number(purchase_price) || 0, Number(sell_price) || 0]
  );
  const product = await db.get('SELECT * FROM products WHERE id = ?', result.lastID);
  res.json(product);
});

app.get('/api/invoices', async (req, res) => {
  const invoiceId = req.query.id;
  if (invoiceId) {
    const invoice = await db.get(`
      SELECT invoices.*, clients.name as client_name
      FROM invoices
      LEFT JOIN clients ON invoices.client_id = clients.id
      WHERE invoices.id = ?
    `, invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });
    const lines = await db.all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', invoiceId);
    
    // Calculer le statut de paiement
    const payments = await db.all('SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE invoice_id = ?', invoiceId);
    const totalPaid = payments[0]?.total_paid || 0;
    const isPaid = totalPaid >= invoice.total;
    
    return res.json({ invoice, lines, isPaid, totalPaid });
  }

  const invoices = await db.all(`
    SELECT invoices.*, clients.name as client_name
    FROM invoices
    LEFT JOIN clients ON invoices.client_id = clients.id
    ORDER BY invoices.id DESC
  `);
  
  // Ajouter le statut de paiement pour chaque facture
  for (let inv of invoices) {
    const payments = await db.all('SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE invoice_id = ?', inv.id);
    const totalPaid = payments[0]?.total_paid || 0;
    inv.isPaid = totalPaid >= inv.total;
    inv.totalPaid = totalPaid;
  }
  
  const lines = await db.all('SELECT * FROM invoice_lines ORDER BY id');
  res.json({ invoices, lines });
});

app.post('/api/invoices', async (req, res) => {
  let { client_id, date, sold_by, served_by, lines } = req.body;
  if (client_id === '') client_id = null;
  if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'Lignes de facture requises' });
  const invoiceDate = parseDate(date);
  const total = lines.reduce((sum, line) => sum + Number(line.sell_price || 0) * Number(line.quantity || 0), 0);

  const invoiceResult = await db.run(
    'INSERT INTO invoices (client_id, date, total, sold_by, served_by, status) VALUES (?, ?, ?, ?, ?, ?)',
    [client_id, invoiceDate, total, sold_by || '', served_by || '', 'open']
  );
  const invoiceId = invoiceResult.lastID;

  const stmt = await db.prepare(`
    INSERT INTO invoice_lines (invoice_id, product_id, description, quantity, purchase_price, sell_price, line_total)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const line of lines) {
    const quantity = Number(line.quantity || 0);
    const purchase_price = Number(line.purchase_price || 0);
    const sell_price = Number(line.sell_price || 0);
    const lineTotal = sell_price * quantity;
    await stmt.run(invoiceId, line.product_id || null, line.description || '', quantity, purchase_price, sell_price, lineTotal);
  }

  await stmt.finalize();

  // Décrémenter le stock des produits vendus
  for (const line of lines) {
    const quantity = Number(line.quantity || 0);
    if (line.product_id && quantity > 0) {
      await db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [quantity, line.product_id]);
    }
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
  if (!invoice_id || !amount) return res.status(400).json({ error: 'Facture et montant requis' });
  const paymentDate = parseDate(date);
  const result = await db.run(
    'INSERT INTO payments (invoice_id, date, amount, method) VALUES (?, ?, ?, ?)',
    [invoice_id, paymentDate, Number(amount), method || '']
  );
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', result.lastID);
  res.json(payment);
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

  const invoiceLines = invoiceIds.length > 0
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb().then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Cave app démarrée sur http://localhost:${port}`);
  });
}).catch(error => {
  console.error('Erreur d initialisation de la base de données:', error);
  process.exit(1);
});
