const AUTH_TOKEN_KEY = 'lte_auth_token';
let appBootstrapped = false;

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

function setAuthToken(token) {
  if (!token) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    return;
  }
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

function setAuthUi(isAuthenticated) {
  const loginScreen = document.getElementById('login-screen');
  const main = document.querySelector('main');
  const nav = document.getElementById('main-nav');
  const logoutBtn = document.getElementById('logout-btn');
  if (loginScreen) loginScreen.classList.toggle('hidden', isAuthenticated);
  if (main) main.classList.toggle('hidden', !isAuthenticated);
  if (nav) nav.classList.toggle('hidden', !isAuthenticated);
  if (logoutBtn) logoutBtn.classList.toggle('hidden', !isAuthenticated);
}

function setLoginFeedback(message, isError = false) {
  const node = document.getElementById('login-feedback');
  if (!node) return;
  node.textContent = message || '';
  node.className = isError ? 'error-text' : 'success-text';
}

function setBootstrapFeedback(message, isError = false) {
  const node = document.getElementById('bootstrap-feedback');
  if (!node) return;
  node.textContent = message || '';
  node.className = isError ? 'error-text' : 'success-text';
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getAuthToken();
  if (token) headers['x-auth-token'] = token;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    setAuthToken('');
    setAuthUi(false);
  }
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  return res.json();
}

async function publicApiRequest(paths, options = {}) {
  let lastError = null;
  for (const path of paths) {
    try {
      const res = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: res.statusText }));
        if (res.status === 404) {
          lastError = new Error(payload.error || 'Not Found');
          continue;
        }
        throw new Error(payload.error || res.statusText);
      }
      return res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Not Found');
}
function formatCurrency(value) {
  return Number(value).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}

