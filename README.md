# Used Car Dealer Client Site

This repo contains the customer-facing dealer website, the `/admin` page, and the unpacked Chrome extension used to sync Facebook Marketplace listings.

The backend/database is not included here. The site and extension are already configured in code to use the service API:

```txt
https://marketplace-system-lf78.onrender.com
```

Current dealer slug:

```txt
neighborhood-used-cars
```

## Run Locally

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite.

Admin page:

```txt
/admin
```

Use the dealer key provided for this dealership.

## Host On Vercel

1. Push this repo to GitHub.
2. Import the repo into Vercel.
3. Deploy with the default build settings.

No backend secrets or database URL are needed in Vercel. The frontend reads inventory through the service API.

Optional Vercel environment variables, only if you want to override the code defaults:

```txt
VITE_PUBLIC_INVENTORY_API=https://marketplace-system-lf78.onrender.com
VITE_DEALER_SLUG=neighborhood-used-cars
```

## Load The Chrome Extension

The extension folder is:

```txt
marketplace-scraper
```

To load it:

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on Developer mode.
4. Click Load unpacked.
5. Select the `marketplace-scraper` folder.

The extension is already configured in code for this dealer and service API. Normal users should not need to change the advanced connection settings.

The extension auto scan runs every 30 minutes while Chrome is open.

## What Customers Can Change

- Website text/design in `src`.
- Inventory/order/manual edits in `/admin`.
- Facebook sync from the Chrome extension.

## What Is Not Included

- Backend source code.
- Database URL.
- Cloudinary secrets.
- Service admin secrets.
