# AGENTS.md - AI Developer Guide

*Comprehensive development guide for AI-assisted coding (Codex, GitHub Copilot, etc.)*

---

## 🎯 Project Overview

**Purpose**: Automated integration between Shopify and Fiken accounting system  
**Method**: "External Sales" API approach (NOT journal entries)  
**Status**: Production-ready, battle-tested solution  
**Use Case**: Import paid Shopify orders as completed sales directly into Fiken

---

## 🏗️ Architecture Summary

### Current Working Solution
This project uses Fiken's **"External Sales"** API endpoint - a purpose-built feature for importing sales from external systems like e-commerce platforms.

**Why External Sales?**
- ✅ Designed specifically for this use case
- ✅ Automatic VAT calculations
- ✅ Customer association support
- ✅ PDF attachment capability
- ✅ Payment fee handling
- ✅ Simpler than journal entries

### Key Components

```
┌─ scripts/
│  ├── migrate_shopify_to_fiken_external_sales.js  # Main batch import
│  └── create_external_sale.js                     # Single sale creation
├─ src/
│  ├── fiken.js                                    # Fiken API client
│  └── server.js                                   # Express webhook server
└─ .env.example                                    # Configuration template
```

---

## 🔧 Technical Implementation

### 1. Fiken API Client (`src/fiken.js`)

**Key Methods:**
```javascript
// Create external sale (main function)
async createExternalSale(companySlug, saleData)

// Customer management
async getCustomers(companySlug)
async createContact(companySlug, contactData)

// File attachments
async uploadAttachment(companySlug, saleId, pdfBuffer, filename)
```

**External Sale Data Structure:**
```javascript
{
  date: "2025-09-21",
  net: 44960,        // Amount in øre (449.60 NOK)
  vat: 12840,        // VAT in øre (128.40 NOK) 
  gross: 64200,      // Total in øre (642.00 NOK)
  customerId: 1234567890,
  saleNumber: "SHOP-3403",
  lines: [
    {
      net: 35968,     // Product net
      vat: 8992,      // Product VAT
      incomeAccount: "3000",
      vatCode: "3",
      description: "Product name"
    },
    {
      net: 5120,      // Shipping net  
      vat: 1280,      // Shipping VAT
      incomeAccount: "3000",
      vatCode: "3", 
      description: "Shipping"
    }
  ],
  paymentAccount: "1920:12345",  // Bank account
  paymentDate: "2025-09-21"
}
```

### 2. Batch Migration (`scripts/migrate_shopify_to_fiken_external_sales.js`)

**Process Flow:**
1. Load Shopify order JSON files from backup directory
2. Filter to paid orders only (`financial_status: "paid"`)
3. Create/find customer in Fiken 
4. Calculate VAT (25% Norwegian rate)
5. Create external sale with payment
6. Generate PDF receipt with order details
7. Attach PDF to sale record

**Usage:**
```bash
# Full migration
npm run migrate-external-sales

# Test with limit and dry-run
npm run migrate-external-sales -- --limit 5 --dry-run
```

### 3. Single Sale Creation (`scripts/create_external_sale.js`)

**Purpose**: Testing and manual sale creation  
**Configuration**: Environment variables override defaults

**Usage:**
```bash
# Create test sale
npm run external-sale

# Custom amounts
EXTERNAL_SALE_NET=100 EXTERNAL_SALE_FEE=5 npm run external-sale
```

---

## 📊 Data Flow & Calculations

### Shopify Order → Fiken Sale Mapping

```javascript
// Input: Shopify Order
{
  "order_number": 3403,
  "total_price": "642.00",           // Includes VAT
  "current_total_tax": "128.40",     // VAT amount
  "financial_status": "paid",
  "line_items": [...],               // Products
  "shipping_lines": [...]            // Shipping
}

// Output: Fiken External Sale
{
  "gross": 64200,                    // 642.00 * 100 (øre)
  "net": 51360,                      // Calculated
  "vat": 12840,                      // From Shopify
  "paymentAccount": "1920:12345",    // Bank account
  "lines": [...]                     // Item breakdown
}
```