function parseAmountInput(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function createItemCard(title, body) {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.innerHTML = `<strong>${title}</strong><div>${body}</div>`;
  return card;
}

let products = [];
let invoices = [];
let clientsCache = [];
let staffCache = [];
let invoicePage = 1;
const invoicePageSize = 5;
let invoiceFilter = 'all'; // 'all', 'paid', 'unpaid'
let paymentRemainingDue = 0;

async function loadClients() {
  const clients = await api('/api/clients');
  clientsCache = clients;
  const list = document.getElementById('clients-list');
  list.innerHTML = '';
  const clientSelect = document.getElementById('invoice-client');
  clientSelect.innerHTML = '<option value="">Aucun client</option>';
  clients.forEach(c => {
    list.appendChild(createItemCard(c.name, `Tel: ${c.phone || '-'}<br>Email: ${c.email || '-'}<br>${c.notes || ''}`));
    clientSelect.innerHTML += `<option value="${c.id}">${c.name}</option>`;
  });
  updateHomeDashboard();
}

async function loadProducts() {
  products = await api('/api/products');
  const list = document.getElementById('products-list');
  const options = document.getElementById('product-list');
  const stockEntrySelect = document.getElementById('stock-entry-product');
  list.innerHTML = '';
  options.innerHTML = '';
  if (stockEntrySelect) stockEntrySelect.innerHTML = '<option value="">Choisir un produit</option>';
  products.forEach(p => {
    list.appendChild(createItemCard(p.name, `Catégorie: ${p.category || '-'}<br>Achat: ${formatCurrency(p.purchase_price)}<br>Vente: ${formatCurrency(p.sell_price)}<br>Stock: ${p.stock || 0}`));
    options.innerHTML += `<option value="${p.name}" data-id="${p.id}" data-purchase="${p.purchase_price}" data-sell="${p.sell_price}" data-stock="${p.stock || 0}"></option>`;
    if (stockEntrySelect) {
      stockEntrySelect.innerHTML += `<option value="${p.id}">${p.name} (stock: ${p.stock || 0})</option>`;
    }
  });
  updateHomeDashboard();
}

async function loadStaff() {
  const staff = await api('/api/staff');
  staffCache = staff;
  const staffList = document.getElementById('staff-list');
  const serverSelect = document.getElementById('server-select');
  staffList.innerHTML = '';
  serverSelect.innerHTML = '<option value="">Aucune serveuse</option>';

  let firstSeller = '';
  staff.forEach(member => {
    const card = document.createElement('div');
    card.className = 'staff-card';
    card.innerHTML = `<strong>${member.name}</strong> (${member.role})`;
    staffList.appendChild(card);

    if (member.role === 'vendeur') {
      if (!firstSeller) firstSeller = member.name;
    }
    if (member.role === 'serveur') {
      serverSelect.innerHTML += `<option value="${member.name}">${member.name}</option>`;
    }
  });

  if (firstSeller) {
    document.getElementById('sold-by').value = firstSeller;
  }
  updateHomeDashboard();
}

async function loadUsers() {
  const users = await api('/api/users');
  const list = document.getElementById('users-list');
  if (!list) return;
  list.innerHTML = '';

  if (users.length === 0) {
    list.innerHTML = '<p>Aucun user enregistre.</p>';
    return;
  }

  users.forEach(user => {
    const activeLabel = Number(user.is_active) === 1 ? 'Actif' : 'Inactif';
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <div class="user-row-main">
        <strong>${user.display_name}</strong>
        <span>@${user.username}</span>
        <span>Role: ${user.role}</span>
        <span>Statut: ${activeLabel}</span>
      </div>
      <button type="button" class="danger-btn" data-user-id="${user.id}">Supprimer</button>
    `;
    list.appendChild(row);
  });
}

async function loadInvoices() {
  const data = await api('/api/invoices');
  invoices = data.invoices;
  const paymentInvoice = document.getElementById('payment-invoice');
  const select = document.getElementById('invoice-select');
  const listContainer = document.getElementById('invoice-list-container');
  const pagination = document.getElementById('invoice-pagination');

  if (paymentInvoice) paymentInvoice.innerHTML = '<option value="">Choisir une facture</option>';
  if (select) select.innerHTML = '<option value="">Sélectionner une facture</option>';
  if (listContainer) listContainer.innerHTML = '';
  if (pagination) pagination.innerHTML = '';

  if (invoices.length === 0) {
    if (select) select.innerHTML = '<option value="">Aucune facture enregistrée</option>';
    if (listContainer) listContainer.innerHTML = '<p>Aucune facture enregistrée pour le moment.</p>';
    return;
  }

  invoices.forEach(inv => {
    const title = `Facture #${inv.id} - ${inv.client_name || 'Aucun client'} - ${formatCurrency(inv.total)}`;
    if (select) select.innerHTML += `<option value="${inv.id}">${title}</option>`;
  });

  if (paymentInvoice) {
    const unpaidInvoices = invoices.filter(inv => !inv.isPaid);
    if (unpaidInvoices.length === 0) {
      paymentInvoice.innerHTML = '<option value="">Aucune facture impayee</option>';
    } else {
      unpaidInvoices.forEach(inv => {
        paymentInvoice.innerHTML += `<option value="${inv.id}">#${inv.id} - ${inv.client_name || 'Aucun client'} - ${formatCurrency(inv.total)}</option>`;
      });
    }
  }

  invoicePage = 1;
  renderInvoicePage();
  updateHomeDashboard();
}

function renderInvoicePage() {
  const listContainer = document.getElementById('invoice-list-container');
  const pagination = document.getElementById('invoice-pagination');
  if (!listContainer || !pagination) return;

  // Filtrer les factures selon le filtre actif
  let filteredInvoices = invoices;
  if (invoiceFilter === 'paid') {
    filteredInvoices = invoices.filter(inv => inv.isPaid);
  } else if (invoiceFilter === 'unpaid') {
    filteredInvoices = invoices.filter(inv => !inv.isPaid);
  }

  const start = (invoicePage - 1) * invoicePageSize;
  const pageInvoices = filteredInvoices.slice(start, start + invoicePageSize);

  listContainer.innerHTML = '';
  pageInvoices.forEach(inv => {
    const statusBadge = inv.isPaid ? '<span class="status-badge paid">Payée</span>' : '<span class="status-badge unpaid">Impayée</span>';
    const title = `Facture #${inv.id} - ${inv.client_name || 'Aucun client'}${statusBadge}`;
    listContainer.appendChild(createItemCard(
      title,
      `Date: ${inv.date}<br>Total: ${formatCurrency(inv.total)}<br>Payé: ${formatCurrency(inv.totalPaid || 0)}<br>Vendeur: ${inv.sold_by || '-'}<br>Serveur: ${inv.served_by || '-'}`
    ));
  });

  const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / invoicePageSize));
  pagination.innerHTML = `
    <button type="button" data-action="prev" ${invoicePage === 1 ? 'disabled' : ''}>Précédent</button>
    <span>Page ${invoicePage} / ${totalPages}</span>
    <button type="button" data-action="next" ${invoicePage === totalPages ? 'disabled' : ''}>Suivant</button>
  `;
}

