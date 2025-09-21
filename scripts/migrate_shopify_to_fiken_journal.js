#!/usr/bin/env node

const fs = require('fs');
const FikenAPI = require('./lib/fiken.js');

/**
 * Complete Shopify to Fiken Migration using Journal Entries
 * 
 * This script migrates paid Shopify orders as journal entries directly to bank account,
 * solving the limitation that cash_sale cannot have customers and invoice payment 
 * registration is not available via API.
 * 
 * Features:
 * - Creates customers if they don't exist
 * - Records paid sales directly to bank account (1920:10001)
 * - Includes customer information in description
 * - Proper VAT handling (25% Norwegian VAT)
 * - Handles shipping costs separately
 * - Balances debits and credits correctly
 */

class ShopifyFikenJournalMigration {
    constructor() {
        this.fiken = new FikenAPI();
        this.companySlug = 'fiken-demo-pittoresk-instrument-as';
        this.bankAccount = '1920:10001'; // Demo-konto bank account
        this.salesAccount = '3000';      // Sales revenue account
        this.vatAccount = '2701';        // VAT payable account
        this.shippingAccount = '3000';   // Shipping revenue (can be separate account)
        this.vatRate = 0.25;             // 25% Norwegian VAT
        
        // Customer lookup cache
        this.customerCache = new Map();
    }

    /**
     * Load Shopify orders from backup directory
     */
    loadShopifyOrders() {
        console.log('📦 Loading Shopify orders from backup...');
        const ordersDir = '/home/kau005/produktutvikling/ordrer_backup/2025/09';
        
        if (!fs.existsSync(ordersDir)) {
            throw new Error(`Orders directory not found: ${ordersDir}`);
        }

        const files = fs.readdirSync(ordersDir).filter(file => file.startsWith('ordre_') && file.endsWith('.json'));
        console.log(`Found ${files.length} order files`);

        const orders = [];
        for (const file of files) {
            try {
                const orderPath = `${ordersDir}/${file}`;
                const orderData = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
                orders.push(orderData);
            } catch (error) {
                console.warn(`⚠️  Failed to load order file ${file}:`, error.message);
            }
        }
        
        // Filter for paid orders only
        const paidOrders = orders.filter(order => 
            order.financial_status === 'paid' && 
            order.fulfillment_status !== 'cancelled'
        );
        
        console.log(`✅ Loaded ${paidOrders.length} paid orders from ${orders.length} total orders`);
        return paidOrders;
    }

