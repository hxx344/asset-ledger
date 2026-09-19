# 资产统计

个人资产面板，支持 Excel 历史导入、Virtual 实时报价、Bybit / Aster 只读同步和手动估值。使用 Next.js、Node.js 24 和 SQLite，无需 Sites、Cloudflare 或外部数据库账号。公开仓库仅含虚构示例数据，不含真实资产记录和凭据。

## 一键部署

支持 Ubuntu 22.04 / 24.04、Debian 12 / 13，amd64 / arm64，需 systemd。建议至少 2 核、4 GB 内存和 3 GB 可用磁盘，供服务器构建使用。

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash
```

自动安装依赖和 Node.js、校验下载、拉取代码、构建、生成登录密码、初始化 SQLite 并注册开机自启服务。首次安装仅监听服务器本机 `127.0.0.1:5678`，通过 SSH 隧道访问，使用终端显示的独立登录密码进入账本。服务器只需允许现有 SSH 连接，无需对公网开放 5678；脚本不修改 SSH 服务或防火墙规则。

已部署的服务切换为 SSH 隧道访问、端口 5678（在服务器执行，保留数据、密码和加密配置）：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash -s -- --local --port 5678
```

然后在**自己的电脑**上打开 PowerShell 或终端，替换用户名和服务器 IP 后执行：

```bash
ssh -N -L 127.0.0.1:5678:127.0.0.1:5678 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 用户名@服务器IP
```

保持这个 SSH 窗口运行，在本机浏览器打开 `http://127.0.0.1:5678`。输入 SSH 密码时终端不会显示字符；密钥登录沿用你已有的 SSH 配置。页面仍使用安装时生成的账本登录密码。电脑与服务器之间的数据通过 SSH 加密传输，关闭隧道后本机地址不再可用。

SSH 不是默认 22 端口时，在命令中加 `-p SSH端口`；指定密钥可加 `-i 密钥文件路径`。若本机 5678 已被占用，将 `-L` 改为 `127.0.0.1:5679:127.0.0.1:5678`，浏览器改访问 `http://127.0.0.1:5679`。

自定义端口：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash -s -- --port 8080
```

**升级再次执行同一条命令。** 未指定端口和 `--local` 时保留原端口及监听地址，所以旧版公网监听需要显式加 `--local` 切换；保留密码、加密密钥、资产和历史。先构建新版本，再停止旧服务并备份数据库；启动检查失败时恢复旧版本、端口和数据库。备份保留在 `/opt/asset-ledger/backups/`，不会自动删除。

首次安装可导入已上传到服务器的原表：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash -s -- --data-file /root/资产统计.xlsx
```

也支持导入脚本生成的 `.json`。已有数据库时拒绝覆盖导入；首次未提供文件时使用示例数据。原表仍在本地电脑的用户，需要先将文件传到服务器。

| 项目 | 位置 / 命令 |
| --- | --- |
| 服务状态 | `sudo systemctl status asset-ledger` |
| 查看日志 | `sudo journalctl -u asset-ledger -n 100` |
| 重启 / 停止 | `sudo systemctl restart asset-ledger` / `sudo systemctl stop asset-ledger` |
| 数据、历史与加密凭据 | `/var/lib/asset-ledger/ledger.sqlite` |
| 登录和加密配置 | `/var/lib/asset-ledger/config.json` |
| 当前版本 | `/opt/asset-ledger/current` |
| 端口设置 | `/opt/asset-ledger/deploy.env`，推荐通过 `--port` 修改 |

忘记密码时重置（保留交易所加密密钥，旧会话失效）：

```bash
sudo -u asset-ledger env ASSET_DATA_DIR=/var/lib/asset-ledger /opt/asset-ledger/runtime/node-v24.15.0-linux-$( [ "$(uname -m)" = x86_64 ] && echo x64 || echo arm64 )/bin/node /opt/asset-ledger/current/scripts/configure.mjs --reset-password
```

若曾通过 systemd override 设置过 `PUBLIC_ORIGIN`，切换 SSH 隧道时应移除该设置并重启服务，恢复按本机访问地址校验来源。升级会保留已有 override。

## 数据口径

- Virtual：优先使用 CoinGecko 美元报价，失败时改用 Coinbase 美元兑换率倒数；分别标明行情时间或获取时间。数量手动维护。
- Bybit：只读 HMAC API，验证 `readOnly = 1` 后读取统一账户 `totalEquity` 和资金账户余额。包含未实现盈亏，不重复累加保证金或持仓名义价值；不含子账户及 Earn。
- Aster：已有只读 HMAC API Key / Secret（V1），读取合约 `marginBalance`，可选现货 `free + locked`。不含质押；密钥权限须在 Aster 设为只读，程序仅调用余额查询 GET 路由。
- 其他资产与汇率保留原值，支持手动编辑；不把项目名误当作同名代币，积分和 NFT 保留预估口径。
- 页面打开且前台在线时每 60 秒刷新，每天保存最近一次刷新或编辑。页面关闭时没有后台定时任务。
- 接口失败保留旧值及原时间，不用零覆盖失败结果。资产变化含资金进出，不能视为投资收益。未来预填记录不参与历史曲线。

API Secret 使用 AES-GCM 加密，登录密码采用加盐 scrypt。会话 Cookie 为 HttpOnly，接口验证登录和写入来源。数据库、配置、Excel 和导入数据均被 Git 忽略。备份或迁移应同时保留数据库及 `config.json`，否则无法解密旧连接。

## 本地开发与验证

Node.js 24.15+：

```bash
npm ci
npm run dev
```

开发地址 `http://127.0.0.1:5173`，首次启动显示随机密码；配置和数据库在 `.data/`。安装依赖只在缺少导入文件时复制示例，不覆盖已有个人数据。

原表导入需 Python 和 `openpyxl`，在首次打开账本前执行：

```bash
python scripts/import-workbook.py "资产统计.xlsx" 2026-09-19
```

日期参数是统计起始日，可选第三个参数指定 JSON 输出路径。初始化后原始快照也保存在 SQLite，替换导入文件不覆盖已有账本。

```bash
npm test
npm run build
npm run test:smoke
```

测试覆盖估值、签名、只读路由、行情时效、登录、迁移、事务回滚和重启保留数据。生产启动测试使用临时示例数据库，不访问真实交易所。Linux 持续集成还会验证首次安装仅监听本机、升级切换为本机监听和失败回滚。

Schema 位于 `db/schema.ts`，`npm run db:generate` 生成增量迁移。迁移执行一次并校验文件哈希，请勿修改已执行的 SQL。

## 官方资料

- [Next.js 独立部署](https://nextjs.org/docs/app/guides/self-hosting)、[Node.js SQLite](https://nodejs.org/api/sqlite.html)
- [Bybit 钱包余额](https://bybit-exchange.github.io/docs/v5/account/wallet-balance)、[只读权限](https://bybit-exchange.github.io/docs/v5/user/apikey-info)、[资金账户](https://bybit-exchange.github.io/docs/v5/asset/balance/all-balance)
- [Aster 合约 API](https://github.com/asterdex/api-docs/blob/master/V1%28Legacy%29/EN/aster-finance-futures-api.md)、[现货 API](https://github.com/asterdex/api-docs/blob/master/V1%28Legacy%29/EN/aster-finance-spot-api.md)
- [CoinGecko](https://docs.coingecko.com/reference/simple-price)、[Coinbase](https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates)

真实 Bybit / Aster 账户需在页面填写只读凭据后验证，测试使用合成数据。
