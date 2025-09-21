#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const PDFDocument = require('pdfkit');
const FikenAPI = require('../src/fiken.js');

function loadEnvironment() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

function parseArgs(argv) {
  const options = { dryRun: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--limit' && argv[i + 1]) {
      options.limit = parseInt(argv[i + 1], 10);
      i += 1;
    }
  }
  return options;
}

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toOre(amount) {
  return Math.round(toNumber(amount) * 100);
}

class ShopifyFikenExternalSaleMigration {
  constructor(options) {
    this.options = options;

    this.vatRate = parseFloat(process.env.VAT_RATE || '0.25');
    this.bankAccount = process.env.BANK_ACCOUNT_CODE || '1920:10001';
    this.salesAccount = process.env.SALES_ACCOUNT_CODE || '3000';
    this.shippingAccount = process.env.SHIPPING_ACCOUNT_CODE || this.salesAccount;
    this.feeAccount = process.env.PAYMENT_FEE_ACCOUNT_CODE || '7770';
    this.feePercent = parseFloat(process.env.PAYMENT_FEE_PERCENT || '0');
    this.feeAmountFixed = parseInt(process.env.PAYMENT_FEE_AMOUNT_ORE || '0', 10) || 0;
    this.ordersPath = process.env.ORDERS_BACKUP_PATH || '/home/kau005/produktutvikling/ordrer_backup/2025/09';

    const apiToken = requireEnv('FIKEN_API_TOKEN');
    this.companySlug = requireEnv('FIKEN_COMPANY_SLUG');
    this.fiken = new FikenAPI(apiToken);
    this.customerCache = new Map();
  }