    /**
     * Get or create customer in Fiken
     */
    async getOrCreateCustomer(order) {
        const customerKey = order.customer?.email || `order-${order.id}`;
        
        // Check cache first
        if (this.customerCache.has(customerKey)) {
            return this.customerCache.get(customerKey);
        }

        let customer = null;
        
        if (order.customer?.email) {
            try {
                // Search for existing customer by email
                const searchResults = await this.fiken.searchContacts(this.companySlug, order.customer.email);
                
                if (searchResults.length > 0) {
                    customer = searchResults[0];
                    console.log(`👤 Found existing customer: ${customer.name} (${customer.contactId})`);
                } else {
                    // Create new customer
                    const customerData = {
                        name: `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || 'Shopify Customer',
                        email: order.customer.email,
                        customerNumber: `SHOP-${order.customer.id}`,
                        customer: true
                    };

                    customer = await this.fiken.createContact(this.companySlug, customerData);
                    console.log(`✨ Created new customer: ${customer.name} (${customer.contactId})`);
                }
            } catch (error) {
                console.error('❌ Error handling customer:', error.message);
                // Continue without customer link
            }
        }

        this.customerCache.set(customerKey, customer);
        return customer;
    }

    /**
     * Calculate order totals and VAT
     */
    calculateOrderAmounts(order) {
        // Total amount in øre (Fiken uses smallest currency unit)
        const totalAmount = Math.round(parseFloat(order.total_price) * 100);
        
        // Shipping cost in øre
        const shippingAmount = Math.round(
            (order.shipping_lines || []).reduce((sum, line) => 
                sum + parseFloat(line.price || 0), 0
            ) * 100
        );
        
        // Calculate net amounts (excluding VAT)
        const grossSalesAmount = totalAmount - shippingAmount;
        const grossShippingAmount = shippingAmount;
        
        // Calculate net amounts (VAT is included in Shopify prices)
        const netSalesAmount = Math.round(grossSalesAmount / (1 + this.vatRate));
        const netShippingAmount = Math.round(grossShippingAmount / (1 + this.vatRate));
        
        // Calculate VAT amounts
        const salesVatAmount = grossSalesAmount - netSalesAmount;
        const shippingVatAmount = grossShippingAmount - netShippingAmount;
        const totalVatAmount = salesVatAmount + shippingVatAmount;

        return {
            totalAmount,
            netSalesAmount,
            netShippingAmount,
            salesVatAmount,
            shippingVatAmount,
            totalVatAmount,
            grossSalesAmount,
            grossShippingAmount
        };
    }

    /**
     * Create journal entry for paid Shopify order
     */
    async createOrderJournalEntry(order, customer) {
        const amounts = this.calculateOrderAmounts(order);
        
        // Create customer reference for description
        const customerInfo = customer ? 
            `${customer.name} (${customer.contactId})` : 
            `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || 'Shopify Customer';

        // Create description with order details
        const productNames = order.line_items
            .map(item => item.title)
            .join(', ')
            .substring(0, 100); // Limit description length

        const description = `Shopify Order #${order.order_number} - ${customerInfo}`;
        
        // Build journal entry lines
        const lines = [];
        
        // Debit: Bank account (total amount received)
        lines.push({
            amount: amounts.totalAmount,
            account: this.bankAccount,
            description: `Payment received for order #${order.order_number}`
        });

        // Credit: Sales revenue (net amount)
        if (amounts.netSalesAmount > 0) {
            lines.push({
                amount: -amounts.netSalesAmount,
                account: this.salesAccount,
                vatCode: "3", // High VAT rate (25%)
                description: `Sales - ${productNames}`
            });
        }

        // Credit: Shipping revenue (net amount)
        if (amounts.netShippingAmount > 0) {
            lines.push({
                amount: -amounts.netShippingAmount,
                account: this.shippingAccount,
                vatCode: "3", // High VAT rate (25%)
                description: `Shipping - Order #${order.order_number}`
            });
        }

        // Credit: VAT payable (total VAT)
        if (amounts.totalVatAmount > 0) {
            lines.push({
                amount: -amounts.totalVatAmount,
                account: this.vatAccount,
                description: `VAT 25% on order #${order.order_number}`
            });
        }

        // Validate that debits equal credits
        const totalDebits = lines.filter(l => l.amount > 0).reduce((sum, l) => sum + l.amount, 0);
        const totalCredits = lines.filter(l => l.amount < 0).reduce((sum, l) => sum + Math.abs(l.amount), 0);
        
        if (Math.abs(totalDebits - totalCredits) > 1) { // Allow 1 øre rounding difference
            throw new Error(`Journal entry not balanced: Debits ${totalDebits} != Credits ${totalCredits}`);
        }

        const journalEntryData = {
            description,
            date: order.created_at.split('T')[0], // Use order date
            lines
        };

        console.log(`📝 Creating journal entry for order #${order.order_number}:`);
        console.log(`   Customer: ${customerInfo}`);
        console.log(`   Amount: ${amounts.totalAmount/100} NOK (${amounts.netSalesAmount/100} + ${amounts.netShippingAmount/100} + ${amounts.totalVatAmount/100} VAT)`);
        console.log(`   Products: ${productNames}`);

        try {
            const response = await this.fiken.request('POST', 
                `/companies/${this.companySlug}/journalEntries`, 
                journalEntryData
            );
            
            console.log(`✅ Created journal entry for order #${order.order_number}`);
            return response;
        } catch (error) {
            console.error(`❌ Failed to create journal entry for order #${order.order_number}:`, error.message);
            
            // Log the request data for debugging
            console.error('Request data:', JSON.stringify(journalEntryData, null, 2));
            throw error;
        }
    }

    /**
     * Migrate all orders
     */
    async migrateOrders() {
        console.log('🚀 Starting Shopify to Fiken Journal Migration...\n');

        const orders = this.loadShopifyOrders();
        
        console.log(`📊 Migration Summary:`);
        console.log(`   Total paid orders to migrate: ${orders.length}`);
        console.log(`   Target bank account: ${this.bankAccount}`);
        console.log(`   Sales account: ${this.salesAccount}`);
        console.log(`   VAT account: ${this.vatAccount}`);
        console.log('');

        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            
            try {
                console.log(`\n[${i + 1}/${orders.length}] Processing order #${order.order_number}...`);
                
                // Get or create customer
                const customer = await this.getOrCreateCustomer(order);
                
                // Create journal entry
                await this.createOrderJournalEntry(order, customer);
                
                successCount++;
                
                // Brief pause to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                console.error(`❌ Failed to migrate order #${order.order_number}:`, error.message);
                errorCount++;
                
                // Continue with other orders
                continue;
            }
        }

        console.log('\n🎉 Migration completed!');
        console.log(`✅ Successfully migrated: ${successCount} orders`);
        console.log(`❌ Errors: ${errorCount} orders`);
        console.log(`📈 Success rate: ${((successCount / orders.length) * 100).toFixed(1)}%`);
    }
}

// Run migration if called directly
if (require.main === module) {
    const migration = new ShopifyFikenJournalMigration();
    
    migration.migrateOrders()
        .then(() => {
            console.log('\n✨ Migration script completed successfully!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n💥 Migration script failed:', error.message);
            console.error(error.stack);
            process.exit(1);
        });
}

module.exports = ShopifyFikenJournalMigration;