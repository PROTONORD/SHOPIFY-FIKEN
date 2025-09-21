#!/usr/bin/env node

/**
 * Test script for Shopify-Fiken integration
 * 
 * Usage:
 *   FIKEN_API_TOKEN="your-token" node tests/test-integration.js
 */

const FikenAPI = require('../src/fiken.js');

async function runTests() {
    console.log('🧪 SHOPIFY-FIKEN Integration Tests\n');

    // Check environment
    const apiToken = process.env.FIKEN_API_TOKEN;
    if (!apiToken) {
        console.error('❌ FIKEN_API_TOKEN environment variable required');
        console.log('   Usage: FIKEN_API_TOKEN="your-token" node tests/test-integration.js');
        process.exit(1);
    }

    console.log('✅ Environment variables loaded');

    // Initialize API client
    const fiken = new FikenAPI(apiToken);
    console.log('✅ Fiken API client initialized');

    try {
        // Test 1: API Connection
        console.log('\n📡 Testing API connection...');
        const connectionTest = await fiken.testConnection();
        
        if (connectionTest.status === 'success') {
            console.log('✅ API connection successful');
            console.log(`   Companies found: ${connectionTest.companiesCount}`);
            
            if (connectionTest.companies.length > 0) {
                console.log('   Available companies:');
                connectionTest.companies.forEach(company => {
                    console.log(`   - ${company.name} (${company.slug})`);
                });
            }
        } else {
            console.error('❌ API connection failed:', connectionTest.error);
            return;
        }

        // Test 2: Company Access
        console.log('\n🏢 Testing company access...');
        const companies = await fiken.getCompanies();
        const demoCompany = companies.find(c => c.slug.includes('demo') || c.slug.includes('pittoresk'));
        
        if (demoCompany) {
            console.log(`✅ Demo company found: ${demoCompany.name} (${demoCompany.slug})`);
            
            // Test 3: Accounts
            console.log('\n💰 Testing account access...');
            try {
                const accounts = await fiken.request('GET', `/companies/${demoCompany.slug}/accounts`);
                const bankAccount = accounts.find(a => a.code.startsWith('1920'));
                const salesAccount = accounts.find(a => a.code === '3000');
                const vatAccount = accounts.find(a => a.code === '2701');
                
                console.log(`✅ Accounts accessible (${accounts.length} total)`);
                console.log(`   Bank account: ${bankAccount ? bankAccount.code + ' - ' + bankAccount.name : 'Not found'}`);
                console.log(`   Sales account: ${salesAccount ? salesAccount.code + ' - ' + salesAccount.name : 'Not found'}`);
                console.log(`   VAT account: ${vatAccount ? vatAccount.code + ' - ' + vatAccount.name : 'Not found'}`);
                
            } catch (error) {
                console.error('⚠️  Account access test failed:', error.message);
            }

            // Test 4: Customers
            console.log('\n👥 Testing customer access...');
            try {
                const customers = await fiken.getCustomers(demoCompany.slug);
                console.log(`✅ Customers accessible (${customers.length} found)`);
                
                if (customers.length > 0) {
                    console.log('   Sample customers:');
                    customers.slice(0, 3).forEach(customer => {
                        console.log(`   - ${customer.name} (${customer.contactId})`);
                    });
                }
            } catch (error) {
                console.error('⚠️  Customer access test failed:', error.message);
            }

        } else {
            console.error('❌ No demo company found');
            console.log('   Available companies:');
            companies.forEach(company => {
                console.log(`   - ${company.name} (${company.slug})`);
            });
        }

        // Test 5: Shopify Data
        console.log('\n📦 Testing Shopify data access...');
        try {
            const fs = require('fs');
            const ordersDir = '/home/kau005/produktutvikling/ordrer_backup/2025/09';
            
            if (fs.existsSync(ordersDir)) {
                const files = fs.readdirSync(ordersDir).filter(f => f.endsWith('.json') && f.startsWith('ordre_'));
                console.log(`✅ Shopify orders accessible (${files.length} files found)`);
                
                if (files.length > 0) {
                    // Test parsing
                    const sampleFile = `${ordersDir}/${files[0]}`;
                    const orderData = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
                    
                    console.log('   Sample order:');
                    console.log(`   - Order #${orderData.order_number}`);
                    console.log(`   - Total: ${orderData.total_price} NOK`);
                    console.log(`   - Status: ${orderData.financial_status}`);
                    console.log(`   - Customer: ${orderData.customer?.first_name} ${orderData.customer?.last_name}`);
                }
            } else {
                console.error('❌ Shopify orders directory not found:', ordersDir);
            }
        } catch (error) {
            console.error('❌ Shopify data test failed:', error.message);
        }

        console.log('\n🎉 Integration tests completed!');
        console.log('\n📋 Next steps:');
        console.log('   1. Run migration: FIKEN_API_TOKEN="token" npm run migrate');
        console.log('   2. Start webhook server: npm start');
        console.log('   3. Monitor logs for any issues');

    } catch (error) {
        console.error('❌ Test suite failed:', error.message);
        if (error.response) {
            console.error('   API Response:', error.response.data);
        }
        process.exit(1);
    }
}

// Run tests
runTests().catch(error => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
});