  loadShopifyOrders() {
    if (!fs.existsSync(this.ordersPath)) {
      throw new Error(`Orders directory not found: ${this.ordersPath}`);
    }

    const files = fs.readdirSync(this.ordersPath)
      .filter(file => file.startsWith('ordre_') && file.endsWith('.json'))
      .sort();

    const orders = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.ordersPath, file), 'utf8'));
        orders.push(data);
      } catch (error) {
        console.warn(`⚠️  Failed to read order file ${file}: ${error.message}`);
      }
    }

    const paidOrders = orders.filter(order => order.financial_status === 'paid');
    console.log(`📦 Loaded ${paidOrders.length} paid orders (${orders.length} total)`);
    return paidOrders;
  }

  getCustomerKey(order) {
    return order.customer?.email?.toLowerCase() || `order-${order.id}`;
  }

  async getOrCreateCustomer(order) {
    const key = this.getCustomerKey(order);
    if (this.customerCache.has(key)) {
      return this.customerCache.get(key);
    }

    const email = order.customer?.email;
    let customer = null;

    if (email) {
      try {
        const customers = await this.fiken.getCustomers(this.companySlug);
        customer = customers.find(entry => entry.email?.toLowerCase() === email.toLowerCase()) || null;
        if (customer) {
          console.log(`👤 Found existing customer ${customer.name} (${customer.contactId})`);
        }
      } catch (error) {
        console.warn(`⚠️  Unable to list customers: ${error.message}`);
      }
    }

    if (!customer) {
      const name = `${order.customer?.first_name || order.shipping_address?.first_name || ''} ${order.customer?.last_name || order.shipping_address?.last_name || ''}`.trim() || order.customer?.company || order.shipping_address?.name || 'Shopify Customer';
      const payload = {
        name,
        email: order.customer?.email,
        customer: true,
        address: order.billing_address ? {
          address1: order.billing_address.address1,
          postalCode: order.billing_address.zip,
          city: order.billing_address.city,
          country: order.billing_address.country_code || 'NO'
        } : undefined
      };
      if (!payload.address) {
        delete payload.address;
      }

      console.log('✨ Creating new customer in Fiken...');
      customer = await this.fiken.createCustomer(this.companySlug, payload);
      console.log(`✅ Created customer ${customer.name} (${customer.contactId})`);
    }

    this.customerCache.set(key, customer);
    return customer;
  }

  async findSaleByNumber(saleNumber) {
    try {
      const sales = await this.fiken.request('GET', `/companies/${this.companySlug}/sales`, {
        saleNumber,
        pageSize: 1
      });
      return Array.isArray(sales) && sales.length > 0 ? sales[0] : null;
    } catch (error) {
      console.warn(`⚠️  Unable to search sale ${saleNumber}: ${error.message}`);
      return null;
    }
  }

  buildSaleLines(order) {
    const lines = [];

    for (const item of order.line_items || []) {
     const quantity = toNumber(item.quantity) || 1;
     const unitGross = toNumber(item.price || item.price_set?.shop_money?.amount || 0);
     const grossPerUnitOre = Math.round(unitGross * 100);
     const netPerUnitOre = Math.round(grossPerUnitOre / (1 + this.vatRate));
     const vatPerUnitOre = grossPerUnitOre - netPerUnitOre;
      const lineNet = netPerUnitOre * quantity;
      const lineVat = vatPerUnitOre * quantity;

      lines.push({
        description: item.title || 'Shopify product',
        account: this.salesAccount,
        vatType: 'HIGH',
        netPrice: lineNet,
        netAmount: lineNet,
        vat: lineVat,
        vatAmount: lineVat,
        quantity: 1
      });
    }

    for (const shipping of order.shipping_lines || []) {
      const gross = toNumber(shipping.price || shipping.price_set?.shop_money?.amount || 0);
      if (gross <= 0) {
        continue;
      }
      const grossOre = Math.round(gross * 100);
      const netOre = Math.round(grossOre / (1 + this.vatRate));
      const vatOre = grossOre - netOre;

      lines.push({
        description: shipping.title || 'Shipping',
        account: this.shippingAccount,
        vatType: 'HIGH',
        netPrice: netOre,
        netAmount: netOre,
        vat: vatOre,
        vatAmount: vatOre,
        quantity: 1
      });
    }

    return lines;
  }

  calculateTotals(lines) {
    let net = 0;
    let vat = 0;
    lines.forEach(line => {
      net += line.netAmount;
      vat += line.vatAmount;
    });
    return {
      net,
      vat,
      gross: net + vat
    };
  }

  computeFeeAmount(gross) {
    let fee = this.feeAmountFixed;
    if (this.feePercent > 0) {
      fee += Math.round(gross * this.feePercent);
    }
    if (fee >= gross) {
      console.warn('⚠️  Computed fee exceeds gross amount, ignoring fee.');
      return 0;
    }
    return fee;
  }

  async migrateOrder(order) {
    const saleNumber = `#${order.order_number || order.id}`;
    console.log(`\n🧾 Processing Shopify order #${order.order_number} (${saleNumber})`);

    const customer = await this.getOrCreateCustomer(order);
    const customerId = customer.contactId || customer.customerId;
    if (!customerId) {
      throw new Error('Unable to resolve customerId for sale');
    }

    const lines = this.buildSaleLines(order);
    if (!lines.length) {
      throw new Error('Order has no billable lines');
    }

    const totals = this.calculateTotals(lines);
    const shopifyGross = toOre(order.total_price || order.current_total_price || (totals.gross / 100));

    console.log(`   Net: ${(totals.net / 100).toFixed(2)} NOK, VAT: ${(totals.vat / 100).toFixed(2)} NOK, Gross: ${(totals.gross / 100).toFixed(2)} NOK`);

    if (Math.abs(shopifyGross - totals.gross) > 2) {
      console.warn(`⚠️  Sale totals differ from Shopify by ${(shopifyGross - totals.gross) / 100} NOK`);
    }

    const saleDate = (order.processed_at || order.created_at || new Date().toISOString()).split('T')[0];

    const salePayload = {
      kind: 'external_invoice',
      saleNumber,
      date: saleDate,
      currency: 'NOK',
      customerId,
      lines: lines.map(line => ({
        description: line.description,
        account: line.account,
        vatType: line.vatType,
        netPrice: line.netPrice,
        netAmount: line.netAmount,
        vat: line.vat,
        vatAmount: line.vatAmount,
        quantity: line.quantity
      }))
    };

    if (this.options.dryRun) {
      console.log('   Dry-run: would create sale with payload');
      console.log(JSON.stringify(salePayload, null, 2));
      return;
    }

    const existingSale = await this.findSaleByNumber(saleNumber);
    if (existingSale) {
      console.log(`ℹ️  Sale ${saleNumber} already exists (saleId ${existingSale.saleId}), skipping creation.`);

      const needsAttachment = !(existingSale.saleAttachments || []).some(att => att.downloadUrl?.includes(`shopify-order-${order.order_number || order.id}.pdf`));
      if (needsAttachment) {
        try {
          const pdfBuffer = await generateOrderPdf(order, {
            saleNumber,
            saleDate,
            netAmount: totals.net,
            vatAmount: totals.vat,
            grossAmount: totals.gross,
            bankPaymentAmount: totals.gross,
            feeAmount: this.computeFeeAmount(totals.gross)
          });
          const filename = `shopify-order-${order.order_number || order.id}.pdf`;
          await this.fiken.attachFileToSale(this.companySlug, existingSale.saleId, pdfBuffer, {
            filename,
            description: `Shopify order #${order.order_number || order.id}`
          });
          console.log(`   Attached order summary ${filename} to existing sale`);
        } catch (error) {
          console.error(`⚠️  Failed to attach order summary to existing sale: ${error.message}`);
        }
      }

      return;
    }

    const sale = await this.fiken.createSale(this.companySlug, salePayload);
    const saleId = sale.saleId;
    console.log(`✅ Sale created with ID ${saleId}`);

    const feeAmount = this.computeFeeAmount(totals.gross);
    const bankPaymentAmount = feeAmount > 0 ? totals.gross - feeAmount : totals.gross;

    if (bankPaymentAmount > 0) {
      await this.fiken.addSalePayment(this.companySlug, saleId, {
        date: saleDate,
        account: this.bankAccount,
        amount: bankPaymentAmount
      });
      console.log(`   Registered bank payment ${(bankPaymentAmount / 100).toFixed(2)} NOK`);
    }

    if (feeAmount > 0) {
      await this.fiken.addSalePayment(this.companySlug, saleId, {
        date: saleDate,
        account: this.feeAccount,
        amount: feeAmount
      });
      console.log(`   Registered fee ${(feeAmount / 100).toFixed(2)} NOK on ${this.feeAccount}`);
    }

    try {
      const pdfBuffer = await generateOrderPdf(order, {
        saleNumber,
        saleDate,
        netAmount: totals.net,
        vatAmount: totals.vat,
        grossAmount: totals.gross,
        bankPaymentAmount,
        feeAmount
      });
      const filename = `shopify-order-${order.order_number || order.id}.pdf`;
      await this.fiken.attachFileToSale(this.companySlug, saleId, pdfBuffer, {
        filename,
        description: `Shopify order #${order.order_number || order.id}`
      });
      console.log(`   Attached order summary ${filename}`);
    } catch (error) {
      console.error(`⚠️  Failed to attach order summary: ${error.message}`);
    }
  }

  async run() {
    const orders = this.loadShopifyOrders();
    const limit = this.options.limit && this.options.limit > 0
      ? Math.min(this.options.limit, orders.length)
      : orders.length;

    console.log(`🚀 Starting external sale migration for ${limit} orders${this.options.dryRun ? ' (dry-run)' : ''}`);

    for (let index = 0; index < limit; index += 1) {
      const order = orders[index];
      try {
        await this.migrateOrder(order);
      } catch (error) {
        console.error(`❌ Failed to migrate order #${order.order_number}: ${error.message}`);
        if (error.response?.data) {
          console.error(`   Response: ${JSON.stringify(error.response.data)}`);
        }
      }
    }

    console.log('\n🎉 External sale migration completed');
  }
}

