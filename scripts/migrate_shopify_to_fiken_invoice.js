#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
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

function toOre(amountString) {
  return Math.round(toNumber(amountString || 0) * 100);
}

class ShopifyFikenInvoiceMigration {
  constructor(options) {
    this.options = options;
    this.vatRate = parseFloat(process.env.VAT_RATE || '0.25');
    this.bankAccount = process.env.BANK_ACCOUNT_CODE || '1920:10001';
    this.salesAccount = process.env.SALES_ACCOUNT_CODE || '3000';
    this.shippingAccount = process.env.SHIPPING_ACCOUNT_CODE || '3000';
    this.feeAccount = process.env.PAYMENT_FEE_ACCOUNT_CODE || null;
    this.feePercent = parseFloat(process.env.PAYMENT_FEE_PERCENT || '0');
    this.feeAmountFixed = parseInt(process.env.PAYMENT_FEE_AMOUNT_ORE || '0', 10) || 0;
    this.ordersPath = process.env.ORDERS_BACKUP_PATH
      || '/home/kau005/produktutvikling/ordrer_backup/2025/09';

    const apiToken = requireEnv('FIKEN_API_TOKEN');
    this.companySlug = requireEnv('FIKEN_COMPANY_SLUG');
    this.fiken = new FikenAPI(apiToken);
    this.customerCache = new Map();
  }

