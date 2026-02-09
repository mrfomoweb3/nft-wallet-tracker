# NFT Wallet Tracker & Copy-Buy Bot

A production-grade bot for tracking NFT wallet activity and automated copy-buying with Telegram notifications.

## Features

- 🔍 **Real-time Wallet Tracking** - Monitor any Ethereum wallet for NFT activity
- 🆕 **Mint Detection** - Instant alerts when tracked wallets mint NFTs
- 💰 **Buy/Sell Detection** - Track purchases and sales on major marketplaces
- 📱 **Telegram Notifications** - Rich formatted alerts with transaction links
- 🤖 **Copy-Buy Automation** - Optionally auto-buy NFTs when tracked wallets do
- 🔒 **Security First** - Encrypted wallet storage, kill switch, spending limits

## Quick Start

### 1. Prerequisites

- Node.js 20+
- Redis (for job queue)
- Ethereum RPC endpoint (Alchemy, Infura, etc.)
- Telegram Bot Token (from @BotFather)

### 2. Installation

```bash
cd "NFT Kitchen"
npm install
```

### 3. Configuration

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Required
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ETH_WS_URL=wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
WALLET_ENCRYPTION_PASSWORD=your_strong_password_32chars

# Optional - Wallets to track (comma-separated)
TRACKED_WALLETS=0x123...,0x456...
```

### 4. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/status` | Bot status and statistics |
| `/track 0x...` | Add wallet to track |
| `/untrack 0x...` | Remove wallet from tracking |
| `/wallets` | List tracked wallets |
| `/killswitch` | Emergency trading stop |
| `/settings` | View current settings |

## Architecture

```
src/
├── index.ts              # Main entry point
├── config/               # Configuration & validation
├── wallet/               # Encrypted wallet storage
├── blockchain/           # WebSocket listeners
├── events/               # Event processing & filtering
├── notifications/        # Telegram bot
├── trading/              # Copy-buy execution
├── safety/               # Kill switch, limits, logging
└── utils/                # Logger, retry utilities
```

## Safety Features

- ✅ **Read-only mode** (default) - Notifications only, no trading
- ✅ **Kill switch** - Instantly stop all trading
- ✅ **Spending caps** - Per-transaction and daily limits
- ✅ **Slippage protection** - Max price deviation allowed
- ✅ **Encrypted keys** - AES-256-GCM with Argon2id
- ✅ **Full audit log** - All transactions recorded

## Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| `TRADING_ENABLED` | `false` | Enable copy-buy trading |
| `READ_ONLY_MODE` | `true` | Notifications only |
| `MAX_SPEND_PER_TX` | `0.5` | Max ETH per transaction |
| `MAX_DAILY_SPEND` | `2.0` | Max ETH per day |
| `SLIPPAGE_TOLERANCE` | `0.05` | 5% max slippage |

## License

MIT
