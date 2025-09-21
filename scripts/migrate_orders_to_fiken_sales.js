#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const WEBHOOK_URL = 'https://webhook.protonord.no';
const TARGET_COMPANY = 'fiken-demo-pittoresk-instrument-as';
const ORDERS_PATH = '/home/kau005/protonord_no/shopify_organized_backup/2025-09-21/orders/by_year/2025/09';

async function loadShopifyOrders() {
  console.log('📂 Loading Shopify orders from September 2025...');
  
  const orderFiles = fs.readdirSync(ORDERS_PATH).filter(file => file.startsWith('order_') && file.endsWith('.json'));
  
  const orders = [];
  
  for (const file of orderFiles) {
    try {
      const orderSummary = JSON.parse(fs.readFileSync(path.join(ORDERS_PATH, file)));
      
      // Les full ordre hvis den er betalt
      if (orderSummary.financial_status === 'paid') {
        const fullOrder = JSON.parse(fs.readFileSync(orderSummary.full_order_file));
        orders.push(fullOrder);
      }
    } catch (error) {
      console.error(`❌ Error loading order ${file}:`, error.message);
    }
  }
  
  console.log(`✅ Loaded ${orders.length} paid orders from September 2025`);
  return orders;
}

function convertShopifyOrderToFikenSale(order) {
  console.log(`🔄 Converting order ${order.order_number} to Fiken sale format...`);
  
  // Bygg salgs-linjer
  const lines = [];
  
  // Produktlinjer
  for (const lineItem of order.line_items) {
    const unitPrice = parseFloat(lineItem.price);
    const grossAmount = Math.round(unitPrice * 100); // Bruttobeløp i øre
    const vatAmount = Math.round((grossAmount * 0.2) / 1.2); // MVA beløp (20% av netto)
    const netAmount = grossAmount - vatAmount; // Nettobeløp
    
    lines.push({
      description: `${lineItem.title}${lineItem.variant_title ? ' - ' + lineItem.variant_title : ''}`,
      account: "3000", // Inntektskonto - Salg av varer
      grossAmount: grossAmount, // Bruttobeløp inkl. mva
      vatType: 'HIGH', // 25% mva
      quantity: lineItem.quantity
    });
  }
  
  // Frakt som egen linje
  if (order.shipping_lines && order.shipping_lines.length > 0) {
    const shippingLine = order.shipping_lines[0];
    const shippingPrice = parseFloat(shippingLine.price);
    const grossAmount = Math.round(shippingPrice * 100); // Bruttobeløp i øre
    const vatAmount = Math.round((grossAmount * 0.2) / 1.2); // MVA beløp
    
    if (grossAmount > 0) {
      lines.push({
        description: `Frakt: ${shippingLine.title}`,
        account: "3000", // Inntektskonto
        grossAmount: grossAmount,
        vatType: 'HIGH',
        quantity: 1
      });
    }
  }
  
  // Kunde fra ordre
  const customer = order.customer;
  const billingAddress = order.billing_address || order.shipping_address;
  
  // Kunde-data for oppslag/opprettelse
  const customerData = {
    name: `${customer.first_name} ${customer.last_name}`.trim(),
    email: customer.email
  };
  
  // Legg til adresse hvis den finnes
  if (billingAddress) {
    customerData.address = {
      address1: billingAddress.address1,
      city: billingAddress.city,
      postalCode: billingAddress.zip,
      country: billingAddress.country_code?.toUpperCase() || "NO"
    };
  }
  
  // Konverter til Fiken salg-format (cash_sale for betalt netthandel)
  const totalGrossAmount = parseFloat(order.total_price);
  
  const fikenSale = {
    saleNumber: `SHOPIFY-${order.order_number}`,
    date: order.created_at.split('T')[0], // Salg dato
    kind: "cash_sale", // Cash sale for betalt netthandel
    currency: "NOK",
    paymentDate: order.created_at.split('T')[0], // Betalingsdato (samme som salgsdato)
    paymentAccount: "1920:10001", // Demo-konto bankkonto
    totalPaid: Math.round(totalGrossAmount * 100), // Øre - totalt betalt beløp
    lines: lines,
    customerData: customerData // Midlertidig - blir erstattet med customerId
  };
  
  return {
    sale: fikenSale,
    originalOrder: order
  };
}