  loadOrders() {
    if (!fs.existsSync(this.ordersPath)) {
      throw new Error(`Orders directory not found: ${this.ordersPath}`);
    }
    const files = fs.readdirSync(this.ordersPath)
      .filter(file => file.startsWith('ordre_') && file.endsWith('.json'))
      .sort();

    const orders = [];
    for (const file of files) {
      try {
        const orderData = JSON.parse(fs.readFileSync(path.join(this.ordersPath, file), 'utf8'));
        orders.push(orderData);
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
      const nameParts = [order.customer?.first_name, order.customer?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();

      const customerPayload = {
        name: nameParts || order.customer?.company || 'Shopify Customer',
        email: order.customer?.email,
        customer: true,
        customerNumber: order.customer?.id ? `SHOP-${order.customer.id}` : undefined,
        address: order.billing_address ? {
          address1: order.billing_address.address1,
          postalCode: order.billing_address.zip,
          city: order.billing_address.city,
          country: order.billing_address.country_code || 'NO'
        } : undefined
      };

      console.log('✨ Creating new customer in Fiken...');
      customer = await this.fiken.createCustomer(this.companySlug, customerPayload);
      console.log(`✅ Created customer ${customer.name} (${customer.contactId})`);
    }

    this.customerCache.set(key, customer);
    return customer;
  }

  buildInvoiceLines(order) {
    const lines = [];

    for (const item of order.line_items || []) {
      const quantity = toNumber(item.quantity) || 1;
      const grossLineTotal = toNumber(item.price || '0') * quantity;
      const grossDiscount = toNumber(item.total_discount || '0');
      const grossPerUnit = quantity > 0
        ? (grossLineTotal - grossDiscount) / quantity
        : 0;
      const unitPrice = grossPerUnit > 0
        ? Math.max(Math.round((grossPerUnit / (1 + this.vatRate)) * 100), 0)
        : 0;

      lines.push({
        unitPrice,
        quantity,
        vatType: 'HIGH',
        incomeAccount: this.salesAccount,
        description: [item.title, item.variant_title].filter(Boolean).join(' - ') || 'Shopify product'
      });
    }

    for (const shipping of order.shipping_lines || []) {
      const gross = toNumber(shipping.price || '0');
      if (gross <= 0) {
        continue;
      }
      const unitPrice = Math.round((gross / (1 + this.vatRate)) * 100);
      lines.push({
        unitPrice,
        quantity: 1,
        vatType: 'HIGH',
        incomeAccount: this.shippingAccount,
        description: shipping.title || 'Shipping'
      });
    }

    return lines;
  }

  calculateTotals(invoicePayload) {
    let net = 0;
    let vat = 0;

    for (const line of invoicePayload.lines) {
      const lineNet = line.unitPrice * line.quantity;
      net += lineNet;
      vat += Math.round(lineNet * this.vatRate);
    }

    return {
      net,
      vat,
      gross: net + vat
    };
  }

  buildInvoicePayload(order, customerId) {
    const issueDate = (order.processed_at || order.created_at || new Date().toISOString()).split('T')[0];
    const dueDate = issueDate;

    const payload = {
      issueDate,
      dueDate,
      customerId,
      bankAccountCode: this.bankAccount,
      cash: false,
      yourReference: `Shopify #${order.order_number}`,
      lines: this.buildInvoiceLines(order)
    };

    const totals = this.calculateTotals(payload);
    const shopifyGross = toOre(order.total_price || order.current_total_price || '0');
    const delta = shopifyGross - totals.gross;

    return {
      payload,
      totals,
      shopifyGross,
      delta
    };
  }

  computeFee(totals) {
    let feeAmount = 0;

    if (this.feePercent > 0) {
      feeAmount += Math.round(totals.gross * this.feePercent);
    }

    if (this.feeAmountFixed > 0) {
      feeAmount += this.feeAmountFixed;
    }

    if (!this.feeAccount || feeAmount <= 0) {
      return null;
    }

    if (feeAmount >= totals.gross) {
      console.warn('⚠️  Computed fee exceeds or equals invoice total, ignoring fee configuration');
      return null;
    }

    return {
      amount: feeAmount,
      accountCode: this.feeAccount,
      description: 'Payment provider fee'
    };
  }

  async attemptInvoicePayment(invoiceId, paymentAmount, paymentDate, description, fee) {
    const variants = [];

    if (fee) {
      variants.push({
        paymentDate,
        amount: paymentAmount,
        accountCode: this.bankAccount,
        description,
        fee
      });

      variants.push({
        paymentDate,
        amount: paymentAmount,
        account: this.bankAccount,
        description,
        fee
      });
    } else {
      variants.push(
        {
          paymentDate,
          amount: paymentAmount,
          accountCode: this.bankAccount,
          description
        },
        {
          date: paymentDate,
          amount: paymentAmount,
          account: this.bankAccount,
          description
        },
        {
          paymentDate,
          amount: paymentAmount,
          account: this.bankAccount
        }
      );
    }

    for (const body of variants) {
      try {
        console.log(`→ Registering payment with payload: ${JSON.stringify(body)}`);
        const response = await this.fiken.addInvoicePayment(this.companySlug, invoiceId, body);
        console.log('✅ Payment registered');
        return response;
      } catch (error) {
        console.error(`⚠️  Payment attempt failed: ${error.message}`);
        if (error.response?.data) {
          console.error(`   Response: ${JSON.stringify(error.response.data)}`);
        }
      }
    }

    throw new Error('Unable to register payment via API');
  }

  getPaymentDate(order) {
    return (order.closed_at || order.processed_at || order.created_at || new Date().toISOString()).split('T')[0];
  }

  async migrateOrder(order) {
    console.log(`\n🧾 Processing Shopify order #${order.order_number}`);

    const customer = await this.getOrCreateCustomer(order);
    const customerId = customer.contactId || customer.customerId;
    if (!customerId) {
      throw new Error('Unable to resolve customerId for invoice');
    }

    const { payload, totals, shopifyGross, delta } = this.buildInvoicePayload(order, customerId);
    const paymentDate = this.getPaymentDate(order);

    console.log(`   Shopify total: ${(shopifyGross / 100).toFixed(2)} NOK`);
    console.log(`   Invoice total: ${(totals.gross / 100).toFixed(2)} NOK`);
    if (Math.abs(delta) > 2) {
      console.warn(`⚠️  Invoice and Shopify totals differ by ${(delta / 100).toFixed(2)} NOK`);
    }

    if (this.options.dryRun) {
      console.log('   Dry-run mode: skipping API calls');
      console.log(`   Invoice payload: ${JSON.stringify(payload)}`);
      return;
    }

    const invoice = await this.fiken.createInvoice(this.companySlug, payload);
    const invoiceId = invoice.invoiceId || invoice.invoiceNumber;
    console.log(`✅ Invoice created with ID ${invoiceId}`);

    const fee = this.computeFee(totals);
    if (fee) {
      console.log(`   Applying fee ${(fee.amount / 100).toFixed(2)} NOK on account ${fee.accountCode}`);
    }

    const paymentAmount = fee ? totals.gross - fee.amount : totals.gross;
    await this.attemptInvoicePayment(invoiceId, paymentAmount, paymentDate, `Shopify order #${order.order_number}`, fee);
  }

  async run() {
    const orders = this.loadOrders();
    const limit = this.options.limit && this.options.limit > 0
      ? Math.min(this.options.limit, orders.length)
      : orders.length;

    console.log(`🚀 Starting invoice migration for ${limit} orders${this.options.dryRun ? ' (dry-run)' : ''}`);

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

    console.log('\n🎉 Invoice migration completed');
  }
}

async function main() {
  loadEnvironment();
  const options = parseArgs(process.argv.slice(2));
  const migration = new ShopifyFikenInvoiceMigration(options);
  await migration.run();
}

main().catch(error => {
  console.error(`💥 Migration failed: ${error.message}`);
  if (error.stack) {
    console.error(error.stack.split('\n').slice(1).join('\n'));
  }
  process.exit(1);
});
