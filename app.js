const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const path = require('path');

const dotenv = require('dotenv');
dotenv.config({ quiet: true });

const app = express();
const http = require('http');

// const { config } = require('process');
const server = http.createServer(app);

const io = new Server(server); // bind socket.io to the same server

// serve static files if needed
app.use(express.static('public'));

const port = process.env.PORT || 3000;

// Configure PostgreSQL

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT,
});

// Middleware
app.use(bodyParser.json());
app.set('view engine', 'ejs');


let updatePending = false;
let debounceTimer = null;
let lastEmitTime = Date.now();
let lastUpdateTime = null;

// Called whenever /incoming receives a new value
function scheduleEmit() {
  updatePending = true;
  lastUpdateTime = Date.now();

  // Reset debounce timer: emit if quiet for 10s
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateTime;

    if (timeSinceLastUpdate >= 10_000 && updatePending) {
      emitLatestPrices();
    }
  }, 10_000);
}

// Force emit after 30s no matter what
setInterval(() => {
  const now = Date.now();
  const timeSinceLastEmit = now - lastEmitTime;

  if (updatePending && timeSinceLastEmit >= 30_000) {
    emitLatestPrices();
  }
}, 5_000);

// Do the actual emit
function emitLatestPrices() {
  updatePending = false;
  lastEmitTime = Date.now();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  getLatestPrices().then(latestData => {
    io.emit('priceUpdateBatch', latestData);
  }).catch(console.error);
}



async function getLatestPrices(productId = null) {
  const values = [];
  let whereClause = '';

  if (productId) {
    whereClause = 'WHERE product_id = $1';
    values.push(productId);
  }

  const query = `
    SELECT DISTINCT ON (product_id, store_id)
      prt.store_id,
      prt.product_id,
      price,
      timestamp,
      s.name as store_name,
      s.url as store_url,
      p.name as product_name,
      sp.url as product_url
    FROM troy_prices_real_time prt
    JOIN troy_stores s ON s.id = prt.store_id
    JOIN troy_products p ON p.id = prt.product_id
    JOIN troy_store_products sp ON sp.store_id = prt.store_id and sp.product_id = prt.product_id
    ${whereClause}
    ORDER BY product_id, store_id, timestamp DESC
  `;

  const result = await pool.query(query, values);

  // separate this out into products
  const products = result.rows.reduce((acc, item) => {
    if (!acc[item.product_id]) {
      acc[item.product_id] = [];
    }
    acc[item.product_id].push(item);
    return acc;
  }, {});

  // Now sort each group by price
  Object.values(products).forEach(group => {
    group.sort((a, b) => a.price - b.price); // ascending order
  });

  console.log(products);
  return products;
}



// POST /incoming - Add items to a table
app.post('/incoming', async (req, res) => {
  const { c,t,s,p,v } = req.body;

  if (!c || !t || !s || !p || v == null) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    await pool.query('INSERT INTO troy_prices_real_time (timestamp, store_id, product_id, source_id, price) VALUES ($1, $2, $3, $4, $5)', [t,s,p,c,v]);
    console.log('UPDATED: ', [t,s,p,c,v]);
    updatePending = true;
    scheduleEmit();

    res.json({ message: 'Item added successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});


// GET /prices - Return all items
app.get('/prices', async (req, res) => {
  const { p } = req.query;

  try {
    const rows = await getLatestPrices(p);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});


// GET /index - Render prices as HTML
app.get('/', async (req, res) => {
  try {
    const products = await getLatestPrices();
    res.render('index', {products: products});
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading index');
  }
});

server.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
