# Backend Setup

## 1. Install

```bash
npm install
```

## 2. Configure Sui local mode

```bash
cp .env.example .env
```

Set `SUI_KEYSTORE_PATH` to your local Sui config directory and confirm that
`SUI_ACTIVE_ADDRESS` is the testnet account you want the local harness to use.

## 3. Verify Sui config

```bash
sui client active-env
sui client active-address
curl http://localhost:13101/api/sui/status
```

## 4. Run

```bash
npm run dev
```

The API starts on `http://localhost:13101`. The monitor starts on
`http://localhost:13102`.
