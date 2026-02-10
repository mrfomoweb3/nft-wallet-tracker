# NFT Wallet Tracker & Copy-Buy Bot 🚀

A production-grade, multi-user Telegram bot for tracking NFT wallet activity, portfolio values, and automated copy-buying.

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2CA5E0?style=for-the-badge&logo=docker&logoColor=white)

## ✨ Features

- **Multi-User Support**: Individual accounts, settings, and wallet lists for every user.
- **Subscription Tiers**: Free and Premium tiers with different limits and feature sets.
- **Real-time Tracking**: Monitor Ethereum wallets for Mints, Buys, Sells, and Transfers.
- **Price Alerts** (Premium): Get notified when collection floor prices hit your target.
- **Snipe Mode** (Premium): Auto-buy listings below a specific price.
- **Portfolio Tracking** (Premium): View estimated value of NFT holdings.
- **Whale Alerts**: Global alerts for high-value transactions (>1 ETH).
- **Gas Tracker**: Real-time ETH gas prices.
- **Copy-Trading**: Auto-buy NFTs when a tracked wallet buys (optional).
- **Security**: AES-256-GCM encryption for keys, Kill Switch, and Spending Limits.

## 🤖 Telegram Commands

| Command | Tier | Description |
|---------|------|-------------|
| `/start` | All | Register and see welcome message |
| `/help` | All | View all available commands |
| `/tier` | All | Check your current subscription status |
| `/track <address>` | All | Track a wallet (e.g., `/track 0x123...`) |
| `/untrack <address>` | All | Stop tracking a wallet |
| `/wallets` | All | List your tracked wallets |
| `/autobuy` | All | Toggle auto-buy functionality on/off |
| `/status` | All | View bot status and system stats |
| `/gas` | All | View current gas prices |
| `/stats <slug>` | All | Get collection stats (e.g., `/stats bayc`) |
| `/history` | All | View recent transaction history |
| `/killswitch` | All | Emergency stop for all trading |
| `/portfolio` | **Premium** | View your NFT portfolio value |
| `/alert <slug> <%>` | **Premium** | Set floor price alert (e.g., `/alert bayc -5`) |
| `/snipe <slug> <eth>`| **Premium** | Set auto-buy target (e.g., `/snipe bayc 10.5`) |

## 🚀 Deployment

### Railway (Recommended)

This project is optimized for [Railway](https://railway.app).

1. **Install CLI**: `npm install -g @railway/cli`
2. **Login**: `railway login`
3. **Init**: `railway init`
4. **Deploy**: `railway up`

**Required Environment Variables:**

| Variable | Description |
|----------|-------------|
| `ETH_RPC_URL` | HTTP provider URL (Alchemy/Infura) |
| `ETH_WS_URL` | WebSocket provider URL (Alchemy/Infura) |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Admin Chat ID |
| `WALLET_ENCRYPTION_PASSWORD` | Min 16 chars (for securing keys) |

### Local Development

1. **Clone & Install**:
   ```bash
   git clone <repo-url>
   cd nft-wallet-tracker
   npm install
   ```

2. **Configure**:
   ```bash
   cp .env.example .env
   # Edit .env with your keys
   ```

3. **Run**:
   ```bash
   npm run dev
   ```

## 🛠 Architecture

- **Core**: Node.js + TypeScript
- **Database**: Local JSON storage (no external DB required for basic setup)
- **Blockchain**: `ethers.js` v6 + `viem`
- **APIs**: Alchemy (Portfolio), Reservoir (Prices), OpenSea (Stats)
- **Security**: Node.js `crypto` module (scrypt + AES-256-GCM)

## 📄 License

MIT
