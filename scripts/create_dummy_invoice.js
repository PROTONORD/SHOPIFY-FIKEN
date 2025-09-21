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

async function ensureDummyCustomer(fiken, companySlug, options) {
  const { name, email, customerNumber } = options;

  try {
    return await fiken.createCustomer(companySlug, {
      name,
      email,
      customer: true,
      customerNumber
    });
  } catch (error) {
    if (error.response?.status === 409 || error.response?.status === 400) {
      console.log('ℹ️  Customer already exists, attempting to look it up...');
      const customers = await fiken.getCustomers(companySlug);
      const existing = customers.find(c => c.email?.toLowerCase() === email.toLowerCase());
      if (existing) {
        console.log(`✅ Reusing existing customer ${existing.name} (${existing.contactId})`);
        return existing;
      }
    }
    throw error;
  }
}

function buildDummyInvoicePayload(customerId, accounts) {
  const today = new Date().toISOString().split('T')[0];
  const orderRef = `DUMMY-${today.replace(/-/g, '')}`;

  return {
    issueDate: today,
    dueDate: today,
    customerId,
    bankAccountCode: accounts.bank,
    cash: false,
    lines: [
      {
        unitPrice: 10000,
        quantity: 1,
        vatType: 'HIGH',
        incomeAccount: accounts.sales,
        description: 'Dummy Shopify product'
      },
      {
        unitPrice: 2500,
        quantity: 1,
        vatType: 'HIGH',
        incomeAccount: accounts.shipping,
        description: 'Dummy Shopify shipping'
      }
    ],
    ourReference: 'Shopify Integration',
    yourReference: orderRef
  };
}

function calculateInvoiceTotal(invoicePayload) {
  return invoicePayload.lines.reduce((sum, line) => {
    const net = line.unitPrice * line.quantity;
    const vat = Math.round(net * 0.25);
    return sum + net + vat;
  }, 0);
}

async function attemptInvoicePayment(fiken, companySlug, invoiceId, amount, bankAccount, options = {}) {
  const today = new Date().toISOString().split('T')[0];
  const { fee = null } = options;

  const paymentAmount = fee && fee.amount > 0
    ? Math.max(amount - fee.amount, 0)
    : amount;

  const variants = [];

  if (fee && fee.amount > 0) {
    variants.push({
      paymentDate: today,
      amount: paymentAmount,
      accountCode: bankAccount,
      description: 'Dummy payment with fee registered via API',
      fee
    });

    variants.push({
      paymentDate: today,
      amount: paymentAmount,
      account: bankAccount,
      description: 'Dummy payment with fee registered via API',
      fee
    });
  } else {
    variants.push(
      {
        paymentDate: today,
        amount: paymentAmount,
        accountCode: bankAccount,
        description: 'Dummy payment registered via API'
      },
      {
        date: today,
        amount: paymentAmount,
        account: bankAccount,
        description: 'Dummy payment registered via API'
      },
      {
        paymentDate: today,
        amount: paymentAmount,
        account: bankAccount
      }
    );
  }

  for (const variant of variants) {
    try {
      console.log(`→ Attempting payment payload: ${JSON.stringify(variant)}`);
      const response = await fiken.addInvoicePayment(companySlug, invoiceId, variant);
      console.log('✅ Payment registered with payload variant');
      return response;
    } catch (error) {
      console.error(`⚠️  Payment attempt failed: ${error.message}`);
      if (error.response?.data) {
        console.error('   Response:', JSON.stringify(error.response.data));
      }
    }
  }

  throw new Error('All payment payload variants failed');
}

async function main() {
  loadEnvironment();

  const apiToken = requireEnv('FIKEN_API_TOKEN');
  const companySlug = requireEnv('FIKEN_COMPANY_SLUG');

  const accounts = {
    bank: process.env.BANK_ACCOUNT_CODE || '1920:10001',
    sales: process.env.SALES_ACCOUNT_CODE || '3000',
    vat: process.env.VAT_ACCOUNT_CODE || '2701',
    shipping: process.env.SHIPPING_ACCOUNT_CODE || '3000'
  };

  const fiken = new FikenAPI(apiToken);

  console.log('🧪 Creating dummy customer...');
  const customer = await ensureDummyCustomer(fiken, companySlug, {
    name: 'Dummy Shopify Customer',
    email: 'dummy-shopify@example.com',
    customerNumber: 'SHOP-DUMMY'
  });

  const customerId = customer.contactId || customer.customerId;
  if (!customerId) {
    throw new Error('Unable to determine customerId for dummy customer');
  }

  console.log(`✅ Using customer ${customer.name} (${customerId})`);

  console.log('🧾 Creating dummy invoice...');
  const invoicePayload = buildDummyInvoicePayload(customerId, accounts);
  const invoice = await fiken.createInvoice(companySlug, invoicePayload);

  const invoiceId = invoice.invoiceId || invoice.invoiceNumber;
  console.log(`✅ Dummy invoice created with ID ${invoiceId}`);

  const invoiceTotal = calculateInvoiceTotal(invoicePayload);
  console.log(`   Calculated invoice total (inkl. MVA): ${(invoiceTotal / 100).toFixed(2)} NOK`);

  console.log('💳 Attempting to register payment to close invoice...');
  const feeAccount = process.env.PAYMENT_FEE_ACCOUNT_CODE;
  const feeAmount = parseInt(process.env.DUMMY_PAYMENT_FEE_AMOUNT || '0', 10);
  let fee = null;

  if (feeAccount && feeAmount > 0) {
    if (feeAmount >= invoiceTotal) {
      throw new Error('Configured fee amount exceeds or equals invoice total');
    }

    fee = {
      amount: feeAmount,
      accountCode: feeAccount,
      description: 'Dummy payment provider fee'
    };

    console.log(`   Applying dummy fee ${(fee.amount / 100).toFixed(2)} NOK to account ${fee.accountCode}`);
  }

  try {
    await attemptInvoicePayment(fiken, companySlug, invoiceId, invoiceTotal, accounts.bank, { fee });
  } catch (paymentError) {
    console.error('❌ Unable to register payment via API');
    console.error(paymentError.message);
    console.error('You may need to close the invoice via journal entry or investigate payment endpoint.');
  }

  console.log('\n🎉 Dummy invoice workflow completed');
}

main().catch(error => {
  console.error('💥 Dummy invoice workflow failed:', error.message);
  if (error.stack) {
    console.error(error.stack.split('\n').slice(1).join('\n'));
  }
  process.exit(1);
});
