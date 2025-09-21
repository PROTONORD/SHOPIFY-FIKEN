#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
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

function toOre(amount) {
  return Math.round(parseFloat(amount) * 100);
}

async function main() {
  loadEnvironment();

  const apiToken = requireEnv('FIKEN_API_TOKEN');
  const companySlug = requireEnv('FIKEN_COMPANY_SLUG');

  const productNet = toOre(process.env.EXTERNAL_SALE_NET || '8');
  const feeAmount = toOre(process.env.EXTERNAL_SALE_FEE || '2');
  const saleNumber = process.env.EXTERNAL_SALE_NUMBER || `SHOP-${Date.now()}`;
  const customerId = process.env.EXTERNAL_SALE_CUSTOMER_ID || '7839799180';
  const description = process.env.EXTERNAL_SALE_DESCRIPTION || 'Test produkt API';
  const saleDate = process.env.EXTERNAL_SALE_DATE || new Date().toISOString().split('T')[0];
  const bankAccount = process.env.EXTERNAL_SALE_BANK_ACCOUNT || process.env.BANK_ACCOUNT_CODE || '1920:10001';
  const feeAccount = process.env.EXTERNAL_SALE_FEE_ACCOUNT || process.env.PAYMENT_FEE_ACCOUNT_CODE || '7770';
  const incomeAccount = process.env.EXTERNAL_SALE_INCOME_ACCOUNT || process.env.SALES_ACCOUNT_CODE || '3010';

  const fiken = new FikenAPI(apiToken);

  const vatAmount = Math.round(productNet * 0.25);
  const grossAmount = productNet + vatAmount;

  console.log(`🧾 Creating external sale ${saleNumber}`);
  console.log(`   Net: ${(productNet / 100).toFixed(2)} NOK, VAT: ${(vatAmount / 100).toFixed(2)} NOK, Gross: ${(grossAmount / 100).toFixed(2)} NOK`);
  console.log(`   Customer ID: ${customerId}`);

  const salePayload = {
    kind: 'external_invoice',
    saleNumber,
    date: saleDate,
    currency: 'NOK',
    customerId: Number(customerId),
    lines: [
      {
        description,
        account: incomeAccount,
        vatType: 'HIGH',
        netPrice: productNet,
        netAmount: productNet,
        vat: vatAmount,
        vatAmount,
        quantity: 1
      }
    ]
  };

  const sale = await fiken.createSale(companySlug, salePayload);
  const saleId = sale.saleId;
  console.log(`✅ Sale created with ID ${saleId}`);

  const bankPaymentAmount = feeAmount > 0 ? Math.max(grossAmount - feeAmount, 0) : grossAmount;

  if (bankPaymentAmount > 0) {
    console.log(`💳 Registering payment ${(bankPaymentAmount / 100).toFixed(2)} NOK to bank account ${bankAccount}`);
    await fiken.addSalePayment(companySlug, saleId, {
      date: saleDate,
      account: bankAccount,
      amount: bankPaymentAmount
    });
  }

  if (feeAmount > 0) {
    console.log(`💸 Registering fee ${(feeAmount / 100).toFixed(2)} NOK on account ${feeAccount}`);
    await fiken.addSalePayment(companySlug, saleId, {
      date: saleDate,
      account: feeAccount,
      amount: feeAmount
    });
  }

  const updatedSale = await fiken.request('GET', `/companies/${companySlug}/sales/${saleId}`);
  console.log('📊 Final sale status:', JSON.stringify({
    saleId: updatedSale.saleId,
    saleNumber: updatedSale.saleNumber,
    netAmount: updatedSale.netAmount,
    vatAmount: updatedSale.vatAmount,
    totalPaid: updatedSale.totalPaid,
    settled: updatedSale.settled,
    salePayments: updatedSale.salePayments
  }, null, 2));

  const orderFile = process.env.EXTERNAL_SALE_ORDER_FILE;
  if (orderFile) {
    if (!fs.existsSync(orderFile)) {
      console.warn(`⚠️  Order file not found: ${orderFile}`);
      return;
    }

    try {
      const order = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
      const pdfBuffer = await generateOrderPdf(order, {
        saleNumber,
        saleDate,
        bankPaymentAmount,
        feeAmount,
        grossAmount,
        netAmount: productNet,
        vatAmount
      });

      const filename = `shopify-order-${order.order_number || saleNumber}.pdf`;
      await fiken.attachFileToSale(companySlug, saleId, pdfBuffer, {
        filename,
        description: `Shopify order #${order.order_number || order.name || order.id}`
      });
      console.log(`📎 Attached Shopify order details as ${filename}`);
    } catch (error) {
      console.error('⚠️  Failed to attach Shopify order details:', error.message);
    }
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
      const addressLines = [addr.address1, addr.address2, `${addr.zip || ''} ${addr.city || ''}`.trim(), addr.country || addr.country_code];
      addressLines.filter(Boolean).forEach(line => doc.text(line));
    }
    doc.moveDown();

    doc.text('Line Items');
    (order.line_items || []).forEach(item => {
      const title = item.title || 'Item';
      const quantity = item.quantity || 1;
      const price = item.price || item.total || '0.00';
      const sku = item.sku ? ` (SKU: ${item.sku})` : '';
      doc.text(`• ${quantity} × ${title}${sku} @ ${price} ${order.currency || 'NOK'}`);
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
    doc.text(`Shopify total: ${order.total_price || `${(context.grossAmount / 100).toFixed(2)} NOK`}`);
    doc.text(`Recorded sale gross: ${(context.grossAmount / 100).toFixed(2)} NOK`);
    doc.text(`Bank payment: ${(context.bankPaymentAmount / 100).toFixed(2)} NOK`);
    if (context.feeAmount > 0) {
      doc.text(`Fee: ${(context.feeAmount / 100).toFixed(2)} NOK`);
    }

    doc.moveDown();
    doc.text('Payment Details');
    doc.text(`• Bank account: ${(context.bankPaymentAmount / 100).toFixed(2)} NOK`);
    if (context.feeAmount > 0) {
      doc.text(`• Fee account: ${(context.feeAmount / 100).toFixed(2)} NOK`);
    }

    doc.moveDown();
    doc.text('Raw Shopify totals (for reference)');
    doc.text(`Total tax: ${order.total_tax || '0.00'} ${order.currency || 'NOK'}`);
    doc.text(`Total discounts: ${order.total_discounts || '0.00'} ${order.currency || 'NOK'}`);

    doc.end();
  });
}

main().catch(error => {
  console.error('💥 Failed to create external sale:', error.message);
  if (error.response?.data) {
    console.error('Response:', JSON.stringify(error.response.data));
  }
  process.exit(1);
});