async function createSaleWithCustomer(saleData) {
  const { sale, originalOrder } = saleData;
  
  try {
    console.log(`💰 Creating sale for order ${originalOrder.order_number}...`);
    
    // Først finn eller opprett kunde
    console.log(`👤 Looking up customer: ${sale.customerData.name}`);
    let customerId;
    
    try {
      // Søk etter eksisterende kunde
      const searchResponse = await axios.get(
        `${WEBHOOK_URL}/fiken/local/companies/${TARGET_COMPANY}/customers/search?q=${encodeURIComponent(sale.customerData.email || sale.customerData.name)}`,
        { headers: { 'Content-Type': 'application/json' } }
      );
      
      if (searchResponse.data && searchResponse.data.length > 0) {
        customerId = searchResponse.data[0].fiken_contact_id;
        console.log(`✅ Found existing customer: ${customerId}`);
      }
    } catch (searchError) {
      console.log(`ℹ️  Customer not found, will create new one`);
    }
    
    // Opprett kunde hvis ikke funnet
    if (!customerId) {
      console.log(`📝 Creating new customer: ${sale.customerData.name}`);
      const customerResponse = await axios.post(
        `${WEBHOOK_URL}/fiken/companies/${TARGET_COMPANY}/customers`,
        {
          name: sale.customerData.name,
          email: sale.customerData.email,
          address: sale.customerData.address,
          customer: true,
          supplier: false
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
      
      customerId = customerResponse.data.contactId;
      console.log(`✅ Created new customer: ${customerId}`);
      
      // Vent litt for synkronisering
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Sett customerId på salget
    const finalSale = {
      ...sale,
      customerId: customerId
    };
    
    // Fjern customerData siden vi nå har customerId
    delete finalSale.customerData;
    
    // Opprett salget
    const createResponse = await axios.post(
      `${WEBHOOK_URL}/fiken/companies/${TARGET_COMPANY}/sales`,
      finalSale,
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (createResponse.status !== 201) {
      throw new Error(`Unexpected response status: ${createResponse.status}`);
    }
    
    const fikenSale = createResponse.data;
    const saleId = fikenSale.saleId;
    
    console.log(`✅ Created sale ${saleId} for order ${originalOrder.order_number} - Sale is closed with payment`);
    
    return {
      success: true,
      saleId: saleId,
      orderNumber: originalOrder.order_number,
      amount: parseFloat(originalOrder.total_price)
    };
    
  } catch (error) {
    console.error(`❌ Failed to create sale for order ${originalOrder.order_number}:`, 
      error.response?.data || error.message);
    
    return {
      success: false,
      orderNumber: originalOrder.order_number,
      error: error.response?.data || error.message
    };
  }
}

async function migrateShopifyOrdersToFikenSales() {
  console.log('🚀 Starting migration of Shopify orders to Fiken sales...\n');
  
  try {
    // Last Shopify ordrer
    const orders = await loadShopifyOrders();
    
    const results = [];
    let successCount = 0;
    let failCount = 0;
    
    // Prosesser hver ordre
    for (const order of orders.slice(0, 5)) { // Test med første 5 ordrer
      console.log(`\n--- Processing Order ${order.order_number} ---`);
      console.log(`💰 Amount: ${order.total_price} NOK`);
      console.log(`📧 Customer: ${order.customer.email}`);
      console.log(`📅 Date: ${order.created_at}`);
      
      const saleData = convertShopifyOrderToFikenSale(order);
      const result = await createSaleWithCustomer(saleData);
      
      results.push(result);
      
      if (result.success) {
        successCount++;
        console.log(`✅ Order ${result.orderNumber} migrated successfully`);
      } else {
        failCount++;
        console.log(`❌ Order ${result.orderNumber} failed: ${JSON.stringify(result.error)}`);
      }
    }
    
    // Vis sammendrag
    console.log(`\n📊 Migration Summary:`);
    console.log(`✅ Successfully migrated: ${successCount} orders`);
    console.log(`❌ Failed: ${failCount} orders`);
    console.log(`📋 Total processed: ${results.length} orders`);
    
    // Synkroniser lokal database
    console.log(`\n🔄 Syncing local Fiken database...`);
    const syncResponse = await axios.post(`${WEBHOOK_URL}/fiken/sync`);
    console.log(`✅ Sync completed: ${JSON.stringify(syncResponse.data)}`);
    
    console.log(`\n🎉 Migration completed!`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Kjør migrasjonen
if (require.main === module) {
  migrateShopifyOrdersToFikenSales();
}

module.exports = { migrateShopifyOrdersToFikenSales };