function initInvoicePagination() {
  const pagination = document.getElementById('invoice-pagination');
  if (!pagination) return;
  pagination.addEventListener('click', event => {
    const action = event.target.dataset.action;
    if (!action) return;
    
    // Filtrer les factures selon le filtre actif
    let filteredInvoices = invoices;
    if (invoiceFilter === 'paid') {
      filteredInvoices = invoices.filter(inv => inv.isPaid);
    } else if (invoiceFilter === 'unpaid') {
      filteredInvoices = invoices.filter(inv => !inv.isPaid);
    }
    
    const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / invoicePageSize));
    if (action === 'prev' && invoicePage > 1) {
      invoicePage -= 1;
      renderInvoicePage();
    }
    if (action === 'next' && invoicePage < totalPages) {
      invoicePage += 1;
      renderInvoicePage();
    }
  });
}

function updateInvoiceTotal() {
  const lines = document.querySelectorAll('#invoice-lines .line-row');
  let total = 0;
  lines.forEach(line => {
    const quantity = Number(line.querySelector('input[name="quantity"]').value) || 0;
    const sellPrice = Number(line.querySelector('input[name="sell_price"]').value) || 0;
    total += quantity * sellPrice;
  });
  document.getElementById('invoice-total').value = formatCurrency(total);
}

function findBestProductMatch(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;

  const exact = products.find(p => p.name.toLowerCase() === normalized);
  if (exact) return exact;

  const startsWith = products.find(p => p.name.toLowerCase().startsWith(normalized));
  if (startsWith) return startsWith;

  return products.find(p => p.name.toLowerCase().includes(normalized)) || null;
}

function addInvoiceLine() {
  const container = document.createElement('div');
  container.className = 'line-row';
  container.innerHTML = `
    <input type="text" name="product_search" class="product-search" placeholder="Produit" list="product-list" required />
    <input type="hidden" name="product_id" class="product-id" />
    <input type="hidden" name="purchase_price" class="purchase-price" />
    <span class="stock-info"></span>
    <input type="number" name="quantity" placeholder="Quantité" min="1" value="1" required />
    <input type="number" name="sell_price" placeholder="Prix vente" step="0.01" class="sell-price" readonly />
    <button type="button" class="remove-line">Supprimer</button>
  `;
  const productSearch = container.querySelector('.product-search');
  const productIdInput = container.querySelector('.product-id');
  const purchaseInput = container.querySelector('.purchase-price');
  const sellInput = container.querySelector('.sell-price');
  const stockInfo = container.querySelector('.stock-info');

  function applyProductMatch(match, forceLabel) {
    if (match) {
      productIdInput.value = match.id;
      purchaseInput.value = match.purchase_price;
      sellInput.value = match.sell_price;
      stockInfo.textContent = `Stock: ${match.stock || 0}`;
      if (forceLabel) productSearch.value = match.name;
    } else {
      productIdInput.value = '';
      purchaseInput.value = '';
      sellInput.value = '';
      stockInfo.textContent = '';
    }
  }

  productSearch.addEventListener('input', function () {
    const query = this.value.trim();
    if (!query) {
      applyProductMatch(null, false);
      return;
    }
    const exact = products.find(p => p.name.toLowerCase() === query.toLowerCase());
    applyProductMatch(exact || null, false);
  });

  productSearch.addEventListener('blur', function () {
    const match = findBestProductMatch(this.value);
    applyProductMatch(match, Boolean(match));
  });

  productSearch.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    const match = findBestProductMatch(this.value);
    if (!match) return;
    event.preventDefault();
    applyProductMatch(match, true);
  });

  container.querySelector('.remove-line').addEventListener('click', () => {
    container.remove();
    updateInvoiceTotal();
  });

  const quantityInput = container.querySelector('input[name="quantity"]');
  const sellPriceInput = container.querySelector('input[name="sell_price"]');

  quantityInput.addEventListener('input', updateInvoiceTotal);
  sellPriceInput.addEventListener('input', updateInvoiceTotal);

  document.getElementById('invoice-lines').appendChild(container);
  updateInvoiceTotal();
}