### VAT Calculation Logic

```javascript
// Norwegian 25% VAT (prices include VAT)
const vatRate = 0.25;
const grossAmount = parseFloat(shopifyPrice) * 100;  // Convert to øre
const netAmount = Math.round(grossAmount / (1 + vatRate));
const vatAmount = grossAmount - netAmount;

// Validation: netAmount + vatAmount === grossAmount
```

### Payment Fees Support

```javascript
// Optional payment processing fees
const feePercent = 2.5;        // 2.5% fee
const feeAmountFixed = 250;    // 2.50 NOK fixed fee

// Fee calculation
const feeAmount = Math.round(netAmount * (feePercent / 100)) + feeAmountFixed;
```

---

## 🛠️ Configuration Guide

### Environment Variables

**Required:**
```bash
FIKEN_API_TOKEN=your-token-here
FIKEN_COMPANY_SLUG=your-company-slug
ORDERS_BACKUP_PATH=/path/to/shopify/orders
```

**Account Configuration:**
```bash
BANK_ACCOUNT_CODE=1920:12345      # Bank account for payments
SALES_ACCOUNT_CODE=3000           # Revenue account
SHIPPING_ACCOUNT_CODE=3000        # Shipping revenue (can be separate)
PAYMENT_FEE_ACCOUNT_CODE=7770     # Payment processing fees
```

**VAT & Fees:**
```bash
VAT_RATE=0.25                     # Norwegian 25% VAT
PAYMENT_FEE_PERCENT=0             # Percentage fee
PAYMENT_FEE_AMOUNT_ORE=0          # Fixed fee in øre
```

### Shopify Data Structure Expected

**Order Files:** `ordre_XXXXXX.json` format in backup directory  
**Required Fields:**
- `financial_status: "paid"`
- `order_number`
- `total_price` (string, includes VAT)
- `current_total_tax` (string, VAT amount)
- `customer.email` (for customer lookup/creation)
- `line_items[]` (product details)
- `shipping_lines[]` (shipping costs)

---

## 🔍 Testing & Debugging

### Test Data Examples

**Minimal Test Order:**
```json
{
  "id": 6564481335577,
  "order_number": 3403,
  "total_price": "642.00",
  "current_total_tax": "128.40",
  "financial_status": "paid",
  "customer": {
    "email": "test@example.com",
    "first_name": "Test",
    "last_name": "Customer"
  },
  "line_items": [{
    "title": "Test Product",
    "price": "449.60",
    "quantity": 1
  }],
  "shipping_lines": [{
    "title": "Standard Shipping", 
    "price": "64.00"
  }]
}
```

### Common Issues & Solutions

**1. Customer Creation Fails**
```javascript
// Check customer data structure
const customerData = {
  email: order.customer.email,
  name: `${order.customer.first_name} ${order.customer.last_name}`,
  customerAccountCode: "1500"  // Required for B2B
};
```

**2. VAT Calculation Mismatch**
```javascript
// Ensure consistent rounding
const netAmount = Math.round(grossAmount / (1 + vatRate));
// NOT: Math.floor() or Math.ceil()
```

**3. Account Code Validation**
```bash
# Verify account codes exist in Fiken
# Format: "ACCOUNT:SUBACCOUNT" or just "ACCOUNT"
BANK_ACCOUNT_CODE=1920:12345  # Check this exists
SALES_ACCOUNT_CODE=3000       # Standard sales account
```

### Debug Mode

```bash
# Enable detailed logging
LOG_LEVEL=debug npm run migrate-external-sales

# Dry run mode (no actual API calls)
npm run migrate-external-sales -- --dry-run
```

---

## 🚀 Deployment Considerations

### Production Checklist

- [ ] Valid Fiken API token with write permissions
- [ ] Correct company slug verified
- [ ] Bank account codes validated in Fiken
- [ ] Customer account codes configured
- [ ] VAT rate matches your region (25% for Norway)
- [ ] Backup of Shopify order data available
- [ ] Error handling and logging configured

