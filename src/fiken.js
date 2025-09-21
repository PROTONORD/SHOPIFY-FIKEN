const axios = require('axios');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

class FikenAPI {
  constructor(apiToken, baseUrl = 'https://api.fiken.no/api/v2') {
    this.apiToken = apiToken;
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Get all companies accessible with the current token
   */
  async getCompanies() {
    try {
      const response = await this.client.get('/companies');
      logger.info({ count: response.data.length }, 'Retrieved companies from Fiken');
      return response.data;
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get companies from Fiken');
      throw error;
    }
  }

  /**
   * Get customers for a specific company
   */
  async getCustomers(companySlug) {
    try {
      const response = await this.client.get(`/companies/${companySlug}/contacts`, {
        params: { contactType: 'customer' }
      });
      logger.info({ companySlug, count: response.data.length }, 'Retrieved customers from Fiken');
      return response.data;
    } catch (error) {
      logger.error({ error: error.message, companySlug }, 'Failed to get customers from Fiken');
      throw error;
    }
  }

  /**
   * Get products for a specific company
   */
  async getProducts(companySlug) {
    try {
      const response = await this.client.get(`/companies/${companySlug}/products`);
      logger.info({ companySlug, count: response.data.length }, 'Retrieved products from Fiken');
      return response.data;
    } catch (error) {
      logger.error({ error: error.message, companySlug }, 'Failed to get products from Fiken');
      throw error;
    }
  }

  /**
   * Get invoices for a specific company
   */
  async getInvoices(companySlug, options = {}) {
    try {
      const params = {
        page: options.page || 0,
        pageSize: options.pageSize || 25,
        ...options.filters
      };
      
      const response = await this.client.get(`/companies/${companySlug}/invoices`, { params });
      logger.info({ companySlug, count: response.data.length }, 'Retrieved invoices from Fiken');
      return response.data;
    } catch (error) {
      logger.error({ error: error.message, companySlug }, 'Failed to get invoices from Fiken');
      throw error;
    }
  }

  /**
   * Create a new customer in Fiken
   */
  async createCustomer(companySlug, customerData) {
    try {
      const response = await this.client.post(`/companies/${companySlug}/contacts`, {
        contactType: 'customer',
        ...customerData
      });
      
      // Fiken returnerer contactId i Location header
      const locationHeader = response.headers.location;
      const contactId = locationHeader ? locationHeader.split('/').pop() : null;
      
      const result = {
        contactId: contactId,
        ...response.data
      };
      
      logger.info({ companySlug, customerId: contactId }, 'Created customer in Fiken');
      return result;
    } catch (error) {
      logger.error({ error: error.message, companySlug }, 'Failed to create customer in Fiken');
      throw error;
    }
  }

  /**
   * Create a new product in Fiken
   */
  async createProduct(companySlug, productData) {
    try {
      const response = await this.client.post(`/companies/${companySlug}/products`, productData);
      logger.info({ companySlug, productId: response.data.productId }, 'Created product in Fiken');
      return response.data;
    } catch (error) {
      logger.error({ error: error.message, companySlug }, 'Failed to create product in Fiken');
      throw error;
    }
  }

  /**
   * Create an invoice in Fiken
   */
  async createInvoice(companySlug, invoiceData) {
    try {
      const response = await this.client.post(`/companies/${companySlug}/invoices`, invoiceData);
      
      // Fiken returnerer invoiceId i Location header
      const locationHeader = response.headers.location;
      const invoiceId = locationHeader ? locationHeader.split('/').pop() : null;
      
      const result = {
        invoiceId: invoiceId,
        ...response.data
      };
      
      logger.info({ companySlug, invoiceId: invoiceId }, 'Created invoice in Fiken');
      return result;
    } catch (error) {
      logger.error({ 
        error: error.message, 
        companySlug,
        requestData: invoiceData,
        responseData: error.response?.data,
        status: error.response?.status
      }, 'Failed to create invoice in Fiken');
      throw error;
    }
  }

  /**
   * Create a voucher (accounting entry) in Fiken
   */
  async createVoucher(companySlug, voucherData) {
    try {
      const response = await this.client.post(`/companies/${companySlug}/generalJournalEntries`, voucherData);
      logger.info({ companySlug, voucherId: response.data.generalJournalEntryId }, 'Created voucher in Fiken');
      return response.data;
    } catch (error) {
      logger.error({ error: error.message, companySlug }, 'Failed to create voucher in Fiken');
      throw error;
    }
  }

  /**
   * Get accounts (chart of accounts) for a company
   */
  async getAccounts(companySlug) {
    try {
      const response = await this.client.get(`/companies/${companySlug}/accounts`);
      logger.info({ companySlug, count: response.data.length }, 'Retrieved accounts from Fiken');
      return response.data;
    } catch (error) {
      logger.error({ error: error.message, companySlug }, 'Failed to get accounts from Fiken');
      throw error;
    }
  }

  /**
   * Set invoice counter for a company
   */
  async setInvoiceCounter(companySlug, counterData) {
    try {
      const response = await this.client.post(`/companies/${companySlug}/invoices/counter`, counterData);
      logger.info({ companySlug, nextInvoiceNumber: counterData.nextInvoiceNumber }, 'Set invoice counter in Fiken');
      return response.data;
    } catch (error) {
      logger.error({ 
        error: error.message, 
        companySlug,
        requestData: counterData,
        responseData: error.response?.data,
        status: error.response?.status
      }, 'Failed to set invoice counter in Fiken');
      throw error;
    }
  }

  /**
   * Send invoice (finalize/send an invoice)
   */
  async sendInvoice(companySlug, invoiceId) {
    try {
      logger.info({ companySlug, invoiceId }, 'Attempting to send invoice in Fiken');
      const response = await this.client.put(`/companies/${companySlug}/invoices/${invoiceId}/actions/send`);
      logger.info({ companySlug, invoiceId, status: response.status }, 'Sent invoice in Fiken');
      return response.data;
    } catch (error) {
      logger.error({ 
        error: error.message, 
        companySlug, 
        invoiceId,
        status: error.response?.status,
        data: error.response?.data
      }, 'Failed to send invoice in Fiken');
      throw error;
    }
  }

  /**
   * Add payment to an invoice (close/settle the invoice)
   */
  async addInvoicePayment(companySlug, invoiceId, paymentData) {
    try {
      const response = await this.client.post(`/companies/${companySlug}/invoices/${invoiceId}/payments`, paymentData);
      
      // Fiken kan returnere paymentId i Location header
      const locationHeader = response.headers.location;
      const paymentId = locationHeader ? locationHeader.split('/').pop() : null;
      
      const result = {
        paymentId: paymentId,
        ...response.data
      };
      
      logger.info({ companySlug, invoiceId, paymentId: paymentId }, 'Added payment to invoice in Fiken');
      return result;
    } catch (error) {
      logger.error({ error: error.message, companySlug, invoiceId }, 'Failed to add payment to invoice in Fiken');
      throw error;
    }
  }

  /**
   * Create a sale in Fiken (for external sales like Shopify)
   */
  async createSale(companySlug, saleData) {
    try {
      const response = await this.client.post(`/companies/${companySlug}/sales`, saleData);
      
      // Fiken returnerer saleId i Location header
      const locationHeader = response.headers.location;
      const saleId = locationHeader ? locationHeader.split('/').pop() : null;
      
      const result = {
        saleId: saleId,
        ...response.data
      };
      
      logger.info({ companySlug, saleId: saleId }, 'Created sale in Fiken');
      return result;
    } catch (error) {
      logger.error({ 
        error: error.message, 
        companySlug,
        requestData: saleData,
        responseData: error.response?.data,
        status: error.response?.status
      }, 'Failed to create sale in Fiken');
      throw error;
    }
  }

  /**
   * Get a specific invoice by ID
   */
  async getInvoice(companySlug, invoiceId) {
    try {
      const response = await this.client.get(`/companies/${companySlug}/invoices/${invoiceId}`);
      logger.info({ companySlug, invoiceId }, 'Retrieved invoice from Fiken');
      return response.data;
    } catch (error) {
      logger.error({ error: error.message, companySlug, invoiceId }, 'Failed to get invoice from Fiken');
      throw error;
    }
  }

  /**
   * Generic request method for making API calls to Fiken
   */
  async request(method, endpoint, data = null) {
    try {
      const config = {
        method: method.toUpperCase(),
        url: endpoint.startsWith('/') ? endpoint : `/${endpoint}`,
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        }
      };

      if (data && ['POST', 'PUT', 'PATCH'].includes(config.method)) {
        config.data = data;
      } else if (data && config.method === 'GET') {
        config.params = data;
      }

      logger.info({ 
        method: config.method, 
        url: config.url,
        hasData: !!data 
      }, 'Making Fiken API request');

      const response = await this.client.request(config);
      
      logger.info({ 
        method: config.method, 
        url: config.url, 
        status: response.status 
      }, 'Fiken API request successful');

      return response.data;
    } catch (error) {
      logger.error({ 
        method: method.toUpperCase(), 
        endpoint, 
        error: error.message,
        response: error.response?.data 
      }, 'Fiken API request failed');
      
      // Include response data in error for debugging
      if (error.response?.data) {
        const enhancedError = new Error(`${error.message}: ${JSON.stringify(error.response.data)}`);
        enhancedError.response = error.response;
        throw enhancedError;
      }
      
      throw error;
    }
  }

  /**
   * Test the API connection and return basic info
   */
  async testConnection() {
    try {
      const companies = await this.getCompanies();
      return {
        status: 'success',
        companiesCount: companies.length,
        companies: companies.map(c => ({ slug: c.slug, name: c.name })),
        apiUrl: this.baseUrl
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        apiUrl: this.baseUrl
      };
    }
  }
}

module.exports = FikenAPI;