document.getElementById('client-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  await api('/api/clients', { method: 'POST', body: JSON.stringify(data) });
  form.reset();
  loadClients();
});

document.getElementById('product-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/products', { method: 'POST', body: JSON.stringify(data) });
  event.target.reset();
  const stockFeedback = document.getElementById('stock-entry-feedback');
  if (stockFeedback) stockFeedback.textContent = '';
  loadProducts();
});

document.getElementById('stock-entry-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const feedback = document.getElementById('stock-entry-feedback');
  const payload = {
    product_id: Number(data.product_id),
    quantity: Number(data.quantity)
  };

  const product = await api('/api/products/stock-entry', { method: 'POST', body: JSON.stringify(payload) });
  if (feedback) {
    feedback.textContent = `Entree enregistree: ${product.name} +${payload.quantity} (stock actuel: ${product.stock})`;
  }

  form.reset();
  loadProducts();
});

document.getElementById('staff-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/staff', { method: 'POST', body: JSON.stringify(data) });
  event.target.reset();
  loadStaff();
});

document.getElementById('user-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    await loadUsers();
  } catch (error) {
    alert(error.message || 'Impossible de creer le user.');
  }
});

document.getElementById('users-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-user-id]');
  if (!button) return;
  const userId = button.dataset.userId;
  if (!userId) return;
  await api(`/api/users/${userId}`, { method: 'DELETE' });
  await loadUsers();
});

document.getElementById('invoice-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const client_id = form.client_id.value || null;
  const date = form.date.value || null;
  const sold_by = form.sold_by.value || '';
  const served_by = document.getElementById('server-select').value || '';
  const lines = Array.from(document.querySelectorAll('#invoice-lines .line-row')).map(row => ({
    product_id: row.querySelector('.product-id').value,
    description: row.querySelector('.product-search').value,
    quantity: row.querySelector('input[name="quantity"]').value,
    purchase_price: row.querySelector('input[name="purchase_price"]').value,
    sell_price: row.querySelector('input[name="sell_price"]').value,
  })).filter(line => line.product_id && line.quantity && line.sell_price);
  const invoice = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ client_id, date, sold_by, served_by, lines }) });
  form.reset();
  document.getElementById('invoice-lines').innerHTML = '';
  addInvoiceLine();
  setTodayDate();
  loadInvoices();
  loadProducts();
  
  // Afficher les détails de la facture avec option d'impression
  displayLastInvoice(invoice.id);
});

async function displayLastInvoice(invoiceId) {
  const data = await api(`/api/invoices?id=${invoiceId}`);
  const invoice = data.invoice;
  const lines = data.lines;
  const html = buildInvoiceReceiptHtml(invoice, lines);
  
  document.getElementById('last-invoice-details').innerHTML = html;
  document.getElementById('last-invoice-section').style.display = 'block';
  
  // Stocker l'ID pour l'impression
  document.getElementById('print-invoice-btn').dataset.invoiceId = invoiceId;
}