### Rate Limiting

```javascript
// Built-in rate limiting (100ms between requests)
await new Promise(resolve => setTimeout(resolve, 100));
```

### Error Recovery

```javascript
// Continue processing on individual failures
try {
  await this.createOrderSale(order, customer);
  processed++;
} catch (error) {
  console.error(`Failed order ${order.order_number}:`, error.message);
  failed++;
  // Continue with next order
}
```

---

## 📚 API Reference

### Fiken External Sales Endpoint

**URL:** `POST /companies/{slug}/externalSales`

**Required Fields:**
- `date` (ISO date string)
- `gross` (integer, øre)
- `lines[]` (array of sale lines)
- `paymentAccount` (string)
- `paymentDate` (ISO date string)

**Optional Fields:**
- `customerId` (integer)
- `saleNumber` (string)
- `net` (integer, calculated if omitted)
- `vat` (integer, calculated if omitted)

### Response Handling

```javascript
// Success response
{
  "externalSaleId": 12345,
  "saleNumber": "SHOP-3403"
}

// Error responses
{
  "error": "Invalid account code",
  "details": "Account 1920:99999 not found"
}
```

---

## 🔄 Migration from Old Approaches

### Why NOT Journal Entries

Previous attempts used journal entries (`/journalEntries` endpoint):
- ❌ Complex debit/credit balancing required
- ❌ Manual VAT calculations prone to errors  
- ❌ No built-in customer association
- ❌ More error-prone API responses
- ❌ Harder to attach supporting documents

### Why NOT Sales API

The basic sales API (`/sales`) was also attempted:
- ❌ Requires existing customer ID (can't include customer data)
- ❌ More complex multi-step process
- ❌ Less suitable for automated import

**External Sales API wins because:**
- ✅ Purpose-built for e-commerce imports
- ✅ Handles customer creation automatically
- ✅ Built-in VAT validation
- ✅ Cleaner error messages
- ✅ Better documentation

---

## 💡 AI Development Tips

### For Codex/Copilot Users

**When working with this codebase:**

1. **Focus on External Sales API** - ignore any journal entry code you see
2. **VAT is always 25%** for Norwegian businesses
3. **Amounts in øre** - multiply NOK by 100
4. **Customer creation** is optional but recommended
5. **PDF attachments** enhance audit trail

**Common AI Mistakes to Avoid:**

```javascript
// ❌ Wrong: Using sales API
await fiken.createSale(companySlug, saleData);

// ✅ Correct: Using external sales API  
await fiken.createExternalSale(companySlug, saleData);

// ❌ Wrong: Manual VAT calculation
const vat = amount * 0.25;

// ✅ Correct: VAT from gross amount
const net = Math.round(gross / 1.25);
const vat = gross - net;

// ❌ Wrong: Journal entry approach
await fiken.createJournalEntry(companySlug, entryData);

// ✅ Correct: External sale approach
await fiken.createExternalSale(companySlug, saleData);
```

### Prompting Best Practices

**Good prompt:**
> "Create an external sale in Fiken using the createExternalSale method with proper VAT calculation for Norwegian 25% rate"

**Bad prompt:**
> "Create a sale in Fiken" (too ambiguous - might suggest wrong API)

---

## 📝 Development History

**Evolution Summary:**
1. **Journal Entries** (abandoned) - Too complex, error-prone
2. **Sales API** (abandoned) - Customer creation issues  
3. **External Sales** (current) - Purpose-built, reliable

**Lessons Learned:**
- Always use the most specific API for your use case
- External Sales API is designed for exactly this scenario
- Simple is better than complex when it comes to accounting integrations
- PDF receipts significantly improve audit trails

**Current Status:** ✅ Production-ready, stable, well-tested

---

*This guide is designed for AI-assisted development. Focus on the External Sales approach and ignore references to journal entries or basic sales API in any legacy code.*