const dns = require('node:dns');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');
const pino = require('pino');

dns.setDefaultResultOrder('ipv4first');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const {
  initDb,
  getQueueMetrics,
  getCheckpointValue,
  enqueueOrder
} = require('../lib/db');
const {
  initProcessor
} = require('../lib/processor');
const FikenAPI = require('../lib/fiken');
const FikenSyncService = require('../lib/fikenSync');
const {
  getCompanies,
  getCustomers,
  getProducts,
  getInvoices,
  getAccounts,
  searchCustomers,
  searchProducts
} = require('../lib/fikenDb');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = Number(process.env.PORT || 8787);
const TEMP_DIR = process.env.LOCAL_TEMP_DIR || path.join('/var/tmp', 'protonord_shopify');

// Shopify webhook secret - same for all webhooks from the same store
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';

// Fiken API configuration
const FIKEN_API_TOKEN = process.env.FIKEN_API_TOKEN || '';
const FIKEN_API_BASE_URL = 'https://api.fiken.no/api/v2';

function createApp() {
  const app = express();
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  }));

  app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });

  app.get('/status', (_req, res) => {
    const queue = getQueueMetrics();
    const lastProcessedAt = getCheckpointValue('lastProcessedAt') || null;
    const lastProcessedGid = getCheckpointValue('lastProcessedGid') || null;
    const tempSummary = summariseTempDir(TEMP_DIR);

    const checkpoint = (lastProcessedAt || lastProcessedGid)
      ? { lastProcessedAt, lastProcessedGid }
      : null;

    res.json({
      uptime: process.uptime(),
      env: {
        SHOPIFY_SHOP: process.env.SHOPIFY_SHOP || null,
        LOCAL_TEMP_DIR: TEMP_DIR
      },
      checkpoint,
      checkpoints: checkpoint,
      queue,
      temp: tempSummary,
      version: '0.1.0'
    });
  });

  app.post('/webhooks/orders-paid', (req, res) => {
    if (!verifyShopifySignature(req, SHOPIFY_WEBHOOK_SECRET)) {
      return res.status(401).send('invalid signature');
    }

    try {
      const orderId = extractOrderId(req.body);
      if (orderId) {
        enqueueOrder(orderId);
        logger.info({ orderId }, 'Order enqueued from webhook');
      } else {
        logger.warn({ body: req.body }, 'Unable to determine order_id from webhook payload');
      }
      return res.status(202).json({ status: 'accepted' });
    } catch (err) {
      logger.error({ err }, 'Failed to enqueue order from webhook');
      return res.status(500).json({ status: 'error' });
    }
  });

  app.post('/webhooks/refunds-create', (req, res) => {
    if (!verifyShopifySignature(req, SHOPIFY_WEBHOOK_SECRET)) {
      return res.status(401).send('invalid signature');
    }

    logger.info({ refundId: req.body?.id }, 'Refund webhook received (processing pending)');
    return res.status(202).json({ status: 'accepted' });
  });

  app.post('/webhooks/orders-cancelled', (req, res) => {
    if (!verifyShopifySignature(req, SHOPIFY_WEBHOOK_SECRET)) {
      return res.status(401).send('invalid signature');
    }

    logger.info({ orderId: req.body?.id }, 'Order cancelled webhook received (processing pending)');
    return res.status(202).json({ status: 'accepted' });
  });

  // Fiken API endpoints
  const fikenAPI = new FikenAPI(FIKEN_API_TOKEN);

  app.get('/fiken/health', async (req, res) => {
    try {
      const health = await fikenAPI.healthCheck();
      return res.json(health);
    } catch (error) {
      logger.error({ error: error.message }, 'Fiken health check failed');
      return res.status(500).json({ status: 'error', error: error.message });
    }
  });

  app.get('/fiken/companies', async (req, res) => {
    try {
      const companies = await fikenAPI.getCompanies();
      return res.json(companies);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get companies');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/companies/:slug/customers', async (req, res) => {
    try {
      const customers = await fikenAPI.getCustomers(req.params.slug);
      return res.json(customers);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get customers');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/companies/:slug/products', async (req, res) => {
    try {
      const products = await fikenAPI.getProducts(req.params.slug);
      return res.json(products);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get products');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/companies/:slug/invoices', async (req, res) => {
    try {
      const options = {
        page: parseInt(req.query.page) || 0,
        pageSize: parseInt(req.query.pageSize) || 25
      };
      const invoices = await fikenAPI.getInvoices(req.params.slug, options);
      return res.json(invoices);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get invoices');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/companies/:slug/accounts', async (req, res) => {
    try {
      const accounts = await fikenAPI.getAccounts(req.params.slug);
      return res.json(accounts);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get accounts');
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/fiken/companies/:slug/customers', async (req, res) => {
    try {
      const customer = await fikenAPI.createCustomer(req.params.slug, req.body);
      return res.status(201).json(customer);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create customer');
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/fiken/companies/:slug/products', async (req, res) => {
    try {
      const product = await fikenAPI.createProduct(req.params.slug, req.body);
      return res.status(201).json(product);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create product');
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/fiken/companies/:slug/invoices', async (req, res) => {
    try {
      const invoice = await fikenAPI.createInvoice(req.params.slug, req.body);
      return res.status(201).json(invoice);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create invoice');
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/fiken/companies/:slug/invoices/counter', async (req, res) => {
    try {
      const result = await fikenAPI.setInvoiceCounter(req.params.slug, req.body);
      return res.json(result);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to set invoice counter');
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/fiken/companies/:slug/invoices/:invoiceId/send', async (req, res) => {
    try {
      const result = await fikenAPI.sendInvoice(req.params.slug, req.params.invoiceId);
      return res.json(result);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to send invoice');
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/fiken/companies/:slug/invoices/:invoiceId/payments', async (req, res) => {
    try {
      const payment = await fikenAPI.addInvoicePayment(req.params.slug, req.params.invoiceId, req.body);
      return res.status(201).json(payment);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to add payment to invoice');
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/fiken/companies/:slug/sales', async (req, res) => {
    try {
      const sale = await fikenAPI.createSale(req.params.slug, req.body);
      return res.status(201).json(sale);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create sale');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/companies/:slug/invoices/:invoiceId', async (req, res) => {
    try {
      const invoice = await fikenAPI.getInvoice(req.params.slug, req.params.invoiceId);
      return res.json(invoice);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get invoice');
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/fiken/companies/:slug/vouchers', async (req, res) => {
    try {
      const voucher = await fikenAPI.createVoucher(req.params.slug, req.body);
      return res.status(201).json(voucher);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to create voucher');
      return res.status(500).json({ error: error.message });
    }
  });

  // Fiken sync and local database endpoints
  const fikenSync = new FikenSyncService(FIKEN_API_TOKEN);

  app.post('/fiken/sync/all', async (req, res) => {
    try {
      const result = await fikenSync.syncAll();
      return res.json({ status: 'completed', result });
    } catch (error) {
      logger.error({ error: error.message }, 'Full sync failed');
      return res.status(500).json({ status: 'error', error: error.message });
    }
  });

  app.post('/fiken/sync/companies', async (req, res) => {
    try {
      const companies = await fikenSync.syncCompanies();
      return res.json({ status: 'completed', count: companies.length, companies });
    } catch (error) {
      logger.error({ error: error.message }, 'Company sync failed');
      return res.status(500).json({ status: 'error', error: error.message });
    }
  });

  app.post('/fiken/sync/companies/:slug/:dataType', async (req, res) => {
    try {
      const { slug, dataType } = req.params;
      let result;

      switch (dataType) {
        case 'customers':
          result = await fikenSync.syncCustomers(slug);
          break;
        case 'products':
          result = await fikenSync.syncProducts(slug);
          break;
        case 'invoices':
          result = await fikenSync.syncInvoices(slug);
          break;
        case 'accounts':
          result = await fikenSync.syncAccounts(slug);
          break;
        default:
          return res.status(400).json({ error: 'Invalid data type' });
      }

      return res.json({ status: 'completed', count: result });
    } catch (error) {
      logger.error({ error: error.message }, `${req.params.dataType} sync failed`);
      return res.status(500).json({ status: 'error', error: error.message });
    }
  });

  app.post('/fiken/sync/companies/:slug/incremental', async (req, res) => {
    try {
      const result = await fikenSync.incrementalSync(req.params.slug);
      return res.json({ status: 'completed', result });
    } catch (error) {
      logger.error({ error: error.message }, 'Incremental sync failed');
      return res.status(500).json({ status: 'error', error: error.message });
    }
  });

  app.get('/fiken/sync/status', async (req, res) => {
    try {
      const companySlug = req.query.company;
      const status = fikenSync.getSyncStatus(companySlug);
      return res.json(status);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get sync status');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/sync/health', async (req, res) => {
    try {
      const health = await fikenSync.healthCheck();
      return res.json(health);
    } catch (error) {
      logger.error({ error: error.message }, 'Sync health check failed');
      return res.status(500).json({ error: error.message });
    }
  });

  // Local database query endpoints
  app.get('/fiken/local/companies', (req, res) => {
    try {
      const companies = getCompanies();
      return res.json(companies);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get local companies');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/local/companies/:slug/customers', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const customers = getCustomers(req.params.slug, limit);
      return res.json(customers);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get local customers');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/local/companies/:slug/customers/search', (req, res) => {
    try {
      const query = req.query.q;
      if (!query) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }
      const customers = searchCustomers(req.params.slug, query);
      return res.json(customers);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to search customers');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/local/companies/:slug/products', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const products = getProducts(req.params.slug, limit);
      return res.json(products);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get local products');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/local/companies/:slug/products/search', (req, res) => {
    try {
      const query = req.query.q;
      if (!query) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }
      const products = searchProducts(req.params.slug, query);
      return res.json(products);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to search products');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/local/companies/:slug/invoices', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 100;
      const invoices = getInvoices(req.params.slug, limit);
      return res.json(invoices);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get local invoices');
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/fiken/local/companies/:slug/accounts', (req, res) => {
    try {
      const accounts = getAccounts(req.params.slug);
      return res.json(accounts);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get local accounts');
      return res.status(500).json({ error: error.message });
    }
  });

  return app;
}

function verifyShopifySignature(req, webhookSecret) {
  if (!webhookSecret) {
    logger.warn('Webhook secret not configured; rejecting webhook');
    return false;
  }
  const signature = req.get('x-shopify-hmac-sha256') || '';
  const generated = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('base64');
  const generatedBuf = Buffer.from(generated, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (generatedBuf.length !== signatureBuf.length) {
    logger.warn('Shopify webhook signature length mismatch');
    return false;
  }
  const valid = crypto.timingSafeEqual(generatedBuf, signatureBuf);
  if (!valid) {
    logger.warn({ signature }, 'Shopify webhook signature verification failed');
  }
  return valid;
}

function extractOrderId(payload) {
  if (!payload) return null;
  const candidates = [
    payload.id,
    payload.order_id,
    payload?.order?.id,
    payload?.admin_graphql_api_id
  ].filter(Boolean);
  for (const value of candidates) {
    const numeric = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }
  return null;
}

function summariseTempDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const summary = entries.reduce((acc, entry) => {
      if (!entry.isFile()) return acc;
      acc.total += 1;
      if (entry.name.endsWith('.json')) acc.json += 1;
      if (entry.name.endsWith('.pdf')) acc.pdf += 1;
      return acc;
    }, { total: 0, json: 0, pdf: 0 });
    return summary;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { total: 0, json: 0, pdf: 0, note: 'directory-not-found' };
    }
    logger.warn({ err }, 'Failed to summarise temp directory');
    return { error: err.message };
  }
}

function start() {
  try {
    initDb();
    logger.info('SQLite database initialised');
  } catch (err) {
    logger.error({ err }, 'Failed to initialise database');
    process.exit(1);
  }

  const app = createApp();
  app.locals.logger = logger;

  if (process.env.DISABLE_PROCESSOR === 'true') {
    logger.warn('Order processor disabled via DISABLE_PROCESSOR=true');
  } else {
    initProcessor(logger);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT, host: '0.0.0.0' }, 'Settlement service listening');
  });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = {
  createApp,
  start,
  verifyShopifySignature,
  extractOrderId
};
