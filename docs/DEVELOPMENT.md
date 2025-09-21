# API Testing og Development Commands

Dette dokumentet inneholder nyttige kommandoer for testing og utvikling av Shopify-Fiken integrasjonen.

## 🧪 Fiken API Testing

### Test API Connection
```bash
# Test basic connection
curl -s "https://api.fiken.no/api/v2/companies" \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '.'

# Test specific company
curl -s "https://api.fiken.no/api/v2/companies/fiken-demo-pittoresk-instrument-as" \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '.'
```

### Test Customer Operations
```bash
# List customers
curl -s "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/contacts?contactType=customer" \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '.'

# Create customer
curl -s "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/contacts" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "name": "Test Customer",
    "email": "test@example.com",
    "customer": true
  }' | jq '.'
```

### Test Sales API (Cash Sale)
```bash
# Create cash sale (no customer allowed)
curl -s "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/sales" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "kind": "CASH_SALE",
    "date": "2025-09-21",
    "lines": [
      {
        "netAmount": 10000,
        "vatType": "HIGH",
        "incomeAccount": "3000",
        "description": "Test sale"
      }
    ],
    "bankAccountCode": "1920:10001"
  }' | jq '.'
```

### Test Invoice API
```bash
# Create invoice
curl -s "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/invoices" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "issueDate": "2025-09-21",
    "dueDate": "2025-09-21",
    "customerId": CUSTOMER_ID,
    "bankAccountCode": "1920:10001",
    "cash": false,
    "lines": [
      {
        "unitPrice": 10000,
        "quantity": 1,
        "vatType": "HIGH",
        "incomeAccount": "3000",
        "description": "Test product"
      }
    ]
  }' | jq '.'
```

### Test Journal Entries API
```bash
# Create journal entry
curl -s "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/journalEntries" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "description": "Test journal entry",
    "date": "2025-09-21",
    "lines": [
      {
        "amount": 12500,
        "account": "1920:10001",
        "description": "Bank payment"
      },
      {
        "amount": -2500,
        "account": "2701",
        "description": "VAT 25%"
      },
      {
        "amount": -10000,
        "account": "3000",
        "vatCode": "3",
        "description": "Sales"
      }
    ]
  }' | jq '.'
```

## 🛠️ Development Commands

### Test Migration Script
```bash
# Test with API token
cd /home/kau005/SHOPIFY-FIKEN

export FIKEN_API_TOKEN="your-token-here"

# Test single order calculation
node -e "
const Migration = require('./scripts/migrate_shopify_to_fiken_journal.js');
const migration = new Migration();
migration.fiken.apiToken = process.env.FIKEN_API_TOKEN;

const orders = migration.loadShopifyOrders();
const testOrder = orders[0];
console.log('Order:', testOrder.order_number);
console.log('Amounts:', migration.calculateOrderAmounts(testOrder));
"

# Test customer creation
node -e "
const Migration = require('./scripts/migrate_shopify_to_fiken_journal.js');
const migration = new Migration();
migration.fiken.apiToken = process.env.FIKEN_API_TOKEN;

async function test() {
  const orders = migration.loadShopifyOrders();
  const customer = await migration.getOrCreateCustomer(orders[0]);
  console.log('Customer:', customer);
}
test().catch(console.error);
"
```

### Start Development Server
```bash
# Install dependencies
npm install

# Start development server with auto-reload
npm run dev

# Start production server
npm start

# Test webhook endpoint
curl -X POST http://localhost:3000/fiken/companies/test-company/sales \
  -H "Content-Type: application/json" \
  -d '{"order": {"id": 123, "total_price": "100.00"}}'
```

### Run Migration
```bash
# Run full migration (with real API token)
FIKEN_API_TOKEN="your-token" npm run migrate

# Run with dry-run mode (if implemented)
FIKEN_API_TOKEN="your-token" npm run migrate -- --dry-run

# Run legacy sales migration
FIKEN_API_TOKEN="your-token" npm run migrate-sales
```

## 📊 Data Analysis Commands

### Analyze Shopify Orders
```bash
# Count paid orders
find /home/kau005/produktutvikling/ordrer_backup/2025/09 -name "*.json" | wc -l

# Check order financial status
grep -r "financial_status" /home/kau005/produktutvikling/ordrer_backup/2025/09/ | grep -c "paid"

# Find orders with shipping
grep -r "shipping_lines" /home/kau005/produktutvikling/ordrer_backup/2025/09/ -l | wc -l

# Check order value distribution
for file in /home/kau005/produktutvikling/ordrer_backup/2025/09/ordre_*.json; do
  jq -r '.total_price' "$file"
done | sort -n
```

### Analyze Fiken Data
```bash
# Check company accounts
curl -s "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/accounts" \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '.[] | select(.code | startswith("1920") or startswith("3000") or startswith("2701"))'

# Check existing sales
curl -s "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/sales?pageSize=10" \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '.'

# Check journal entries
curl -s "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/journalEntries?pageSize=5" \
  -H "Authorization: Bearer YOUR_TOKEN" | jq '.'
```

## 🔧 Debugging Commands

### API Error Debugging
```bash
# Test with verbose curl
curl -v "https://api.fiken.no/api/v2/companies/COMPANY_SLUG/journalEntries" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d @test-journal-entry.json

# Check response headers
curl -I "https://api.fiken.no/api/v2/companies" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Application Debugging
```bash
# Run with debug logging
LOG_LEVEL=debug node scripts/migrate_shopify_to_fiken_journal.js

# Test individual components
node -e "
const FikenAPI = require('./src/fiken.js');
const fiken = new FikenAPI('token');
fiken.testConnection().then(console.log);
"

# Check file permissions and paths
ls -la /home/kau005/produktutvikling/ordrer_backup/2025/09/
file /home/kau005/produktutvikling/ordrer_backup/2025/09/ordre_*.json | head -5
```

## 📝 Environment Setup

### Required Environment Variables
```bash
export FIKEN_API_TOKEN="your-fiken-api-token"
export FIKEN_COMPANY_SLUG="your-company-slug"
export ORDERS_BACKUP_PATH="/home/kau005/produktutvikling/ordrer_backup/2025/09"
export LOG_LEVEL="info"
```

### Docker Development (if needed)
```bash
# Build Docker image
docker build -t shopify-fiken .

# Run with environment
docker run -e FIKEN_API_TOKEN="token" -p 3000:3000 shopify-fiken

# Run with volume mount for development
docker run -v $(pwd):/app -e FIKEN_API_TOKEN="token" shopify-fiken npm run dev
```

## 🧪 Testing Checklist

### Before Migration
- [ ] Test Fiken API connection
- [ ] Verify company access and accounts
- [ ] Test customer creation
- [ ] Validate order data loading
- [ ] Test amount calculations

### During Migration  
- [ ] Monitor API rate limits
- [ ] Check error logs
- [ ] Verify balance calculations
- [ ] Monitor created entries

### After Migration
- [ ] Verify all orders processed
- [ ] Check Fiken accounting entries
- [ ] Validate customer links
- [ ] Review error summary
- [ ] Test webhook functionality