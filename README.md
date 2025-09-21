# Shopify → Fiken External Sales

Dette repoet inneholder bare det som trengs for å registrere betalte Shopify-ordrer som «Nytt salg fra annet system» i Fiken.

## Forutsetninger

Legg nødvendig konfig i `.env`:

```
FIKEN_API_TOKEN=...            # Fiken API-token
FIKEN_COMPANY_SLUG=...         # f.eks. fiken-demo-pittoresk-instrument-as
ORDERS_BACKUP_PATH=/path/til/shopify/backup
BANK_ACCOUNT_CODE=1920:12345   # innbetaling
SALES_ACCOUNT_CODE=3000        # varelinjer
SHIPPING_ACCOUNT_CODE=3000     # frakt (kan settes til egen konto)
PAYMENT_FEE_ACCOUNT_CODE=7770  # valgfritt gebyr
VAT_RATE=0.25
```

## Kjør import

```
npm install
FIKEN_API_TOKEN=... FIKEN_COMPANY_SLUG=... npm run migrate-external-sales
```

Scriptet finner alle betalte ordre i mappen, oppretter ett salg per ordre med salgsnummer `#<ordrenummer>`, registrerer innbetalingen på bankkonto og legger ved en PDF med ordreinfo som bilag.

For å teste én ordre:

```
FIKEN_API_TOKEN=... FIKEN_COMPANY_SLUG=... npm run migrate-external-sales -- --limit 1 --dry-run
```

## Generer enkelt-salg

```
FIKEN_API_TOKEN=... FIKEN_COMPANY_SLUG=... npm run external-sale
```

Miljøvariabler `EXTERNAL_SALE_*` kan brukes for å overstyre beløp, gebyr, ordrefil osv.

## Filstruktur

```
├── package.json / package-lock.json
├── README.md
├── src/
│   └── fiken.js                 # Lettvekts Fiken-klient (salgsbetaling, vedlegg, mm.)
└── scripts/
    ├── create_external_sale.js  # Lager ett enkelt «Nytt salg»
    └── migrate_shopify_to_fiken_external_sales.js  # Hovedimporten fra Shopify-backup
```