function buildInvoiceReceiptHtml(invoice, lines) {
  let html = `
    <div class="invoice-receipt">
      <h4>Facture #${invoice.id}</h4>
      <p><strong>Date:</strong> ${invoice.date}</p>
      <p><strong>Client:</strong> ${invoice.client_name || 'Aucun client'}</p>
      <p><strong>Vendeur:</strong> ${invoice.sold_by || '-'}</p>
      <p><strong>Serveur:</strong> ${invoice.served_by || '-'}</p>
      <hr>
      <table class="invoice-table">
        <tr>
          <th>Produit</th>
          <th>Qty</th>
          <th>P.U.</th>
          <th>Total</th>
        </tr>
  `;

  lines.forEach(line => {
    html += `
      <tr>
        <td>${line.description}</td>
        <td>${line.quantity}</td>
        <td>${formatCurrency(line.sell_price)}</td>
        <td>${formatCurrency(line.line_total)}</td>
      </tr>
    `;
  });

  html += `
      </table>
      <hr>
      <p><strong>Total:</strong> ${formatCurrency(invoice.total)}</p>
    </div>
  `;

  return html;
}

function printInvoiceHtml(content) {
  const printWindow = window.open('', '', 'height=400,width=600');
  if (!printWindow) {
    alert("Impossible d'ouvrir la fenetre d'impression. Autorisez les popups pour ce site.");
    return;
  }
  printWindow.document.write(`
    <html>
      <head>
        <title>Facture</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          h4 { text-align: center; }
          hr { border: 1px solid #ddd; }
          table { width: 100%; border-collapse: collapse; }
          table th, table td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
          table th { background: #f0f0f0; font-weight: bold; }
          .invoice-receipt { max-width: 400px; margin: 0 auto; }
        </style>
      </head>
      <body>
        ${content}
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function printInvoice() {
  const content = document.getElementById('last-invoice-details').innerHTML;
  printInvoiceHtml(content);
}

document.getElementById('add-line').addEventListener('click', addInvoiceLine);
document.getElementById('print-invoice-btn').addEventListener('click', printInvoice);

document.getElementById('payment-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const enteredAmount = parseAmountInput(data.amount);

  if (!data.invoice_id) {
    alert('Choisissez une facture.');
    return;
  }
  if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
    alert('Somme encaissee invalide.');
    return;
  }

  const amountToRecord = Math.min(enteredAmount, paymentRemainingDue);
  if (amountToRecord <= 0) {
    alert('Cette facture est deja reglee.');
    return;
  }

  data.amount = amountToRecord.toFixed(2);
  try {
    await api('/api/payments', { method: 'POST', body: JSON.stringify(data) });
  } catch (error) {
    alert(error.message || 'Erreur lors du paiement.');
    return;
  }
  form.reset();
  paymentRemainingDue = 0;
  document.getElementById('payment-due').value = '';
  document.getElementById('payment-change').value = '';
  loadInvoices();
});

document.getElementById('expense-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/expenses', { method: 'POST', body: JSON.stringify(data) });
  event.target.reset();
});

document.getElementById('revenue-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/revenues', { method: 'POST', body: JSON.stringify(data) });
  event.target.reset();
});

document.getElementById('payment-invoice').addEventListener('change', async event => {
  const invoiceId = event.target.value;
  const dueInput = document.getElementById('payment-due');
  const amountInput = document.getElementById('payment-amount');
  const changeInput = document.getElementById('payment-change');

  if (!invoiceId) {
    paymentRemainingDue = 0;
    dueInput.value = '';
    amountInput.value = '';
    amountInput.removeAttribute('max');
    changeInput.value = '';
    return;
  }

  const data = await api(`/api/invoices?id=${invoiceId}`);
  const invoice = data.invoice;
  const invoiceTotal = Number(invoice.total) || 0;

  paymentRemainingDue = invoiceTotal > 0 ? invoiceTotal : 0;
  dueInput.value = paymentRemainingDue.toFixed(2);
  amountInput.value = '';
  amountInput.removeAttribute('max');
  changeInput.value = '0.00';
  document.getElementById('payment-date').value = invoice.date;
  document.getElementById('payment-method').value = 'Especes';
});

if (!document.getElementById('payment-amount').dataset.changeBound) {
  document.getElementById('payment-amount').addEventListener('input', event => {
    const entered = parseAmountInput(event.target.value);
    const changeInput = document.getElementById('payment-change');
    if (!Number.isFinite(entered) || entered < 0) {
      changeInput.value = '0.00';
      return;
    }
    const change = entered - paymentRemainingDue;
    changeInput.value = (change > 0 ? change : 0).toFixed(2);
  });
  document.getElementById('payment-amount').dataset.changeBound = '1';
}

async function showSummary(event) {
  event.preventDefault();
  const date = new FormData(event.target).get('date');
  const data = await api(`/api/summary?date=${date}`);
  const container = document.getElementById('summary-result');
  container.innerHTML = `
    <p><strong>Date:</strong> ${data.date}</p>
    <p><strong>Ventes totales:</strong> ${formatCurrency(data.totals.totalSales)}</p>
    <p><strong>Coût d'achat total:</strong> ${formatCurrency(data.totals.totalCost)}</p>
    <p><strong>Marge brute:</strong> ${formatCurrency(data.totals.grossMargin)}</p>
    <p><strong>Paiements encaissés:</strong> ${formatCurrency(data.totals.paidAmount)}</p>
    <p><strong>Dépenses:</strong> ${formatCurrency(data.totals.totalExpenses)}</p>
    <p><strong>Autres entrées:</strong> ${formatCurrency(data.totals.totalRevenues)}</p>
    <p><strong>Solde journalier:</strong> ${formatCurrency(data.totals.netCash)}</p>
  `;
}

function showPage(page) {
  document.querySelectorAll('.page').forEach(section => {
    section.classList.toggle('hidden', section.id !== `${page}-page`);
  });
  document.querySelectorAll('#main-nav button').forEach(button => {
    button.classList.toggle('active', button.dataset.page === page);
  });
}

document.querySelectorAll('#main-nav button, .home-actions button').forEach(button => {
  button.addEventListener('click', () => showPage(button.dataset.page));
});

// Event listeners pour les boutons de filtre
document.querySelectorAll('.filter-btn').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');
    invoiceFilter = button.dataset.filter;
    invoicePage = 1;
    renderInvoicePage();
  });
});

document.getElementById('invoice-select').addEventListener('change', async event => {
  const invoiceId = event.target.value;
  const details = document.getElementById('invoice-details');
  if (!invoiceId) {
    details.innerHTML = '';
    return;
  }
  const invoice = await api(`/api/invoices?id=${invoiceId}`);
  if (!invoice || !invoice.invoice) {
    details.innerHTML = '<p>Aucune facture trouvée.</p>';
    return;
  }
  details.innerHTML = `
    <div class="item-card">
      <strong>Facture #${invoice.invoice.id}</strong>
      <p>Date: ${invoice.invoice.date}</p>
      <p>Client: ${invoice.invoice.client_name || 'Aucun client'}</p>
      <p>Vendeur: ${invoice.invoice.sold_by || '-'}</p>
      <p>Serveur: ${invoice.invoice.served_by || '-'}</p>
      <p>Total: ${formatCurrency(invoice.invoice.total)}</p>
      <p>Lignes:</p>
      <ul>${invoice.lines.map(line => `<li>${line.description} x${line.quantity} - ${formatCurrency(line.sell_price)} (total ${formatCurrency(line.line_total)})</li>`).join('')}</ul>
      <button type="button" id="print-selected-invoice-btn">Imprimer cette facture</button>
    </div>
  `;

  const printSelectedInvoiceBtn = document.getElementById('print-selected-invoice-btn');
  if (printSelectedInvoiceBtn) {
    printSelectedInvoiceBtn.addEventListener('click', () => {
      const receiptHtml = buildInvoiceReceiptHtml(invoice.invoice, invoice.lines);
      printInvoiceHtml(receiptHtml);
    });
  }
});

document.getElementById('summary-form').addEventListener('submit', showSummary);

function setTodayDate() {
  const today = new Date().toISOString().slice(0, 10);
  const invoiceDateInput = document.getElementById('invoice-date');
  const paymentDateInput = document.getElementById('payment-date');
  if (invoiceDateInput) invoiceDateInput.value = today;
  if (paymentDateInput) paymentDateInput.value = today;
}

function updateHomeDashboard() {
  const clientsNode = document.getElementById('home-metric-clients');
  const productsNode = document.getElementById('home-metric-products');
  const invoicesNode = document.getElementById('home-metric-invoices');
  const unpaidNode = document.getElementById('home-metric-unpaid');
  const todayLabel = document.getElementById('home-today-label');
  const note = document.getElementById('home-kpi-note');
  if (!clientsNode || !productsNode || !invoicesNode || !unpaidNode || !todayLabel || !note) return;

  const unpaidInvoices = invoices.filter(inv => !inv.isPaid);
  const unpaidTotal = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
  const sellerCount = staffCache.filter(member => member.role === 'vendeur').length;
  const serverCount = staffCache.filter(member => member.role === 'serveur').length;

  clientsNode.textContent = String(clientsCache.length);
  productsNode.textContent = String(products.length);
  invoicesNode.textContent = String(invoices.length);
  unpaidNode.textContent = String(unpaidInvoices.length);

  todayLabel.textContent = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
  note.textContent = `${unpaidInvoices.length} facture(s) impayee(s) pour ${formatCurrency(unpaidTotal)}. Equipe: ${sellerCount} vendeur(s), ${serverCount} serveur(se)(s).`;
}

async function initAuthenticatedApp() {
  if (!appBootstrapped) {
    addInvoiceLine();
    initInvoicePagination();
    appBootstrapped = true;
  }

  await loadClients();
  await loadProducts();
  try {
    await loadStaff();
  } catch (error) {
    console.warn('Échec du chargement du personnel :', error);
  }
  try {
    await loadUsers();
  } catch (error) {
    console.warn('Echec du chargement des users :', error);
  }
  await loadInvoices();
  setTodayDate();
  showPage('home');
}

async function refreshBootstrapStatus() {
  const box = document.getElementById('bootstrap-admin-box');
  try {
    const status = await publicApiRequest(['/api/bootstrap-status', '/bootstrap-status']);
    if (box) box.classList.toggle('hidden', status.hasUsers);
  } catch (error) {
    if (box) box.classList.remove('hidden');
  }
}

document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  try {
    const loginResult = await publicApiRequest(['/api/login', '/login'], {
      method: 'POST',
      body: JSON.stringify(data)
    });
    setAuthToken(loginResult.token);
    setLoginFeedback('');
    setAuthUi(true);
    await initAuthenticatedApp();
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('not found')) {
      setLoginFeedback('Route login introuvable. Redemarre le serveur backend.', true);
      return;
    }
    setLoginFeedback(error.message || 'Connexion impossible', true);
  }
});

document.getElementById('bootstrap-admin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target));
  payload.role = 'admin';
  try {
    const created = await publicApiRequest(['/api/bootstrap-admin', '/bootstrap-admin'], {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    setAuthToken(created.token);
    setBootstrapFeedback('Premier admin cree avec succes.');
    setAuthUi(true);
    await initAuthenticatedApp();
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('not found')) {
      setBootstrapFeedback('Route bootstrap introuvable. Redemarre le serveur backend.', true);
      return;
    }
    setBootstrapFeedback(error.message || 'Creation impossible', true);
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (error) {
    // Ignorer les erreurs de logout API, on force la deconnexion locale.
  }
  setAuthToken('');
  setAuthUi(false);
  setLoginFeedback('');
  await refreshBootstrapStatus();
});

async function initApp() {
  setAuthUi(false);
  await refreshBootstrapStatus();
  const token = getAuthToken();
  if (!token) return;

  try {
    await api('/api/session');
    setAuthUi(true);
    await initAuthenticatedApp();
  } catch (error) {
    setAuthToken('');
    setAuthUi(false);
    setLoginFeedback('Session expiree, reconnectez-vous.', true);
  }
}

initApp();