function generateOrderPdf(order, context) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const orderNumber = order.order_number || order.name || order.id;

    doc.fontSize(18).text(`Shopify Order #${orderNumber}`, { underline: true });
    doc.moveDown();

    doc.fontSize(12);
    doc.text(`Order ID: ${order.id}`);
    doc.text(`Order Date: ${order.created_at || context.saleDate}`);
    doc.text(`Processed At: ${order.processed_at || 'n/a'}`);
    doc.text(`Financial Status: ${order.financial_status || 'n/a'}`);
    doc.text(`Fulfillment Status: ${order.fulfillment_status || 'n/a'}`);
    doc.moveDown();

    const customerName = `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim();
    doc.text('Customer');
    doc.text(customerName || order.customer?.company || 'Unknown customer');
    if (order.customer?.email) {
      doc.text(order.customer.email);
    }
    if (order.billing_address) {
      const addr = order.billing_address;
      const lines = [addr.address1, addr.address2, `${addr.zip || ''} ${addr.city || ''}`.trim(), addr.country || addr.country_code];
      lines.filter(Boolean).forEach(line => doc.text(line));
    }
    doc.moveDown();

    doc.text('Line Items');
    (order.line_items || []).forEach(item => {
      const title = item.title || 'Item';
      const quantity = item.quantity || 1;
      const price = item.price || item.base_price || '0.00';
      doc.text(`• ${quantity} × ${title} @ ${price} ${order.currency || 'NOK'}`);
    });
    doc.moveDown();

    if (order.shipping_lines?.length) {
      doc.text('Shipping');
      order.shipping_lines.forEach(line => {
        doc.text(`• ${line.title || 'Shipping'}: ${line.price || '0.00'} ${order.currency || 'NOK'}`);
      });
      doc.moveDown();
    }

    doc.text('Totals');
    doc.text(`Net amount: ${(context.netAmount / 100).toFixed(2)} NOK`);
    doc.text(`VAT amount: ${(context.vatAmount / 100).toFixed(2)} NOK`);
    doc.text(`Recorded sale gross: ${(context.grossAmount / 100).toFixed(2)} NOK`);
    doc.text(`Shopify total: ${order.total_price || `${(context.grossAmount / 100).toFixed(2)} NOK`}`);
    doc.text(`Bank payment: ${(context.bankPaymentAmount / 100).toFixed(2)} NOK`);
    if (context.feeAmount > 0) {
      doc.text(`Fee: ${(context.feeAmount / 100).toFixed(2)} NOK`);
    }

    doc.moveDown();
    doc.text('Additional data');
    doc.text(`Discounts: ${order.total_discounts || '0.00'} ${order.currency || 'NOK'}`);
    doc.text(`Total tax (Shopify): ${order.total_tax || '0.00'} ${order.currency || 'NOK'}`);

    doc.moveDown();
    doc.text('Payment Summary');
    doc.text(`• Bank account ${context.bankPaymentAmount > 0 ? (context.bankPaymentAmount / 100).toFixed(2) : '0.00'} NOK`);
    if (context.feeAmount > 0) {
      doc.text(`• Fee account ${(context.feeAmount / 100).toFixed(2)} NOK`);
    }

    doc.moveDown();
    doc.text('Raw Shopify JSON (truncated)');
    const jsonSnippet = JSON.stringify(order, null, 2).slice(0, 4000);
    doc.font('Courier').fontSize(9).text(jsonSnippet);

    doc.end();
  });
}

(async () => {
  loadEnvironment();
  const options = parseArgs(process.argv.slice(2));
  const migration = new ShopifyFikenExternalSaleMigration(options);
  await migration.run();
})();
