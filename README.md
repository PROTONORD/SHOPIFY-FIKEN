# SHOPIFY-FIKEN Integration

En komplett løsning for å migrere Shopify-ordrer til Fiken regnskapssystem.

## 📋 Oversikt

Dette prosjektet løser utfordringen med å migrere betalte Shopify-ordrer til Fiken regnskapssystem, med korrekt håndtering av kunder, MVA og betalingsstatus. Løsningen håndterer spesielt utfordringen at Fiken's `cash_sale` API ikke kan inkludere kundeinformasjon.

## 🚀 Funksjonalitet

### ✅ Implementert
- **Fiken API Integration**: Komplett API-klient for alle Fiken-operasjoner
- **Kunde-håndtering**: Automatisk oppretting og kobling av kunder
- **Journal Entry Migration**: Registrering av betalte salg direkte til bankkonto
- **MVA-beregning**: Korrekt håndtering av 25% norsk MVA
- **Express Server**: REST API for webhook-integrasjon

### 🔧 Under utvikling
- **Webhook Server**: Sanntids synkronisering fra Shopify
- **Error Handling**: Robuste feilhåndteringsmekanismer
- **Testing Suite**: Omfattende testdekning

## 📁 Prosjektstruktur

```
SHOPIFY-FIKEN/
├── src/
│   ├── fiken.js           # Fiken API klient
│   └── server.js          # Express server med webhooks
├── scripts/
│   ├── migrate_orders_to_fiken_sales.js     # Original sales migration
│   └── migrate_shopify_to_fiken_journal.js  # Journal entry migration
├── docs/
│   └── AGENTS.md          # Detaljert utviklingslogg
├── tests/
└── README.md
```

## 🛠️ Installasjon

```bash
# Klon repository
git clone https://github.com/PROTONORD/SHOPIFY-FIKEN.git
cd SHOPIFY-FIKEN

# Installer avhengigheter
npm install

# Sett miljøvariabler
export FIKEN_API_TOKEN="ditt-fiken-api-token"
export SHOPIFY_WEBHOOK_SECRET="ditt-shopify-webhook-secret"
```

## 📊 Bruk

### Migrasjon av eksisterende ordrer

```bash
# Migrer alle betalte ordrer fra September 2025
node scripts/migrate_shopify_to_fiken_journal.js
```

### Start webhook server

```bash
# Start Express server for webhook-mottaking
node src/server.js
```

## 🏗️ Arkitektur

### Fiken API Tilnærming

Prosjektet har utforsket tre hovedtilnærminger for Shopify-Fiken integrasjon:

1. **Cash Sale API** ❌
   - Begrensning: Kan ikke inkludere kundeinformasjon
   - Bruk: `POST /companies/{slug}/sales`

2. **Invoice + Payment API** ⚠️
   - Problem: Payment-registrering ikke tilgjengelig via API
   - Bruk: `POST /companies/{slug}/invoices`

3. **Journal Entries API** ✅
   - Løsning: Direkte journalføring til bankkonto med kundeinformasjon
   - Bruk: `POST /companies/{slug}/journalEntries`

### Dataflyt

```
Shopify Order (paid) → Customer Creation → Journal Entry → Fiken
                                        ↓
                                  Bank Account (1920:10001)
                                  Sales Account (3000)
                                  VAT Account (2701)
```

## 📈 Regnskapslogikk

### Journal Entry Struktur

For en betalt Shopify-ordre på 642 NOK:

```
Debet:  Bankkonto 1920:10001     642,00 NOK
Kredit: Salg 3000               -449,60 NOK (eks. MVA)
Kredit: Frakt 3000               -64,00 NOK (eks. MVA)  
Kredit: MVA 2701               -128,40 NOK (25% MVA)
```

### MVA-beregning

```javascript
// Shopify-priser inkluderer MVA
const netAmount = grossAmount / (1 + 0.25);  // 25% norsk MVA
const vatAmount = grossAmount - netAmount;
```

## 🔧 Konfigurering

### Fiken Kontoer

- **Bankkonto**: `1920:10001` (Demo-konto)
- **Salgskonto**: `3000` (Salgsinntekt)
- **MVA-konto**: `2701` (Utgående MVA)
- **Fraktkonto**: `3000` (Fraktinntekt)

### Shopify Webhook

```javascript
// POST til /fiken/companies/{slug}/sales
{
  "order": { /* Shopify order object */ },
  "customer": { /* Customer information */ }
}
```

## 📚 API Dokumentasjon

### Fiken API Klient

```javascript
const FikenAPI = require('./src/fiken.js');
const fiken = new FikenAPI('your-api-token');

// Hent selskaper
const companies = await fiken.getCompanies();

// Opprett kunde
const customer = await fiken.createContact(companySlug, customerData);

// Opprett journal entry
const entry = await fiken.request('POST', 
  `/companies/${companySlug}/journalEntries`, 
  journalEntryData
);
```

## 🧪 Testing

```bash
# Test Fiken API tilkobling
node -e "
const FikenAPI = require('./src/fiken.js');
const fiken = new FikenAPI('your-token');
fiken.testConnection().then(console.log);
"

# Test ordre-migrasjon (tørrkjøring)
node scripts/migrate_shopify_to_fiken_journal.js --dry-run
```

## 📋 Utfordringer løst

1. **Cash Sale uten kunde**: Løst med journal entries
2. **MVA-beregning**: Korrekt håndtering av inkludert MVA
3. **Betalingsstatus**: Direkte registrering til bankkonto
4. **Kundeinformasjon**: Bevart i journal entry beskrivelse
5. **Produkt-detaljer**: Inkludert i linjebeskrivelser

## 🔮 Fremtidige utvidelser

- [ ] Webhook-validering med Shopify HMAC
- [ ] Batch-processing for store datamengder  
- [ ] Automatisk refund-håndtering
- [ ] Multi-currency støtte
- [ ] Detaljerte rapporter og logging
- [ ] Web-grensesnitt for administrasjon

## 🤝 Bidrag

Se [AGENTS.md](docs/AGENTS.md) for detaljert utviklingshistorikk og tekniske beslutninger.

## 📝 Lisens

[MIT License](LICENSE)

## 📞 Kontakt

For spørsmål om implementasjon eller tekniske detaljer, se dokumentasjonen i `docs/` mappen eller kontakt utviklingsteamet.
